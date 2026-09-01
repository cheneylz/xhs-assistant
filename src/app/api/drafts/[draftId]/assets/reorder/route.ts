import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { z } from "zod";

/** 草稿素材排序请求体（对应原版 DraftAssetReorderRequest） */
const DraftAssetReorderSchema = z.object({
  asset_ids: z.array(z.number().int()).min(1),
});

/** 获取当前用户拥有的草稿（对应原版） */
async function getOwnedDraft(userId: number, draftId: number) {
  const draft = await prisma.aiDraft.findUnique({ where: { id: draftId } });
  if (!draft || draft.userId !== userId) throw notFound("Draft not found");
  return draft;
}

/** PUT /api/drafts/{draftId}/assets/reorder 草稿素材排序（对应原版 reorder_draft_assets） */
export const PUT = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const draftId = Number.parseInt(params.draftId, 10);
  const draft = await getOwnedDraft(user.id, draftId);
  const payload = await readJson(req, DraftAssetReorderSchema);
  const assets = await prisma.draftAsset.findMany({ where: { draftId: draft.id } });
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  // 按提交顺序写入 sort_order（仅更新存在的素材，对应原版）
  let index = 0;
  for (const assetId of payload.asset_ids) {
    const asset = assetMap.get(assetId);
    if (asset) {
      await prisma.draftAsset.update({ where: { id: asset.id }, data: { sortOrder: index } });
    }
    index++;
  }
  return NextResponse.json({ ok: true });
});
