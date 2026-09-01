import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { autoFixJob, serializeReviewFinding, serializeReviewJob } from "@/lib/server/services/review-service";
import { OpenAICompatibleTextClient } from "@/lib/server/services/ai-service";
import { textModelContext } from "../../../ai/shared";
import { NextResponse } from "next/server";

/** POST /api/review/{jobId}/auto-fix R-05 梯度修复：逐条修复 → 复检 → 更新状态 */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const jobId = Number.parseInt(params.jobId, 10);
  const job = await prisma.reviewJob.findFirst({ where: { id: jobId, userId: user.id } });
  if (!job) throw notFound("Review job not found");
  if (job.status === "passed") throw new ApiError(400, "审校已通过，无需修复");

  // 修复依赖 LLM，未配置模型时不可用
  const { modelConfig, apiKey } = await textModelContext(user.id);

  const { job: updated, findings } = await autoFixJob({
    jobId,
    textClient: new OpenAICompatibleTextClient(),
    modelConfig,
    apiKey,
  });
  return NextResponse.json(serializeReviewJob(updated, findings.map(serializeReviewFinding)));
});
