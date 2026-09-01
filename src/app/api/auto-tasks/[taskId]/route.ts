import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { calculateNextRunAt } from "@/lib/server/services/scheduler-service";
import { NextResponse } from "next/server";
import { AutoTaskUpdateSchema, serializeAutoTask } from "../shared";

async function getOwnedTask(userId: number, taskId: number) {
  const task = await prisma.autoTask.findFirst({ where: { id: taskId, userId } });
  if (!task) throw notFound("Auto task not found");
  return task;
}

/** PATCH /api/auto-tasks/{taskId} 更新（对应原版 update_auto_task） */
export const PATCH = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const taskId = Number.parseInt(params.taskId, 10);
  const task = await getOwnedTask(user.id, taskId);
  const payload = await readJson(req, AutoTaskUpdateSchema);

  const data: Record<string, unknown> = {};
  let scheduleChanged = false;
  if (payload.name !== undefined) data.name = payload.name;
  if (payload.keywords !== undefined) data.keywords = payload.keywords;
  if (payload.ai_instruction !== undefined) data.aiInstruction = payload.ai_instruction;
  if (payload.status !== undefined) data.status = payload.status;
  if (payload.schedule_type !== undefined) {
    data.scheduleType = payload.schedule_type;
    scheduleChanged = true;
  }
  if (payload.schedule_time !== undefined) {
    data.scheduleTime = payload.schedule_time;
    scheduleChanged = true;
  }
  if (payload.schedule_days !== undefined) {
    data.scheduleDays = payload.schedule_days;
    scheduleChanged = true;
  }
  if (payload.schedule_interval_hours !== undefined) {
    data.scheduleIntervalHours = payload.schedule_interval_hours;
    scheduleChanged = true;
  }
  if (scheduleChanged) {
    data.nextRunAt = calculateNextRunAt({
      scheduleType: String(data.scheduleType ?? task.scheduleType),
      scheduleTime: String(data.scheduleTime ?? task.scheduleTime),
      scheduleDays: String(data.scheduleDays ?? task.scheduleDays),
      scheduleIntervalHours: Number(data.scheduleIntervalHours ?? task.scheduleIntervalHours),
    });
  }
  const updated = await prisma.autoTask.update({ where: { id: task.id }, data });
  return NextResponse.json(serializeAutoTask(updated));
});

/** DELETE /api/auto-tasks/{taskId} 删除（对应原版 delete_auto_task） */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const taskId = Number.parseInt(params.taskId, 10);
  await getOwnedTask(user.id, taskId);
  await prisma.autoTask.delete({ where: { id: taskId } });
  return NextResponse.json({ id: taskId, status: "deleted" });
});
