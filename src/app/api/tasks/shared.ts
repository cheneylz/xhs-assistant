/**
 * 任务路由共享工具（对应原版 backend/app/api/tasks.py 的 serialize_task / _get_owned_task / _is_scheduler_task）
 * serializeTask 实现位于 src/lib/server/services/task-serializer.ts（供 tasks/crawl/调度共用）
 */
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import type { TaskLike } from "@/lib/server/services/task-serializer";
import { serializeTask } from "@/lib/server/services/task-serializer";

export type { TaskLike };
export { serializeTask };

/** 查询并校验任务归属（对应 _get_owned_task，不存在或非本人时 404） */
export async function getOwnedTask(userId: number, taskId: number): Promise<TaskLike> {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task || task.userId !== userId) {
    throw notFound("Task not found");
  }
  return task;
}

/** 判断是否为调度器任务（对应 _is_scheduler_task） */
export function isSchedulerTask(task: Pick<TaskLike, "taskType" | "payload">): boolean {
  if (task.taskType === "creator_publish_scheduler") return true;
  if (task.taskType === "monitoring_refresh") {
    return Boolean((task.payload as Record<string, unknown> | null)?.scheduler);
  }
  return false;
}
