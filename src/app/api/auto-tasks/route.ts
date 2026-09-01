import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { paginated } from "@/lib/server/core/paginate";
import { handle, readJson } from "@/lib/server/core/route";
import { shanghaiNow } from "@/lib/server/core/time";
import { calculateNextRunAt } from "@/lib/server/services/scheduler-service";
import { NextResponse } from "next/server";
import { AutoTaskCreateSchema, serializeAutoTask, verifyAccountOwnership } from "./shared";

/** GET /api/auto-tasks 列表（对应原版 list_auto_tasks） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const page = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(searchParams.get("page_size") ?? "20", 10);
  const tasks = await prisma.autoTask.findMany({
    where: { userId: user.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return NextResponse.json(paginated(tasks.map(serializeAutoTask), page, pageSize));
});

/** POST /api/auto-tasks 创建（对应原版 create_auto_task） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, AutoTaskCreateSchema);
  await verifyAccountOwnership(user.id, payload.pc_account_id, "pc");
  await verifyAccountOwnership(user.id, payload.creator_account_id, "creator");

  const nextRunAt = calculateNextRunAt({
    scheduleType: payload.schedule_type,
    scheduleTime: payload.schedule_time,
    scheduleDays: payload.schedule_days,
    scheduleIntervalHours: payload.schedule_interval_hours,
  });
  const task = await prisma.autoTask.create({
    data: {
      userId: user.id,
      name: payload.name,
      keywords: payload.keywords,
      pcAccountId: payload.pc_account_id,
      creatorAccountId: payload.creator_account_id,
      aiInstruction: payload.ai_instruction,
      scheduleType: payload.schedule_type,
      scheduleTime: payload.schedule_time,
      scheduleDays: payload.schedule_days,
      scheduleIntervalHours: payload.schedule_interval_hours,
      status: "active",
      nextRunAt,
      createdAt: shanghaiNow(),
    },
  });
  return NextResponse.json(serializeAutoTask(task), { status: 201 });
});
