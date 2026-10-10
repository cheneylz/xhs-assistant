/**
 * 内容库（笔记）查询服务
 *
 * 从 api/notes 的六条路由里抽出（P1 设计稿 §6.4）：路由与 Agent 的 library_* 工具
 * 共用同一份查询与序列化实现，而不是两处各写一遍筛选逻辑（与 P0 抽取 skill-catalog 同一模式）。
 *
 * 【本文件不含 http-error / next 依赖】—— 服务层只表达「查不到」（返回 null / outcome 联合），
 * 状态码由路由层决定（与 agent-service.ts 文件头的同一约定）。
 */
import type { Note, NoteAsset, NoteComment } from "@prisma/client";
import { prisma } from "../core/db";
import { formatDateTime } from "../core/time";

/** 序列化标签（对应原版 _serialize_tag） */
export function serializeTag(tag: { id: number; name: string; color: string }) {
  return { id: tag.id, name: tag.name, color: tag.color };
}

/** 素材展示 URL：本地素材走 /api/files/media 静态服务（对应原版 _asset_display_url） */
export function assetDisplayUrl(asset: { localPath: string; url: string }): string {
  return asset.localPath ? `/api/files/media/${asset.localPath}` : asset.url;
}

/**
 * 笔记行 + 素材行 → 协议对象（对应原版 _serialize_note）。
 * 纯函数：不碰数据库，单测直接构造行对象即可覆盖全部边界（封面兜底 / 视频 / raw_json 形状）。
 */
export function projectNote(note: Note, assets: NoteAsset[]): Record<string, unknown> {
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

/** 评论行 → 协议对象（对应原版 _serialize_comment） */
export function projectComment(comment: NoteComment): Record<string, unknown> {
  return {
    id: comment.id,
    note_id: comment.noteId,
    comment_id: comment.commentId,
    user_name: comment.userName,
    user_id: comment.userId,
    content: comment.content,
    like_count: comment.likeCount,
    parent_comment_id: comment.parentCommentId,
    created_at_remote: comment.createdAtRemote,
    raw_json: comment.rawJson,
  };
}

/** 查询笔记的标签（对应原版 _get_note_tags，按 tag.id 升序） */
export async function getNoteTags(noteId: number) {
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

/** 序列化笔记（含素材/封面/视频，对应原版 _serialize_note） */
export async function serializeNote(note: Note): Promise<Record<string, unknown>> {
  return projectNote(note, await getNoteAssets(note.id));
}

/** 序列化笔记（含标签，对应原版 _serialize_note_with_tags） */
export async function serializeNoteWithTags(note: Note): Promise<Record<string, unknown>> {
  return { ...(await serializeNote(note)), tags: await getNoteTags(note.id) };
}

/** 查当前用户拥有的笔记行；查不到（不存在或不属于该用户）返回 null，由调用方决定状态码 */
export async function findOwnedNote(userId: number, noteId: number): Promise<Note | null> {
  const note = await prisma.note.findUnique({ where: { id: noteId } });
  return note && note.userId === userId ? note : null;
}

/** 列表筛选条件（路由从 URLSearchParams、Agent 工具从模型参数分别映射而来） */
export interface NoteSearchFilter {
  platform?: string;
  keyword?: string;
  tagId?: number;
  hasAssets?: boolean;
  hasComments?: boolean;
}

/** 列表查询结果：tag_not_found 交给调用方映射状态码（服务层不 import http-error） */
export type NoteSearchResult =
  | { outcome: "ok"; items: Array<Record<string, unknown>> }
  | { outcome: "tag_not_found" };

/**
 * 按条件检索笔记（对应原版 get_notes 的过滤链）。
 * 分页由调用方做：路由用 paginated()，工具用 slice —— 因此这里返回全部命中项。
 */
export async function searchNotes(userId: number, filter: NoteSearchFilter): Promise<NoteSearchResult> {
  const keyword = filter.keyword?.trim() ?? "";
  const notes = await prisma.note.findMany({
    where: {
      userId,
      ...(filter.platform ? { platform: filter.platform } : {}),
      ...(keyword
        ? {
            OR: [
              { title: { contains: keyword } },
              { content: { contains: keyword } },
              { authorName: { contains: keyword } },
              { noteId: { contains: keyword } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  // tag_id 过滤：标签须归属当前用户，否则 tag_not_found（对应原版 404 语义）
  let filtered = notes;
  if (filter.tagId !== undefined) {
    const tag = await prisma.tag.findUnique({ where: { id: filter.tagId } });
    if (!tag || tag.userId !== userId) return { outcome: "tag_not_found" };
    const links = await prisma.noteTags.findMany({ where: { tagId: filter.tagId }, select: { noteId: true } });
    const noteIds = new Set(links.map((link) => link.noteId));
    filtered = filtered.filter((note) => noteIds.has(note.id));
  }
  // has_assets / has_comments 过滤（对应原版 in_ / not_in 子查询）
  if (filter.hasAssets !== undefined) {
    const noteIds = new Set((await prisma.noteAsset.findMany({ select: { noteId: true } })).map((asset) => asset.noteId));
    filtered = filtered.filter((note) => (filter.hasAssets ? noteIds.has(note.id) : !noteIds.has(note.id)));
  }
  if (filter.hasComments !== undefined) {
    const noteIds = new Set(
      (await prisma.noteComment.findMany({ select: { noteId: true } })).map((comment) => comment.noteId),
    );
    filtered = filtered.filter((note) => (filter.hasComments ? noteIds.has(note.id) : !noteIds.has(note.id)));
  }

  const items: Array<Record<string, unknown>> = [];
  for (const note of filtered) items.push(await serializeNoteWithTags(note));
  return { outcome: "ok", items };
}

/** 笔记详情（含标签）；不存在或不属于当前用户返回 null */
export async function getNoteDetail(userId: number, noteId: number): Promise<Record<string, unknown> | null> {
  const note = await findOwnedNote(userId, noteId);
  if (!note) return null;
  return serializeNoteWithTags(note);
}

/** 评论查询结果：not_found 交给调用方映射状态码 */
export type NoteCommentsResult =
  | { outcome: "ok"; items: Array<Record<string, unknown>> }
  | { outcome: "not_found" };

/** 笔记的评论列表（按 id 升序）；笔记不存在/不属于该用户返回 not_found。分页由调用方做 */
export async function listNoteComments(userId: number, noteId: number): Promise<NoteCommentsResult> {
  const note = await findOwnedNote(userId, noteId);
  if (!note) return { outcome: "not_found" };
  const comments = await prisma.noteComment.findMany({ where: { noteId: note.id }, orderBy: { id: "asc" } });
  return { outcome: "ok", items: comments.map(projectComment) };
}
