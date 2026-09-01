/**
 * 自动运营共享工具（auto-tasks 路由与调度共用）
 */
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { formatDateTime } from "@/lib/server/core/time";
import { z } from "zod";

export const AutoTaskCreateSchema = z.object({
  name: z.string().min(1).max(128),
  keywords: z.array(z.string()).min(1),
  pc_account_id: z.number().int(),
  creator_account_id: z.number().int(),
  ai_instruction: z.string().max(2000).default(""),
  schedule_type: z.enum(["manual", "daily", "weekly", "interval"]).default("manual"),
  schedule_time: z.string().max(5).default("09:00"),
  schedule_days: z.string().max(64).default(""),
  schedule_interval_hours: z.number().int().min(1).max(168).default(24),
});

export const AutoTaskUpdateSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  keywords: z.array(z.string()).optional(),
  ai_instruction: z.string().max(2000).optional(),
  status: z.enum(["active", "paused", "completed"]).optional(),
  schedule_type: z.enum(["manual", "daily", "weekly", "interval"]).optional(),
  schedule_time: z.string().max(5).optional(),
  schedule_days: z.string().max(64).optional(),
  schedule_interval_hours: z.number().int().min(1).max(168).optional(),
});

export function serializeAutoTask(task: {
  id: number;
  userId: number;
  name: string;
  keywords: unknown;
  pcAccountId: number;
  creatorAccountId: number;
  aiInstruction: string;
  status: string;
  scheduleType: string;
  scheduleTime: string;
  scheduleDays: string;
  scheduleIntervalHours: number;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  totalPublished: number;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: task.id,
    user_id: task.userId,
    name: task.name,
    keywords: Array.isArray(task.keywords) ? task.keywords : [],
    pc_account_id: task.pcAccountId,
    creator_account_id: task.creatorAccountId,
    ai_instruction: task.aiInstruction,
    status: task.status,
    schedule_type: task.scheduleType,
    schedule_time: task.scheduleTime,
    schedule_days: task.scheduleDays,
    schedule_interval_hours: task.scheduleIntervalHours,
    last_run_at: task.lastRunAt ? formatDateTime(task.lastRunAt) : null,
    next_run_at: task.nextRunAt ? formatDateTime(task.nextRunAt) : null,
    total_published: task.totalPublished,
    created_at: formatDateTime(task.createdAt),
  };
}

/** 校验账号归属（对应 _verify_account_ownership） */
export async function verifyAccountOwnership(userId: number, accountId: number, expectedSubType: string) {
  const account = await prisma.platformAccount.findUnique({ where: { id: accountId } });
  if (!account || account.userId !== userId || account.platform !== "xhs" || account.subType !== expectedSubType) {
    throw notFound(`XHS ${expectedSubType} account not found`);
  }
  return account;
}
