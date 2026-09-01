import { getCurrentUser } from "@/lib/server/core/auth";
import { getConfig } from "@/lib/server/core/config";
import { prisma } from "@/lib/server/core/db";
import { ApiError, badRequest, notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { decryptText } from "@/lib/server/core/security";
import { formatDateTime, shanghaiNow } from "@/lib/server/core/time";
import { serializePublishJob } from "@/lib/server/services/publish-serializers";
import { computeReviewStatus, runReview } from "@/lib/server/services/review-service";
import { OpenAICompatibleTextClient } from "@/lib/server/services/ai-service";
import { textModelContext } from "../../../../ai/shared";
import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";

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

function extractExternalNoteId(payload: Record<string, unknown>): string {
  for (const key of ["note_id", "noteId", "id"]) {
    const value = payload[key];
    if (value) return String(value);
  }
  const data = payload.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return extractExternalNoteId(data as Record<string, unknown>);
  }
  return "";
}

function scheduledPostTime(job: { publishMode: string; scheduledAt: Date | null }): number | null {
  if (job.publishMode !== "scheduled") return null;
  if (!job.scheduledAt) throw badRequest("Scheduled publish time is required");
  if (job.scheduledAt.getTime() <= Date.now()) {
    throw badRequest("Scheduled publish time must be in the future");
  }
  return Math.floor(job.scheduledAt.getTime());
}

function loadPublishOptions(publishOptions: string): Record<string, unknown> {
  try {
    const options = JSON.parse(publishOptions || "{}");
    return options && typeof options === "object" && !Array.isArray(options) ? options : {};
  } catch {
    return {};
  }
}

function cleanTopics(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((topic): topic is string => typeof topic === "string" && topic.trim().length > 0).map((t) => t.trim());
}

/** 解析素材文件路径（支持 /api/files/media/{name} 与本地绝对路径两种格式） */
function resolveAssetFilePath(filePath: string): string | null {
  if (filePath.startsWith("/api/files/media/")) {
    const fileName = filePath.split("/").pop() ?? "";
    return `${getConfig().storageDir}/media/${fileName}`;
  }
  return existsSync(filePath) ? filePath : null;
}

function applyPublishOptions(noteInfo: Record<string, unknown>, options: Record<string, unknown>): void {
  let topics = cleanTopics(options.topics);
  if (!topics.length) {
    const draftTags = options.draft_tags;
    if (Array.isArray(draftTags)) {
      topics = draftTags
        .filter((t): t is Record<string, unknown> => Boolean(t && typeof t === "object" && !Array.isArray(t)))
        .map((t) => String(t.name ?? ""))
        .filter(Boolean);
    }
  }
  if (topics.length) noteInfo.topics = topics;
  const location = options.location;
  if (typeof location === "string" && location.trim()) noteInfo.location = location.trim();
  const privacyType = options.privacy_type;
  if (privacyType === 0 || privacyType === 1) noteInfo.type = privacyType;
}

/** POST /api/publish/jobs/{jobId}/publish 立即/定时发布到 Creator（对应原版 publish_job_to_creator） */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const jobId = Number.parseInt(params.jobId, 10);
  const job = await prisma.publishJob.findFirst({ where: { id: jobId, userId: user.id } });
  if (!job) throw notFound("Publish job not found");
  if (!job.platformAccountId) throw badRequest("请先选择发布账号");
  const account = await prisma.platformAccount.findUnique({ where: { id: job.platformAccountId } });
  if (!account || account.userId !== user.id) throw notFound("Account not found");
  if (account.platform !== "xhs" || account.subType !== "creator") {
    throw badRequest("Creator account required");
  }
  if (["publishing", "published", "scheduled"].includes(job.status)) {
    throw badRequest("Publish job is already completed");
  }
  // R-06 三道门禁：blocked 直接禁止；未审校的发布前现场执行门禁（LLM 缺失时仅规则层）
  if (job.gateStatus === "blocked") {
    throw badRequest("三道门禁未通过，禁止发布，请先在审校工作台处理");
  }
  if (job.gateStatus === "pending") {
    let textModel: { modelConfig: unknown; apiKey: string } | null = null;
    try {
      textModel = await textModelContext(user.id);
    } catch {
      textModel = null;
    }
    const findings = await runReview({
      userId: user.id,
      title: job.title,
      body: job.body,
      textClient: textModel ? new OpenAICompatibleTextClient() : null,
      modelConfig: (textModel?.modelConfig as Parameters<typeof runReview>[0]["modelConfig"]) ?? null,
      apiKey: textModel?.apiKey ?? null,
    });
    const { gateStatus } = computeReviewStatus(findings);
    await prisma.publishJob.update({ where: { id: job.id }, data: { gateStatus } });
    if (gateStatus === "blocked") {
      throw badRequest("三道门禁未通过，禁止发布，请先在审校工作台处理");
    }
  }
  if (!job.title.trim()) throw badRequest("Publish title is required");
  if (job.publishMode === "scheduled") {
    if (!job.scheduledAt) throw badRequest("Scheduled publish time is required");
    if (job.scheduledAt.getTime() <= Date.now()) {
      throw badRequest("Scheduled publish time must be in the future");
    }
  }

  const assets = await prisma.publishAsset.findMany({ where: { publishJobId: job.id }, orderBy: { id: "asc" } });
  if (!assets.length) throw badRequest("至少需要一个素材");

  const cookieVersion = await prisma.accountCookieVersion.findFirst({
    where: { platformAccountId: account.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!cookieVersion) throw badRequest("Account has no cookies");
  const cookies = cookiesToString(decryptText(cookieVersion.encryptedCookies));

  // 懒加载 Creator 适配器（SDK 类翻译完成后可用）
  const { XhsCreatorApiAdapter } = await import("@/lib/server/xhs/adapters/creator-api-adapter");
  const adapter = new XhsCreatorApiAdapter(cookies);

  // 上传未就绪素材（图片预上传；视频素材由 SDK 发布时统一上传，见下）
  for (const asset of assets) {
    if (asset.assetType === "video") continue;
    if (asset.uploadStatus === "pending" || asset.uploadStatus === "failed") {
      try {
        const payload = await adapter.uploadMedia(asset.filePath, asset.assetType);
        await prisma.publishAsset.update({
          where: { id: asset.id },
          data: {
            uploadStatus: "uploaded",
            creatorMediaId: extractCreatorMediaId(payload),
            creatorUploadInfo: JSON.stringify(payload),
            uploadError: "",
          },
        });
      } catch (error) {
        await prisma.publishAsset.update({
          where: { id: asset.id },
          data: { uploadStatus: "failed", uploadError: String((error as Error).message).slice(0, 500) },
        });
        throw new ApiError(502, `素材上传失败: ${(error as Error).message}`);
      }
    }
  }

  const refreshedAssets = await prisma.publishAsset.findMany({ where: { publishJobId: job.id }, orderBy: { id: "asc" } });
  const uploadedImages = refreshedAssets.filter((a) => a.assetType === "image" && a.uploadStatus === "uploaded");
  const uploadedVideos = refreshedAssets.filter((a) => a.assetType === "video" && a.uploadStatus === "uploaded");
  if (!uploadedImages.length && !uploadedVideos.length) {
    throw badRequest("没有成功上传的素材");
  }
  if (uploadedImages.length && uploadedVideos.length) {
    throw badRequest("视频与图片素材不能共存，请移除其中一种");
  }

  // 视频发布：走 SDK 视频分支（内部完成抽帧封面 + 元数据 + 上传 + 转码轮询），单视频笔记
  if (uploadedVideos.length) {
    const videoAsset = uploadedVideos[0];
    const videoPath = resolveAssetFilePath(videoAsset.filePath);
    if (!videoPath) throw badRequest("视频素材文件不存在");
    const noteInfo: Record<string, unknown> = {
      title: job.title,
      desc: job.body,
      media_type: "video",
      video: readFileSync(videoPath),
      type: 1,
      postTime: scheduledPostTime(job),
    };
    applyPublishOptions(noteInfo, loadPublishOptions(job.publishOptions));

    const videoTask = await prisma.task.create({
      data: {
        userId: user.id,
        platform: job.platform,
        taskType: "creator_publish",
        status: "running",
        progress: 20,
        payload: {
          publish_job_id: job.id,
          platform_account_id: account.id,
          asset_ids: uploadedVideos.map((a) => a.id),
          media_type: "video",
          publish_mode: job.publishMode,
        },
        createdAt: shanghaiNow(),
      },
    });
    await prisma.publishJob.update({ where: { id: job.id }, data: { status: "publishing", publishError: "" } });

    try {
      const payload = await adapter.postNote(noteInfo);
      // SDK 内部完成视频上传，同步素材状态为已上传
      await prisma.publishAsset.updateMany({
        where: { publishJobId: job.id, assetType: "video" },
        data: { uploadStatus: "uploaded", uploadError: "" },
      });
      const externalId = extractExternalNoteId(payload);
      const publishedAt = shanghaiNow();
      const updated = await prisma.publishJob.update({
        where: { id: job.id },
        data: {
          status: job.publishMode === "scheduled" ? "scheduled" : "published",
          externalNoteId: externalId,
          publishError: "",
          publishedAt,
        },
      });
      await prisma.task.update({
        where: { id: videoTask.id },
        data: {
          status: "completed",
          progress: 100,
          payload: { ...(videoTask.payload as Record<string, unknown>), external_note_id: externalId, published_at: formatDateTime(publishedAt) },
        },
      });
      return NextResponse.json(serializePublishJob(updated));
    } catch (error) {
      const message = (error as Error).message;
      await prisma.publishJob.update({
        where: { id: job.id },
        data: { status: "failed", publishError: message },
      });
      await prisma.task.update({
        where: { id: videoTask.id },
        data: { status: "failed", progress: 100, payload: { ...(videoTask.payload as Record<string, unknown>), error: message } },
      });
      throw new ApiError(502, message);
    }
  }

  const imageFileInfos: Array<Record<string, unknown>> = [];
  for (const asset of uploadedImages) {
    let uploadInfo: unknown = {};
    try {
      uploadInfo = JSON.parse(asset.creatorUploadInfo || "{}");
    } catch {
      throw badRequest("Uploaded asset metadata is invalid");
    }
    if (!(uploadInfo as Record<string, unknown>).fileIds) {
      throw badRequest("Uploaded asset is missing Creator upload info");
    }
    imageFileInfos.push(uploadInfo as Record<string, unknown>);
  }

  const noteInfo: Record<string, unknown> = {
    title: job.title,
    desc: job.body,
    media_type: "image",
    image_file_infos: imageFileInfos,
    type: 1,
    postTime: scheduledPostTime(job),
  };
  applyPublishOptions(noteInfo, loadPublishOptions(job.publishOptions));

  const task = await prisma.task.create({
    data: {
      userId: user.id,
      platform: job.platform,
      taskType: "creator_publish",
      status: "running",
      progress: 20,
      payload: {
        publish_job_id: job.id,
        platform_account_id: account.id,
        asset_ids: uploadedImages.map((a) => a.id),
        publish_mode: job.publishMode,
      },
      createdAt: shanghaiNow(),
    },
  });
  await prisma.publishJob.update({ where: { id: job.id }, data: { status: "publishing", publishError: "" } });

  try {
    const payload = await adapter.postNote(noteInfo);
    const externalId = extractExternalNoteId(payload);
    const publishedAt = shanghaiNow();
    const updated = await prisma.publishJob.update({
      where: { id: job.id },
      data: {
        status: job.publishMode === "scheduled" ? "scheduled" : "published",
        externalNoteId: externalId,
        publishError: "",
        publishedAt,
      },
    });
    await prisma.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        payload: { ...(task.payload as Record<string, unknown>), external_note_id: externalId, published_at: formatDateTime(publishedAt) },
      },
    });
    return NextResponse.json(serializePublishJob(updated));
  } catch (error) {
    const message = (error as Error).message;
    const updated = await prisma.publishJob.update({
      where: { id: job.id },
      data: { status: "failed", publishError: message },
    });
    await prisma.task.update({
      where: { id: task.id },
      data: { status: "failed", progress: 100, payload: { ...(task.payload as Record<string, unknown>), error: message } },
    });
    throw new ApiError(502, message);
  }
});
