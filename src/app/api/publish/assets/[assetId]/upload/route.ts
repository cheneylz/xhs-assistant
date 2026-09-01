import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { ApiError, badRequest, notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { decryptText } from "@/lib/server/core/security";
import { serializePublishAsset } from "@/lib/server/services/publish-serializers";
import { NextResponse } from "next/server";

function cookiesToString(value: string): string {
  const stripped = value.trim();
  if (!stripped) return stripped;
  if (stripped.startsWith("{")) {
    try {
      const cookies = JSON.parse(stripped) as Record<string, unknown>;
      return Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    } catch {
      return stripped;
    }
  }
  return stripped;
}

function extractCreatorMediaId(payload: Record<string, unknown>): string {
  for (const key of ["creator_media_id", "fileIds", "file_id", "media_id", "video_id"]) {
    const value = payload[key];
    if (value) return String(value);
  }
  return "";
}

/** POST /api/publish/assets/{assetId}/upload 上传素材到 Creator（对应原版 upload_publish_asset） */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const assetId = Number.parseInt(params.assetId, 10);
  const asset = await prisma.publishAsset.findFirst({
    where: { id: assetId, publishJob: { userId: user.id } },
  });
  if (!asset) throw notFound("Publish asset not found");
  const job = await prisma.publishJob.findUnique({ where: { id: asset.publishJobId } });
  if (!job) throw notFound("Publish job not found");

  const account = job.platformAccountId ? await prisma.platformAccount.findUnique({ where: { id: job.platformAccountId } }) : null;
  if (!account || account.userId !== user.id) throw notFound("Account not found");
  if (account.platform !== "xhs" || account.subType !== "creator") {
    throw badRequest("Creator account required");
  }
  const cookieVersion = await prisma.accountCookieVersion.findFirst({
    where: { platformAccountId: account.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!cookieVersion) throw badRequest("Account has no cookies");
  const cookies = cookiesToString(decryptText(cookieVersion.encryptedCookies));

  await prisma.publishAsset.update({ where: { id: asset.id }, data: { uploadStatus: "uploading", uploadError: "" } });

  // SDK 适配器（XhsCreatorApiAdapter.uploadMedia）—— 若 SDK 尚未完成翻译，此端点会 502
  try {
    const { XhsCreatorApiAdapter } = await import("@/lib/server/xhs/adapters/creator-api-adapter");
    const adapter = new XhsCreatorApiAdapter(cookies);
    const payload = await adapter.uploadMedia(asset.filePath, asset.assetType);
    const updated = await prisma.publishAsset.update({
      where: { id: asset.id },
      data: {
        uploadStatus: "uploaded",
        creatorMediaId: extractCreatorMediaId(payload),
        creatorUploadInfo: JSON.stringify(payload),
        uploadError: "",
      },
    });
    return NextResponse.json(serializePublishAsset(updated));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const message = (error as Error).message;
    const updated = await prisma.publishAsset.update({
      where: { id: asset.id },
      data: { uploadStatus: "failed", uploadError: message },
    });
    throw new ApiError(502, message);
  }
});
