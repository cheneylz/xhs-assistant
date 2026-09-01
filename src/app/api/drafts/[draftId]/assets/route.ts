import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import type { DraftAsset } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

/** 添加草稿素材请求体（对应原版 DraftAssetCreateRequest） */
const DraftAssetCreateSchema = z.object({
  asset_type: z.enum(["image", "video"]),
  url: z.string().max(2048).default(""),
  local_path: z.string().max(512).default(""),
});

/** 序列化草稿素材（对应原版 _serialize_draft_asset，url 本地优先） */
function serializeDraftAsset(asset: DraftAsset) {
  const displayUrl = asset.localPath ? `/api/files/media/${asset.localPath}` : asset.url;
  return {
    id: asset.id,
    draft_id: asset.draftId,
    asset_type: asset.assetType,
    url: displayUrl,
    local_path: asset.localPath,
    sort_order: asset.sortOrder,
  };
}

/** 获取当前用户拥有的草稿（对应原版） */
async function getOwnedDraft(userId: number, draftId: number) {
  const draft = await prisma.aiDraft.findUnique({ where: { id: draftId } });
  if (!draft || draft.userId !== userId) throw notFound("Draft not found");
  return draft;
}

/** GET /api/drafts/{draftId}/assets 草稿素材列表（对应原版 get_draft_assets） */
export const GET = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const draftId = Number.parseInt(params.draftId, 10);
  const draft = await getOwnedDraft(user.id, draftId);
  const assets = await prisma.draftAsset.findMany({
    where: { draftId: draft.id },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
  return NextResponse.json({ items: assets.map(serializeDraftAsset) });
});

/** POST /api/drafts/{draftId}/assets 添加草稿素材（sort_order 取最大值 +1，对应原版 add_draft_asset） */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const draftId = Number.parseInt(params.draftId, 10);
  const draft = await getOwnedDraft(user.id, draftId);
  const payload = await readJson(req, DraftAssetCreateSchema);
  const aggregate = await prisma.draftAsset.aggregate({
    where: { draftId: draft.id },
    _max: { sortOrder: true },
  });
  const maxOrder = aggregate._max.sortOrder ?? 0;
  const asset = await prisma.draftAsset.create({
    data: {
      draftId: draft.id,
      assetType: payload.asset_type,
      url: payload.url,
      localPath: payload.local_path,
      sortOrder: maxOrder + 1,
    },
  });
  return NextResponse.json(serializeDraftAsset(asset));
});
