/**
 * 通知服务（对应原版 backend/app/services/notification_service.py）
 */
import { shanghaiNow } from "../core/time";
import { prisma } from "../core/db";

export interface TaskLike {
  id: number;
  userId: number;
  taskType: string;
  retryCount: number;
  payload: unknown;
}

function createNotification(options: {
  userId: number;
  title: string;
  body?: string;
  level?: string;
  sourceTaskId?: number | null;
  sourceType?: string | null;
  sourceId?: number | null;
}) {
  return prisma.notification.create({
    data: {
      userId: options.userId,
      title: options.title,
      body: options.body ?? "",
      level: options.level ?? "info",
      sourceTaskId: options.sourceTaskId ?? null,
      sourceType: options.sourceType ?? null,
      sourceId: options.sourceId ?? null,
      read: false,
      createdAt: shanghaiNow(),
    },
  });
}

export function notifyTaskFailed(task: TaskLike) {
  const payload = (task.payload ?? {}) as Record<string, unknown>;
  return createNotification({
    userId: task.userId,
    title: `任务失败: ${task.taskType}`,
    body: String(payload.error ?? ""),
    level: "warning",
    sourceTaskId: task.id,
    sourceType: "task",
    sourceId: task.id,
  });
}

export function notifyTaskExhausted(task: TaskLike) {
  return createNotification({
    userId: task.userId,
    title: `任务重试耗尽: ${task.taskType}`,
    body: `已重试 ${task.retryCount} 次`,
    level: "error",
    sourceTaskId: task.id,
    sourceType: "task",
    sourceId: task.id,
  });
}

export function notifyAccountExpired(userId: number, accountName: string, accountId: number) {
  return createNotification({
    userId,
    title: `账号凭证过期: ${accountName}`,
    body: "请重新登录或更新 Cookie",
    level: "error",
    sourceType: "account",
    sourceId: accountId,
  });
}

export function notifyPublishFailed(userId: number, jobTitle: string, jobId: number, taskId?: number | null) {
  return createNotification({
    userId,
    title: `发布失败: ${jobTitle}`,
    body: "",
    level: "warning",
    sourceTaskId: taskId ?? null,
    sourceType: "publish_job",
    sourceId: jobId,
  });
}

/** 定时发布到点，等待人工批准（D-02 pending_approval） */
export function notifyPublishApprovalNeeded(userId: number, jobTitle: string, jobId: number) {
  return createNotification({
    userId,
    title: `定时发布待批准: ${jobTitle}`,
    body: "内容已通过三道门禁，请在发布中心确认后发布",
    level: "info",
    sourceType: "publish_job",
    sourceId: jobId,
  });
}

export function notifyTargetPaused(userId: number, targetName: string, targetId: number) {
  return createNotification({
    userId,
    title: `监控已暂停: ${targetName}`,
    body: "连续 3 次刷新失败，已自动暂停",
    level: "error",
    sourceType: "target",
    sourceId: targetId,
  });
}
