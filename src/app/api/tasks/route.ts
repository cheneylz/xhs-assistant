import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { paginated } from "@/lib/server/core/paginate";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { serializeTask } from "./shared";

/** GET /api/tasks 任务列表（支持 platform 过滤，分页；对应原版 get_tasks） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const platform = searchParams.get("platform") ?? undefined;
  const page = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(searchParams.get("page_size") ?? "20", 10);
  const tasks = await prisma.task.findMany({
    where: { userId: user.id, ...(platform ? { platform } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return NextResponse.json(paginated(tasks.map(serializeTask), page, pageSize));
});
