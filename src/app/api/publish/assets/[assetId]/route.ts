import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";

/** DELETE /api/publish/assets/{assetId} 删除素材（对应原版 delete_publish_asset） */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const assetId = Number.parseInt(params.assetId, 10);
  const asset = await prisma.publishAsset.findFirst({
    where: { id: assetId, publishJob: { userId: user.id } },
  });
  if (!asset) throw notFound("Publish asset not found");
  await prisma.publishAsset.delete({ where: { id: asset.id } });
  return NextResponse.json({ id: assetId, status: "deleted" });
});
