import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { parseNaiveDateTime } from "@/lib/server/core/time";
import { serializeTask } from "@/lib/server/services/task-serializer";
import { NextResponse } from "next/server";
import { z } from "zod";
import { completeOperationTask, createOperationTask, failOperationTask, getCreatorAdapter, getLatestCreatorCookies, getOwnedCreatorAccount, scheduledPostTime } from "../../shared";

const CreatorVideoPublishSchema = z.object({
  account_id: z.number().int(),
  title: z.string().min(1).max(256),
  body: z.string().default(""),
  video_info: z.record(z.string(), z.unknown()).default({}),
  publish_mode: z.enum(["immediate", "scheduled"]).default("immediate"),
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

function applyPublishOptions(noteInfo: Record<string, unknown>, payload: z.infer<typeof CreatorVideoPublishSchema>): void {
  const topics = cleanTopics(payload.topics);
  if (topics.length) noteInfo.topics = topics;
  if (payload.location && payload.location.trim()) noteInfo.location = payload.location.trim();
  if (payload.is_private !== undefined && payload.is_private !== null) noteInfo.type = payload.is_private ? 1 : 0;
  else if (payload.privacy_type !== undefined && payload.privacy_type !== null) noteInfo.type = payload.privacy_type;
}

/** POST /api/xhs/creator/publish/video 视频发布（对应原版 publish_video） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, CreatorVideoPublishSchema);
  const account = await getOwnedCreatorAccount(user.id, payload.account_id);
  const scheduledAt = payload.scheduled_at ? parseNaiveDateTime(payload.scheduled_at) : null;
  const noteInfo: Record<string, unknown> = {
    title: payload.title,
    desc: payload.body,
    media_type: "video",
    video_info: payload.video_info,
    type: 1,
    postTime: scheduledPostTime(payload.publish_mode, scheduledAt),
  };
  applyPublishOptions(noteInfo, payload);
  const task = await createOperationTask(user.id, "creator_direct_publish", {
    account_id: account.id,
    media_type: "video",
    publish_mode: payload.publish_mode,
  });
  try {
    const adapter = await getCreatorAdapter(await getLatestCreatorCookies(account.id));
    const publishPayload = await adapter.postNote(noteInfo);
    await completeOperationTask(task.id, { payload: publishPayload });
    const { prisma } = await import("@/lib/server/core/db");
    const completed = await prisma.task.findUnique({ where: { id: task.id } });
    return NextResponse.json({ task: completed ? serializeTask(completed) : null, payload: publishPayload });
  } catch (error) {
    await failOperationTask(task.id, (error as Error).message);
    throw new ApiError(502, (error as Error).message);
  }
});
