import { getCurrentUser } from "@/lib/server/core/auth";
import { getConfig } from "@/lib/server/core/config";
import { prisma } from "@/lib/server/core/db";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { isSchedulerTask, serializeTask } from "../../shared";

/** GET /api/tasks/scheduler/status 调度器状态（对应原版 scheduler_status） */
export const GET = handle(async (req) => {
  const user = await getCurrentUser(req);
  // 原版从 request.app.state.scheduler（APScheduler）读取；TS 端调度器由独立 worker 进程承载，
  // 进程内无调度器实例，running 恒为 false、jobs 恒为空数组，接入全局调度器单例后补充
  const jobs: { id: string; next_run_time: string | null }[] = [];
  const candidates = await prisma.task.findMany({
    where: {
      userId: user.id,
      taskType: { in: ["creator_publish_scheduler", "monitoring_refresh"] },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
  });
  const recentTasks = candidates.filter(isSchedulerTask).slice(0, 10);
  return NextResponse.json({
    // 原版 scheduler_enabled 由配置（SCHEDULER_ENABLED 环境变量）控制，默认 false
    enabled: process.env.SCHEDULER_ENABLED === "true",
    running: false,
    interval_seconds: getConfig().schedulerIntervalSeconds,
    jobs,
    recent_tasks: recentTasks.map(serializeTask),
  });
});
