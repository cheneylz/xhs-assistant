import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { badRequest, notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { shanghaiNow } from "@/lib/server/core/time";
import { serializePublishJob } from "@/lib/server/services/publish-serializers";
import { NextResponse } from "next/server";

/** POST /api/publish/jobs/{jobId}/retry 重试发布（对应原版 retry_publish_job） */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const jobId = Number.parseInt(params.jobId, 10);
  const job = await prisma.publishJob.findFirst({ where: { id: jobId, userId: user.id } });
  if (!job) throw notFound("Publish job not found");
  if (!["failed", "cancelled"].includes(job.status)) {
    throw badRequest("Publish job cannot be retried");
  }
  await prisma.task.create({
    data: {
      userId: user.id,
      platform: job.platform,
      taskType: "creator_publish_retry",
      status: "pending",
      progress: 0,
      payload: { publish_job_id: job.id, platform_account_id: job.platformAccountId, publish_mode: job.publishMode },
      createdAt: shanghaiNow(),
    },
  });
  const updated = await prisma.publishJob.update({
    where: { id: job.id },
    data: { status: "pending", publishError: "", externalNoteId: "", publishedAt: null },
  });
  return NextResponse.json(serializePublishJob(updated));
});
