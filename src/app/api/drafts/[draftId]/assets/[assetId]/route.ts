import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import type { DraftAsset } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

/** 更新草稿素材请求体（对应原版 DraftAssetUpdateRequest） */
const DraftAssetUpdateSchema = z.object({
  url: z.string().max(2048).nullable().optional(),
  local_path: z.string().max(512).nullable().optional(),
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

/** 获取草稿下的素材（对应原版 select where id + draft_id） */
async function getOwnedDraftAsset(draftId: number, assetId: number) {
  const asset = await prisma.draftAsset.findFirst({ where: { id: assetId, draftId } });
  if (!asset) throw notFound("Asset not found");
  return asset;
}

/** DELETE /api/drafts/{draftId}/assets/{assetId} 删除草稿素材（对应原版 delete_draft_asset） */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const draftId = Number.parseInt(params.draftId, 10);
  const assetId = Number.parseInt(params.assetId, 10);
  const draft = await getOwnedDraft(user.id, draftId);
  const asset = await getOwnedDraftAsset(draft.id, assetId);
  await prisma.draftAsset.delete({ where: { id: asset.id } });
  return NextResponse.json({ id: assetId, status: "deleted" });
});

/** PATCH /api/drafts/{draftId}/assets/{assetId} 更新草稿素材（对应原版 update_draft_asset） */
export const PATCH = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const draftId = Number.parseInt(params.draftId, 10);
  const assetId = Number.parseInt(params.assetId, 10);
  const draft = await getOwnedDraft(user.id, draftId);
  const asset = await getOwnedDraftAsset(draft.id, assetId);
  const payload = await readJson(req, DraftAssetUpdateSchema);
  const updated = await prisma.draftAsset.update({
    where: { id: asset.id },
    data: {
      ...(payload.url !== null && payload.url !== undefined ? { url: payload.url } : {}),
      ...(payload.local_path !== null && payload.local_path !== undefined ? { localPath: payload.local_path } : {}),
    },
  });
  return NextResponse.json(serializeDraftAsset(updated));
});
