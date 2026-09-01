import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { formatDateTime, parseNaiveDateTime, shanghaiNow } from "@/lib/server/core/time";
import type { AiDraft, PublishJob } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

/** 草稿转发布请求体（对应原版 DraftSendToPublishRequest） */
const DraftSendToPublishSchema = z.object({
  platform_account_id: z.number().int().nullable().optional(),
  publish_mode: z.enum(["immediate", "scheduled"]).default("immediate"),
  scheduled_at: z.string().nullable().optional(),
  topics: z.array(z.string()).nullable().optional(),
  location: z.string().nullable().optional(),
  privacy_type: z.number().int().min(0).max(1).nullable().optional(),
  is_private: z.boolean().nullable().optional(),
});

/** 清洗话题列表（去除空白项并 trim，对应原版 _clean_topics） */
function cleanTopics(topics: string[] | null | undefined): string[] {
  if (!topics) return [];
  return topics.filter((topic) => topic && topic.trim()).map((topic) => topic.trim());
}

/** 构建发布选项（对应原版 _build_publish_options） */
function buildPublishOptions(payload: z.infer<typeof DraftSendToPublishSchema>): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  const topics = cleanTopics(payload.topics);
  if (topics.length) options.topics = topics;
  if (payload.location && payload.location.trim()) options.location = payload.location.trim();
  // is_private 优先，其次 privacy_type（对应原版）
  if (payload.is_private !== null && payload.is_private !== undefined) {
    options.is_private = payload.is_private;
    options.privacy_type = payload.is_private ? 1 : 0;
  } else if (payload.privacy_type !== null && payload.privacy_type !== undefined) {
    options.privacy_type = payload.privacy_type;
    options.is_private = payload.privacy_type === 1;
  }
  return options;
}

/** 序列化发布任务（对应原版 _serialize_publish_job） */
function serializePublishJob(job: PublishJob) {
  let publishOptions: unknown = {};
  try {
    publishOptions = JSON.parse(job.publishOptions || "{}");
  } catch {
    publishOptions = {};
  }
  return {
    id: job.id,
    platform_account_id: job.platformAccountId,
    source_draft_id: job.sourceDraftId,
    platform: job.platform,
    title: job.title,
    body: job.body,
    publish_mode: job.publishMode,
    publish_options: publishOptions,
    status: job.status,
    scheduled_at: job.scheduledAt ? formatDateTime(job.scheduledAt) : null,
    created_at: formatDateTime(job.createdAt),
  };
}

/** 获取当前用户拥有的草稿（对应原版 _get_owned_draft 逻辑） */
async function getOwnedDraft(userId: number, draftId: number) {
  const draft = await prisma.aiDraft.findUnique({ where: { id: draftId } });
  if (!draft || draft.userId !== userId) throw notFound("Draft not found");
  return draft;
}

/** POST /api/drafts/{draftId}/send-to-publish 草稿转发布任务（对应原版 send_draft_to_publish） */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const draftId = Number.parseInt(params.draftId, 10);
  const draft: AiDraft = await getOwnedDraft(user.id, draftId);
  const payload = await readJson(req, DraftSendToPublishSchema);

  // 校验发布账号：须归属当前用户且平台与草稿一致（对应原版）
  let accountId: number | null = null;
  if (payload.platform_account_id !== null && payload.platform_account_id !== undefined) {
    const account = await prisma.platformAccount.findUnique({ where: { id: payload.platform_account_id } });
    if (!account || account.userId !== user.id || account.platform !== draft.platform) {
      throw notFound("Platform account not found");
    }
    accountId = account.id;
  }

  // 解析定时发布时间（naive 上海时间，对应原版 Optional[datetime]）
  let scheduledAt: Date | null = null;
  if (payload.scheduled_at) {
    scheduledAt = parseNaiveDateTime(payload.scheduled_at);
    if (!scheduledAt) throw new ApiError(422, "scheduled_at: invalid datetime");
  }

  const options = buildPublishOptions(payload);
  if (draft.tags) options.draft_tags = draft.tags;

  // 继承草稿最近一次审校的门禁状态（R-06：发布前强制三道门禁）
  const latestReview = await prisma.reviewJob.findFirst({
    where: { userId: user.id, sourceDraftId: draft.id },
    orderBy: { createdAt: "desc" },
  });

  const job = await prisma.publishJob.create({
    data: {
      userId: user.id,
      platformAccountId: accountId,
      sourceDraftId: draft.id,
      platform: draft.platform,
      title: draft.title,
      body: draft.body,
      publishMode: payload.publish_mode,
      publishOptions: JSON.stringify(options),
      scheduledAt,
      status: "pending",
      gateStatus: latestReview?.gateStatus ?? "pending",
      createdAt: shanghaiNow(),
    },
  });

  // 复制草稿素材为发布素材（对应原版，file_path 本地优先）
  const draftAssets = await prisma.draftAsset.findMany({
    where: { draftId: draft.id },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
  for (const asset of draftAssets) {
    await prisma.publishAsset.create({
      data: {
        publishJobId: job.id,
        assetType: asset.assetType,
        filePath: asset.localPath ? `/api/files/media/${asset.localPath}` : asset.url,
        uploadStatus: "pending",
      },
    });
  }

  return NextResponse.json(serializePublishJob(job));
});
