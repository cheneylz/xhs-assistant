import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { serializeReviewFinding, serializeReviewJob } from "@/lib/server/services/review-service";
import { NextResponse } from "next/server";

/** GET /api/review/{jobId} 审校报告详情（含风险点列表） */
export const GET = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const jobId = Number.parseInt(params.jobId, 10);
  const job = await prisma.reviewJob.findFirst({
    where: { id: jobId, userId: user.id },
    include: { findings: { orderBy: { id: "asc" } } },
  });
  if (!job) throw notFound("Review job not found");
  return NextResponse.json(serializeReviewJob(job, job.findings.map(serializeReviewFinding)));
});
