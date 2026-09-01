import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { ApiError, badRequest, notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { OpenAICompatibleTextClient } from "@/lib/server/services/ai-service";
import { getTextModelForUser, runOneDuePublishJob, type GateReviewer } from "@/lib/server/services/scheduler-service";
import { NextResponse } from "next/server";

/** 构建门禁审查器（复用 worker 逻辑：未配置模型时仅规则层） */
const gateReviewer: GateReviewer = async (userId) => {
  const [modelConfig, apiKey] = await getTextModelForUser(userId);
  if (!modelConfig || !apiKey) return null;
  return {
    textClient: new OpenAICompatibleTextClient(),
    modelConfig: modelConfig as unknown as Parameters<OpenAICompatibleTextClient["complete"]>[0]["modelConfig"],
    apiKey,
  };
};

/** POST /api/publish/jobs/{jobId}/approve D-02 显式批准：人工确认后执行定时发布 */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const jobId = Number.parseInt(params.jobId, 10);
  const job = await prisma.publishJob.findFirst({ where: { id: jobId, userId: user.id } });
  if (!job) throw notFound("Publish job not found");
  if (job.status !== "pending_approval") {
    throw badRequest("仅待批准的定时发布任务可执行批准");
  }

  const { XhsCreatorApiAdapter } = await import("@/lib/server/xhs/adapters/creator-api-adapter");
  const [succeeded, item] = await runOneDuePublishJob({
    userId: user.id,
    jobId,
    adapterFactory: (cookies) => new XhsCreatorApiAdapter(cookies),
    gateReviewer,
  });
  if (!succeeded) {
    const error = String(item.publish_error ?? "发布失败");
    throw new ApiError(502, error);
  }
  return NextResponse.json(item);
});
