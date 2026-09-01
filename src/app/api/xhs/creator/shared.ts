/**
 * Creator 平台路由共享工具（对应原版 creator.py 的辅助函数）
 */
import { prisma } from "@/lib/server/core/db";
import { badRequest, notFound } from "@/lib/server/core/http-error";
import { decryptText } from "@/lib/server/core/security";
import { shanghaiNow } from "@/lib/server/core/time";
import type { Prisma } from "@prisma/client";

function cookiesToString(value: string): string {
  const stripped = value.trim();
  if (!stripped) return stripped;
  if (stripped.startsWith("{")) {
    try {
      const cookies = JSON.parse(stripped) as Record<string, unknown>;
      return Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    } catch {
      return stripped;
    }
  }
  return stripped;
}

/** 取归属当前用户的 Creator 账号（对应 _get_owned_creator_account） */
export async function getOwnedCreatorAccount(userId: number, accountId: number) {
  const account = await prisma.platformAccount.findUnique({ where: { id: accountId } });
  if (!account || account.userId !== userId || account.platform !== "xhs" || account.subType !== "creator") {
    throw notFound("Creator account not found");
  }
  return account;
}

/** 取最新 Creator Cookie（对应 _get_latest_creator_cookies） */
export async function getLatestCreatorCookies(accountId: number): Promise<string> {
  const cookieVersion = await prisma.accountCookieVersion.findFirst({
    where: { platformAccountId: accountId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!cookieVersion) throw badRequest("Creator account has no cookies");
  return cookiesToString(decryptText(cookieVersion.encryptedCookies));
}

/** 懒加载 Creator 适配器 */
export async function getCreatorAdapter(cookies: string) {
  const { XhsCreatorApiAdapter } = await import("@/lib/server/xhs/adapters/creator-api-adapter");
  return new XhsCreatorApiAdapter(cookies);
}

/** 提取 payload 条目列表（对应 _payload_items） */
export function payloadItems(rawPayload: unknown): unknown[] {
  if (Array.isArray(rawPayload)) return rawPayload;
  if (!rawPayload || typeof rawPayload !== "object") return [];
  const payload = rawPayload as Record<string, unknown>;
  const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? (payload.data as Record<string, unknown>)
    : payload;
  for (const key of ["items", "list", "notes", "topics", "pois"]) {
    const value = data[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** 创建操作任务（对应 _create_operation_task） */
export async function createOperationTask(userId: number, taskType: string, payload: Prisma.InputJsonValue) {
  return prisma.task.create({
    data: {
      userId,
      platform: "xhs",
      taskType,
      status: "running",
      progress: 20,
      payload,
      createdAt: shanghaiNow(),
    },
  });
}

/** 完成任务（对应 _complete_operation_task） */
export async function completeOperationTask(taskId: number, payload: Record<string, unknown>) {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return;
  const merged: Record<string, unknown> = { ...((task.payload as Record<string, unknown>) ?? {}), ...payload };
  await prisma.task.update({
    where: { id: taskId },
    data: { status: "completed", progress: 100, payload: merged as unknown as Prisma.InputJsonValue },
  });
}

/** 失败任务（对应 _fail_operation_task） */
export async function failOperationTask(taskId: number, error: string) {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return;
  const merged: Record<string, unknown> = { ...((task.payload as Record<string, unknown>) ?? {}), error };
  await prisma.task.update({
    where: { id: taskId },
    data: { status: "failed", progress: 100, payload: merged as Prisma.InputJsonValue },
  });
}

/** 定时发布时间戳（对应 _scheduled_post_time） */
export function scheduledPostTime(publishMode: string, scheduledAt: Date | null | undefined): number | null {
  if (publishMode !== "scheduled") return null;
  if (!scheduledAt) throw badRequest("Scheduled publish time is required");
  return Math.floor(scheduledAt.getTime());
}
