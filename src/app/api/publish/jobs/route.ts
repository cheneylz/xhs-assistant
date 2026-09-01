import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { paginated } from "@/lib/server/core/paginate";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { serializePublishJob } from "@/lib/server/services/publish-serializers";

/** GET /api/publish/jobs 发布任务列表（对应原版 get_publish_jobs） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const platform = searchParams.get("platform") ?? undefined;
  const page = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(searchParams.get("page_size") ?? "20", 10);
  const jobs = await prisma.publishJob.findMany({
    where: { userId: user.id, ...(platform ? { platform } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return NextResponse.json(paginated(jobs.map(serializePublishJob), page, pageSize));
});
