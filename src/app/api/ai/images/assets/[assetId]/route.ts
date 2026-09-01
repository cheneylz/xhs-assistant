import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";

/** DELETE /api/ai/images/assets/{assetId} 删除生成资产（对应原版 delete_generated_image_asset） */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const assetId = Number.parseInt(params.assetId, 10);
  const asset = await prisma.aiGeneratedAsset.findUnique({ where: { id: assetId } });
  if (!asset || asset.userId !== user.id) {
    throw notFound("Asset not found");
  }
  await prisma.aiGeneratedAsset.delete({ where: { id: assetId } });
  return NextResponse.json({ id: assetId, status: "deleted" });
});
