import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { formatDateTime, shanghaiNow } from "@/lib/server/core/time";
import { downloadAssetToLocal } from "@/lib/server/services/asset-downloader";
import type { Note, Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

/** 批量保存单条笔记项（对应原版 BatchSaveNoteItem） */
const BatchSaveNoteItemSchema = z.object({
  note_id: z.string().min(1).max(128),
  note_url: z.string().default(""),
  title: z.string().default(""),
  content: z.string().default(""),
  author_name: z.string().default(""),
  cover_url: z.string().default(""),
  video_url: z.string().default(""),
  video_addr: z.string().default(""),
  image_urls: z.array(z.string()).default([]),
  raw: z.record(z.string(), z.unknown()).default({}),
});

/** 批量保存笔记请求体（对应原版 BatchSaveNotesRequest） */
const BatchSaveNotesSchema = z.object({
  account_id: z.number().int(),
  fetch_comments: z.boolean().default(false),
  notes: z.array(BatchSaveNoteItemSchema).min(1),
});

/** 序列化标签（对应原版 _serialize_tag） */
function serializeTag(tag: { id: number; name: string; color: string }) {
  return { id: tag.id, name: tag.name, color: tag.color };
}

/** 查询笔记的标签（对应原版 _get_note_tags，按 tag.id 升序） */
async function getNoteTags(noteId: number) {
  const links = await prisma.noteTags.findMany({
    where: { noteId },
    include: { tag: true },
    orderBy: { tagId: "asc" },
  });
  return links.map((link) => serializeTag(link.tag));
}

/** 查询笔记素材（对应原版 _get_note_assets，按 sort_order、id 升序） */
function getNoteAssets(noteId: number) {
  return prisma.noteAsset.findMany({
    where: { noteId },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
}

/** 素材展示 URL：本地素材走 /api/files/media 静态服务（对应原版 _asset_display_url） */
function assetDisplayUrl(asset: { localPath: string; url: string }): string {
  return asset.localPath ? `/api/files/media/${asset.localPath}` : asset.url;
}

/** 序列化笔记（对应原版 _serialize_note） */
async function serializeNote(note: Note) {
  const assets = await getNoteAssets(note.id);
  const imageAssets = assets.filter((asset) => asset.assetType === "image");
  const videoAssets = assets.filter((asset) => asset.assetType === "video");
  const assetUrls = assets.filter((asset) => asset.url || asset.localPath).map(assetDisplayUrl);
  const raw = note.rawJson && typeof note.rawJson === "object" && !Array.isArray(note.rawJson)
    ? (note.rawJson as Record<string, unknown>)
    : {};
  const rawCover = typeof raw.cover_url === "string" ? raw.cover_url : "";
  return {
    id: note.id,
    platform: note.platform,
    platform_account_id: note.platformAccountId,
    note_id: note.noteId,
    title: note.title,
    content: note.content,
    author_name: note.authorName,
    raw_json: note.rawJson,
    asset_urls: assetUrls,
    cover_url: imageAssets.length ? assetDisplayUrl(imageAssets[0]) : rawCover,
    video_url: videoAssets.length ? assetDisplayUrl(videoAssets[0]) : "",
    video_addr: videoAssets.length ? assetDisplayUrl(videoAssets[0]) : "",
    created_at: formatDateTime(note.createdAt),
  };
}

/** 序列化笔记（含标签，对应原版 _serialize_note_with_tags） */
async function serializeNoteWithTags(note: Note) {
  return { ...(await serializeNote(note)), tags: await getNoteTags(note.id) };
}

/** 获取当前用户拥有的 XHS 平台账号（对应原版 _get_owned_account） */
async function getOwnedAccount(userId: number, accountId: number) {
  const account = await prisma.platformAccount.findUnique({ where: { id: accountId } });
  if (!account || account.userId !== userId || account.platform !== "xhs") {
    throw notFound("Account not found");
  }
  return account;
}

/** POST /api/notes/batch-save 批量保存笔记（可选抓取评论，对应原版 batch_save_notes） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, BatchSaveNotesSchema);
  const account = await getOwnedAccount(user.id, payload.account_id);

  if (payload.fetch_comments) {
    // 校验：仅 PC 子类型账号支持抓取评论（对应原版）
    if (account.subType !== "pc") {
      throw new ApiError(400, "PC account is required to fetch comments");
    }
    // TODO: 原版此处通过 get_xhs_pc_api_adapter_factory(最新 Cookie) 构造适配器，
    // 调用 comment_adapter.get_note_comments(note_url) 抓取真实评论并入库。
    // 最新 Cookie 取 AccountCookieVersion 按 created_at 降序首条并 decryptText 解密。
    // SDK 层（src/lib/server/xhs/...）尚未提供 getNoteComments 接口，暂以 501 桩占位。
    throw new ApiError(501, "XHS note comments fetching is not implemented yet");
  }

  const savedNotes: Note[] = [];
  for (const item of payload.notes) {
    // 按 userId + note_id 查重，不存在则新建（对应原版）
    let note = await prisma.note.findFirst({ where: { userId: user.id, noteId: item.note_id } });
    if (!note) {
      note = await prisma.note.create({
        data: {
          userId: user.id,
          platformAccountId: account.id,
          platform: account.platform,
          noteId: item.note_id,
          createdAt: shanghaiNow(),
        },
      });
    }
    // 更新正文信息，raw_json 合并 note_url（对应原版）
    const mergedRaw: Record<string, unknown> = { ...(item.raw ?? {}) };
    if (item.note_url) mergedRaw["note_url"] = item.note_url;
    note = await prisma.note.update({
      where: { id: note.id },
      data: {
        title: item.title,
        content: item.content,
        authorName: item.author_name,
        rawJson: mergedRaw as Prisma.InputJsonValue,
      },
    });
    // 重建素材：先清空，再按图片/视频 URL 下载并入库（对应原版）
    await prisma.noteAsset.deleteMany({ where: { noteId: note.id } });
    const imageCandidates = item.image_urls.length ? item.image_urls : item.cover_url ? [item.cover_url] : [];
    const uniqueImageUrls = imageCandidates.filter((url, index) => url && !imageCandidates.slice(0, index).includes(url));
    for (const imageUrl of uniqueImageUrls) {
      const localName = await downloadAssetToLocal(imageUrl, user.id, "image");
      await prisma.noteAsset.create({
        data: { noteId: note.id, assetType: "image", url: imageUrl, localPath: localName ?? "", sortOrder: 0 },
      });
    }
    const videoUrl = item.video_url || item.video_addr;
    if (videoUrl) {
      const localName = await downloadAssetToLocal(videoUrl, user.id, "video");
      await prisma.noteAsset.create({
        data: { noteId: note.id, assetType: "video", url: videoUrl, localPath: localName ?? "", sortOrder: 0 },
      });
    }
    savedNotes.push(note);
  }

  const items: Array<Record<string, unknown>> = [];
  for (const note of savedNotes) items.push(await serializeNoteWithTags(note));
  return NextResponse.json({ saved_count: savedNotes.length, items });
});
