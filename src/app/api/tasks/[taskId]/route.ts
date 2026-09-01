import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { getOwnedTask, serializeTask } from "../shared";

/** GET /api/tasks/{taskId} 任务详情（含子任务 children，对应原版 get_task） */
export const GET = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const taskId = Number.parseInt(params.taskId, 10);
  const task = await getOwnedTask(user.id, taskId);
  const children = await prisma.task.findMany({
    where: { parentTaskId: task.id, userId: user.id },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ ...serializeTask(task), children: children.map(serializeTask) });
});
