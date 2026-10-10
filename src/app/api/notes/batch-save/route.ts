import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { shanghaiNow } from "@/lib/server/core/time";
import { downloadAssetToLocal } from "@/lib/server/services/asset-downloader";
import { serializeNoteWithTags } from "@/lib/server/services/note-service";
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
