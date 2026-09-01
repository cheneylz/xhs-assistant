import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { formatDateTime } from "@/lib/server/core/time";
import type { Note } from "@prisma/client";
import { NextResponse } from "next/server";

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

/** GET /api/notes/{noteId} 笔记详情（含标签，对应原版 get_note） */
export const GET = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const noteId = Number.parseInt(params.noteId, 10);
  const note = await getOwnedNote(user.id, noteId);
  return NextResponse.json(await serializeNoteWithTags(note));
});

/** DELETE /api/notes/{noteId} 删除笔记（级联清理标签/素材/评论，对应原版 delete_note） */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const noteId = Number.parseInt(params.noteId, 10);
  const note = await getOwnedNote(user.id, noteId);
  await prisma.noteTags.deleteMany({ where: { noteId: note.id } });
  await prisma.noteAsset.deleteMany({ where: { noteId: note.id } });
  await prisma.noteComment.deleteMany({ where: { noteId: note.id } });
  // 解除相关草稿的 source_note_id 引用（对应原版 update 置空）
  await prisma.aiDraft.updateMany({ where: { sourceNoteId: note.id }, data: { sourceNoteId: null } });
  await prisma.note.delete({ where: { id: note.id } });
  return NextResponse.json({ id: noteId, status: "deleted" });
});
