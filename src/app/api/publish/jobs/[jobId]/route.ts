import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { ApiError, badRequest, notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { parseNaiveDateTime } from "@/lib/server/core/time";
import { serializePublishJob } from "@/lib/server/services/publish-serializers";
import { NextResponse } from "next/server";
import { z } from "zod";

const PublishJobUpdateSchema = z.object({
  title: z.string().max(256).optional(),
  body: z.string().optional(),
  platform_account_id: z.number().int().optional(),
  publish_mode: z.enum(["immediate", "scheduled"]).optional(),
  scheduled_at: z.string().optional(),
  topics: z.array(z.string()).optional(),
  location: z.string().optional(),
  privacy_type: z.number().int().min(0).max(1).optional(),
  is_private: z.boolean().optional(),
});

function cleanTopics(topics: string[] | undefined): string[] {
  if (!topics) return [];
  return topics.filter((topic) => topic && topic.trim()).map((topic) => topic.trim());
}

function loadPublishOptions(publishOptions: string): Record<string, unknown> {
  try {
    const options = JSON.parse(publishOptions || "{}");
    return options && typeof options === "object" && !Array.isArray(options) ? options : {};
  } catch {
    return {};
  }
}

async function getOwnedJob(userId: number, jobId: number) {
  const job = await prisma.publishJob.findFirst({ where: { id: jobId, userId } });
  if (!job) throw notFound("Publish job not found");
  return job;
}

function updatePublishOptions(
  publishOptions: string,
  payload: z.infer<typeof PublishJobUpdateSchema>,
  fields: Set<string>,
): string {
  if (!["topics", "location", "privacy_type", "is_private"].some((key) => fields.has(key))) {
    return publishOptions;
  }
  const options = loadPublishOptions(publishOptions);
  if (fields.has("topics")) {
    const topics = cleanTopics(payload.topics);
    if (topics.length) options.topics = topics;
    else delete options.topics;
  }
  if (fields.has("location")) {
    if (payload.location && payload.location.trim()) options.location = payload.location.trim();
    else delete options.location;
  }
  if (fields.has("is_private")) {
    if (payload.is_private === null || payload.is_private === undefined) {
      delete options.is_private;
      delete options.privacy_type;
    } else {
      options.is_private = payload.is_private;
      options.privacy_type = payload.is_private ? 1 : 0;
    }
  } else if (fields.has("privacy_type")) {
    if (payload.privacy_type === null || payload.privacy_type === undefined) {
      delete options.privacy_type;
      delete options.is_private;
    } else {
      options.privacy_type = payload.privacy_type;
      options.is_private = payload.privacy_type === 1;
    }
  }
  return JSON.stringify(options);
}

/** GET /api/publish/jobs/{jobId} 详情（对应原版 get_publish_job） */
export const GET = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const job = await getOwnedJob(user.id, Number.parseInt(params.jobId, 10));
  return NextResponse.json(serializePublishJob(job));
});

/** PATCH /api/publish/jobs/{jobId} 更新（对应原版 update_publish_job） */
export const PATCH = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const jobId = Number.parseInt(params.jobId, 10);
  const job = await getOwnedJob(user.id, jobId);
  const payload = await readJson(req, PublishJobUpdateSchema);
  const fields = new Set(Object.keys(payload));

  const data: Record<string, unknown> = {};
  if (payload.platform_account_id !== undefined) {
    const account = await prisma.platformAccount.findUnique({ where: { id: payload.platform_account_id } });
    if (!account || account.userId !== user.id || account.platform !== job.platform) {
      throw notFound("Platform account not found");
    }
    data.platformAccountId = account.id;
  }
  if (payload.title !== undefined) data.title = payload.title;
  if (payload.body !== undefined) data.body = payload.body;
  if (payload.publish_mode !== undefined) data.publishMode = payload.publish_mode;
  if (payload.scheduled_at !== undefined || payload.publish_mode === "immediate") {
    if (payload.scheduled_at !== undefined && payload.scheduled_at !== null) {
      const parsed = parseNaiveDateTime(payload.scheduled_at);
      if (!parsed) throw new ApiError(422, "scheduled_at 格式无效");
      data.scheduledAt = parsed;
    } else if (payload.publish_mode === "immediate") {
      data.scheduledAt = null;
    }
  }
  data.publishOptions = updatePublishOptions(job.publishOptions, payload, fields);
  const updated = await prisma.publishJob.update({ where: { id: job.id }, data });
  return NextResponse.json(serializePublishJob(updated));
});

/** DELETE /api/publish/jobs/{jobId} 删除（对应原版 delete_publish_job） */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const jobId = Number.parseInt(params.jobId, 10);
  const job = await getOwnedJob(user.id, jobId);
  if (job.status === "publishing" || job.status === "uploading") {
    throw badRequest("正在进行中的任务无法删除");
  }
  await prisma.publishAsset.deleteMany({ where: { publishJobId: job.id } });
  await prisma.publishJob.delete({ where: { id: job.id } });
  return NextResponse.json({ ok: true });
});
