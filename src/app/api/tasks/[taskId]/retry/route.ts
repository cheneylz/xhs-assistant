import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { getOwnedTask, serializeTask } from "../../shared";

/** POST /api/tasks/{taskId}/retry 重试任务（failed/exhausted -> pending，对应原版 retry_task） */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const taskId = Number.parseInt(params.taskId, 10);
  const task = await getOwnedTask(user.id, taskId);
  if (task.status === "failed" || task.status === "exhausted") {
    const updated = await prisma.task.update({
      where: { id: task.id },
      data: {
        status: "pending",
        progress: 0,
        retryCount: task.retryCount + 1,
        errorType: null,
        startedAt: null,
        finishedAt: null,
      },
    });
    return NextResponse.json(serializeTask(updated));
  }
  return NextResponse.json(serializeTask(task));
});
