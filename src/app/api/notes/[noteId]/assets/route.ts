import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { paginated } from "@/lib/server/core/paginate";
import { handle, readJson } from "@/lib/server/core/route";
import type { NoteAsset } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

/** 添加素材请求体（对应原版 AddNoteAssetRequest） */
const AddNoteAssetSchema = z.object({
  asset_type: z.enum(["image", "video"]),
  url: z.string().max(2048).default(""),
  local_path: z.string().max(512).default(""),
});

/** 素材展示 URL：本地素材走 /api/files/media 静态服务（对应原版 _asset_display_url） */
function assetDisplayUrl(asset: { localPath: string; url: string }): string {
  return asset.localPath ? `/api/files/media/${asset.localPath}` : asset.url;
}

/** 序列化素材（对应原版 _serialize_asset） */
function serializeAsset(asset: NoteAsset) {
  return {
    id: asset.id,
    note_id: asset.noteId,
    asset_type: asset.assetType,
    url: assetDisplayUrl(asset),
    local_path: asset.localPath,
    download_url: asset.localPath ? `/api/files/media/${asset.localPath}` : "",
    sort_order: asset.sortOrder,
  };
}

/** 获取当前用户拥有的笔记（对应原版 _get_owned_note） */
async function getOwnedNote(userId: number, noteId: number) {
  const note = await prisma.note.findUnique({ where: { id: noteId } });
  if (!note || note.userId !== userId) throw notFound("Note not found");
  return note;
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

/** GET /api/notes/{noteId}/assets 素材列表（分页，对应原版 get_note_assets） */
export const GET = handle(async (req, { params, searchParams }) => {
  const user = await getCurrentUser(req);
  const noteId = Number.parseInt(params.noteId, 10);
  const { page, pageSize } = parsePageParams(searchParams);
  const note = await getOwnedNote(user.id, noteId);
  const assets = await prisma.noteAsset.findMany({
    where: { noteId: note.id },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
  return NextResponse.json(paginated(assets.map(serializeAsset), page, pageSize));
});

/** POST /api/notes/{noteId}/assets 添加素材（对应原版 add_note_asset） */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const noteId = Number.parseInt(params.noteId, 10);
  const note = await getOwnedNote(user.id, noteId);
  const payload = await readJson(req, AddNoteAssetSchema);
  if (!payload.url && !payload.local_path) {
    throw new ApiError(400, "url or local_path is required");
  }
  const asset = await prisma.noteAsset.create({
    data: {
      noteId: note.id,
      assetType: payload.asset_type,
      url: payload.url,
      localPath: payload.local_path,
      sortOrder: 0,
    },
  });
  return NextResponse.json(serializeAsset(asset));
});
