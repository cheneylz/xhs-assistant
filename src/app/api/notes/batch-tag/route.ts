import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { formatDateTime } from "@/lib/server/core/time";
import type { Note } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

/** 批量打标签请求体（对应原版 BatchTagNotesRequest） */
const BatchTagNotesSchema = z.object({
  note_ids: z.array(z.number().int()).min(1),
  tag_ids: z.array(z.number().int()).default([]),
  mode: z.enum(["replace", "add", "remove"]).default("replace"),
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

/** 获取当前用户拥有的笔记（对应原版 _get_owned_note） */
async function getOwnedNote(userId: number, noteId: number) {
  const note = await prisma.note.findUnique({ where: { id: noteId } });
  if (!note || note.userId !== userId) throw notFound("Note not found");
  return note;
}

/** POST /api/notes/batch-tag 批量打标签（replace / add / remove，对应原版 batch_tag_notes） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, BatchTagNotesSchema);

  // 去重并校验笔记归属（对应原版 _get_owned_note 循环）
  const noteIds = [...new Set(payload.note_ids)];
  const notes: Note[] = [];
  for (const noteId of noteIds) {
    notes.push(await getOwnedNote(user.id, noteId));
  }

  // 校验标签均归属当前用户（对应原版）
  const tagIds = [...new Set(payload.tag_ids)];
  for (const tagId of tagIds) {
    const tag = await prisma.tag.findUnique({ where: { id: tagId } });
    if (!tag || tag.userId !== user.id) throw notFound("Tag not found");
  }

  for (const note of notes) {
    if (payload.mode === "replace") {
      // replace：清空后全量重建关联（对应原版）
      await prisma.noteTags.deleteMany({ where: { noteId: note.id } });
      if (tagIds.length) {
        await prisma.noteTags.createMany({ data: tagIds.map((tagId) => ({ noteId: note.id, tagId })) });
      }
      continue;
    }
    if (payload.mode === "add") {
      // add：仅补充不存在的关联（对应原版）
      const existing = await prisma.noteTags.findMany({ where: { noteId: note.id }, select: { tagId: true } });
      const existingIds = new Set(existing.map((link) => link.tagId));
      const toAdd = tagIds.filter((tagId) => !existingIds.has(tagId));
      if (toAdd.length) {
        await prisma.noteTags.createMany({ data: toAdd.map((tagId) => ({ noteId: note.id, tagId })) });
      }
      continue;
    }
    // remove：仅移除指定标签的关联（对应原版 in_ 删除）
    if (tagIds.length) {
      await prisma.noteTags.deleteMany({ where: { noteId: note.id, tagId: { in: tagIds } } });
    }
  }

  const items: Array<Record<string, unknown>> = [];
  for (const note of notes) items.push(await serializeNoteWithTags(note));
  return NextResponse.json({ updated_count: notes.length, items });
});
