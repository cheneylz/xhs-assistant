import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { getOwnedTask, serializeTask } from "../../shared";

/** POST /api/tasks/{taskId}/cancel 取消任务（pending/running -> cancelled，对应原版 cancel_task） */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const taskId = Number.parseInt(params.taskId, 10);
  const task = await getOwnedTask(user.id, taskId);
  if (task.status === "pending" || task.status === "running") {
    const updated = await prisma.task.update({
      where: { id: task.id },
      data: { status: "cancelled" },
    });
    return NextResponse.json(serializeTask(updated));
  }
  return NextResponse.json(serializeTask(task));
});
