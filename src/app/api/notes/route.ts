import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { paginated } from "@/lib/server/core/paginate";
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

/** 解析并校验分页参数（page>=1、page_size 1..max，对应原版 Query 校验） */
function parsePageParams(searchParams: URLSearchParams, defaultPageSize = 20, maxPageSize = 100) {
  const page = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(searchParams.get("page_size") ?? String(defaultPageSize), 10);
  if (Number.isNaN(page) || page < 1) throw new ApiError(422, "page must be >= 1");
  if (Number.isNaN(pageSize) || pageSize < 1 || pageSize > maxPageSize) {
    throw new ApiError(422, `page_size must be between 1 and ${maxPageSize}`);
  }
  return { page, pageSize };
}

/** 解析可选布尔查询参数（对应原版 Optional[bool] 校验） */
function parseOptionalBool(searchParams: URLSearchParams, key: string): boolean | undefined {
  const raw = searchParams.get(key);
  if (raw === null) return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new ApiError(422, `${key} must be a boolean`);
}

/** GET /api/notes 笔记列表（分页 + 多条件过滤，对应原版 get_notes） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const { page, pageSize } = parsePageParams(searchParams);
  const platform = searchParams.get("platform") ?? undefined;
  const q = searchParams.get("q") ?? undefined;
  const tagIdRaw = searchParams.get("tag_id");
  const hasAssets = parseOptionalBool(searchParams, "has_assets");
  const hasComments = parseOptionalBool(searchParams, "has_comments");

  // 基础过滤：userId + 可选平台 + 关键词模糊搜索（对应原版 or_ + ilike）
  const keyword = q ? q.trim() : "";
  const notes = await prisma.note.findMany({
    where: {
      userId: user.id,
      ...(platform ? { platform } : {}),
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

  // tag_id 过滤：标签须归属当前用户，否则 404（对应原版）
  let filtered = notes;
  if (tagIdRaw !== null) {
    const tagId = Number.parseInt(tagIdRaw, 10);
    if (Number.isNaN(tagId)) throw new ApiError(422, "tag_id must be an integer");
    const tag = await prisma.tag.findUnique({ where: { id: tagId } });
    if (!tag || tag.userId !== user.id) throw notFound("Tag not found");
    const links = await prisma.noteTags.findMany({ where: { tagId }, select: { noteId: true } });
    const noteIds = new Set(links.map((link) => link.noteId));
    filtered = filtered.filter((note) => noteIds.has(note.id));
  }
  // has_assets / has_comments 过滤（对应原版 in_ / not_in 子查询）
  if (hasAssets !== undefined) {
    const noteIds = new Set((await prisma.noteAsset.findMany({ select: { noteId: true } })).map((asset) => asset.noteId));
    filtered = filtered.filter((note) => (hasAssets ? noteIds.has(note.id) : !noteIds.has(note.id)));
  }
  if (hasComments !== undefined) {
    const noteIds = new Set((await prisma.noteComment.findMany({ select: { noteId: true } })).map((comment) => comment.noteId));
    filtered = filtered.filter((note) => (hasComments ? noteIds.has(note.id) : !noteIds.has(note.id)));
  }

  const items: Array<Record<string, unknown>> = [];
  for (const note of filtered) items.push(await serializeNoteWithTags(note));
  return NextResponse.json(paginated(items, page, pageSize));
});
