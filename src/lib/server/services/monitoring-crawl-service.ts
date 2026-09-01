/**
 * 监控爬取服务（对应原版 backend/app/services/monitoring_crawl_service.py）
 */
import { prisma } from "../core/db";
import { decryptText } from "../core/security";
import { formatDateTime, shanghaiNow } from "../core/time";
import { getRateLimiter } from "./rate-limiter";
import { notifyTargetPaused } from "./notification-service";
import { noteMetrics, serializeMonitoringNote } from "./scheduler-service";
import { dataItems, normalizeDetailPayload, normalizeSearchItem } from "./crawl-normalizers";
import { saveNormalizedNotes } from "../../../app/api/xhs/crawl/shared";
import type { Prisma } from "@prisma/client";

export interface MonitoringTargetLike {
  id: number;
  userId: number;
  platform: string;
  targetType: string;
  name: string;
  value: string;
  status: string;
  config: unknown;
  lastRefreshedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  platformAccountId: number | null;
  crawlIntervalMinutes: number;
  consecutiveFailures: number;
  lastCrawlError: string | null;
}

export function serializeTarget(target: MonitoringTargetLike): Record<string, unknown> {
  return {
    id: target.id,
    platform: target.platform,
    target_type: target.targetType,
    name: target.name,
    value: target.value,
    status: target.status,
    config: (target.config as Record<string, unknown> | null) ?? {},
    last_refreshed_at: target.lastRefreshedAt ? formatDateTime(target.lastRefreshedAt) : null,
    created_at: formatDateTime(target.createdAt),
    updated_at: formatDateTime(target.updatedAt),
    platform_account_id: target.platformAccountId,
    crawl_interval_minutes: target.crawlIntervalMinutes,
    consecutive_failures: target.consecutiveFailures,
    last_crawl_error: target.lastCrawlError,
  };
}

export function serializeSnapshot(snapshot: { id: number; targetId: number; payload: unknown; createdAt: Date }): Record<string, unknown> {
  return {
    id: snapshot.id,
    target_id: snapshot.targetId,
    payload: (snapshot.payload as Record<string, unknown> | null) ?? {},
    created_at: formatDateTime(snapshot.createdAt),
  };
}

function noteMatchesTargetValue(note: { noteId: string; title: string; content: string; authorName: string; rawJson: unknown }, needle: string): boolean {
  if (!needle) return false;
  const rawText = JSON.stringify(note.rawJson ?? {});
  return [note.noteId, note.title, note.content, note.authorName, rawText].join("\n").toLowerCase().includes(needle);
}

/** 查找可用的 PC 账号（对应 _find_pc_account） */
async function findPcAccount(target: { userId: number; platformAccountId: number | null }): Promise<{ id: number; userId: number; platform: string; subType: string | null; status: string } | null> {
  if (target.platformAccountId) {
    const account = await prisma.platformAccount.findUnique({ where: { id: target.platformAccountId } });
    if (account && account.userId === target.userId && account.subType === "pc" && account.status === "active") {
      return account;
    }
  }
  return prisma.platformAccount.findFirst({
    where: { userId: target.userId, platform: "xhs", subType: "pc", status: "active" },
    orderBy: { id: "asc" },
  });
}

/** 解密账号 Cookie（对应 _decrypt_cookies） */
async function decryptCookies(accountId: number): Promise<string | null> {
  const version = await prisma.accountCookieVersion.findFirst({
    where: { platformAccountId: accountId },
    orderBy: { createdAt: "desc" },
  });
  if (!version) return null;
  const raw = decryptText(version.encryptedCookies);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.entries(parsed as Record<string, unknown>)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    }
  } catch {
    // 非 JSON，按原始字符串返回
  }
  return raw;
}

/** 错误分类（对应 _classify_error） */
function classifyError(error: Error): string {
  const msg = error.message.toLowerCase();
  if (["proxy", "connect", "timeout", "network"].some((k) => msg.includes(k))) return "network";
  if (["cookie", "auth", "login", "expired", "401"].some((k) => msg.includes(k))) return "auth_expired";
  if (["rate", "429", "频繁"].some((k) => msg.includes(k))) return "rate_limit";
  return "adapter";
}

/** 按目标类型爬取（对应 _crawl_for_target） */
async function crawlForTarget(
  adapter: { searchNote: (kw: string, page?: number) => Promise<[boolean, string, unknown]>; getUserNotes: (url: string) => Promise<[boolean, string, unknown]>; getNoteInfo: (url: string) => Promise<[boolean, string, unknown]> },
  target: { targetType: string; value: string },
): Promise<[boolean, Array<Record<string, unknown>>, string]> {
  try {
    if (target.targetType === "keyword" || target.targetType === "brand") {
      const [success, message, raw] = await adapter.searchNote(target.value, 1);
      if (!success) return [false, [], message || "search failed"];
      return [true, dataItems(raw).map(normalizeSearchItem), ""];
    }
    if (target.targetType === "account") {
      const [success, message, raw] = await adapter.getUserNotes(target.value);
      if (!success) return [false, [], message || "user notes failed"];
      return [true, dataItems(raw).map(normalizeSearchItem), ""];
    }
    if (target.targetType === "note_url") {
      const [success, message, raw] = await adapter.getNoteInfo(target.value);
      if (!success) return [false, [], message || "note detail failed"];
      return [true, [normalizeDetailPayload((raw ?? {}) as Record<string, unknown>)], ""];
    }
    return [false, [], `unsupported target_type: ${target.targetType}`];
  } catch (error) {
    return [false, [], (error as Error).message];
  }
}

/** 生成快照（对应 _make_snapshot） */
async function makeSnapshot(target: { id: number; value: string }, userId: number): Promise<{ id: number; targetId: number; payload: unknown; createdAt: Date }> {
  const notes = await prisma.note.findMany({
    where: { userId, platform: "xhs" },
    orderBy: { createdAt: "desc" },
  });
  const needle = target.value.trim().toLowerCase();
  const matched = notes.filter((note) => noteMatchesTargetValue(note, needle)).sort((a, b) => noteMetrics(b).engagement - noteMetrics(a).engagement);
  const payload = {
    matched_count: matched.length,
    total_engagement: matched.reduce((sum, note) => sum + noteMetrics(note).engagement, 0),
    top_notes: matched.slice(0, 10).map(serializeMonitoringNote),
  };
  return prisma.monitoringSnapshot.create({
    data: { targetId: target.id, payload: payload as unknown as Prisma.InputJsonValue, createdAt: shanghaiNow() },
  });
}

/** 执行监控刷新（对应 execute_monitoring_refresh） */
export async function executeMonitoringRefresh(options: {
  targetId: number;
  userId: number;
  adapterFactory?: (cookies: string) => {
    searchNote: (kw: string, page?: number) => Promise<[boolean, string, unknown]>;
    getUserNotes: (url: string) => Promise<[boolean, string, unknown]>;
    getNoteInfo: (url: string) => Promise<[boolean, string, unknown]>;
  };
  checkRateLimit?: boolean;
}): Promise<Record<string, unknown>> {
  const { targetId, userId, checkRateLimit = true } = options;
  const now = shanghaiNow();
  const target = await prisma.monitoringTarget.findUnique({ where: { id: targetId } });
  if (!target) throw new Error("Monitoring target not found");

  const parentTask = await prisma.task.create({
    data: {
      userId,
      platform: "xhs",
      taskType: "monitoring_crawl",
      status: "running",
      startedAt: now,
      payload: { target_id: target.id, target_type: target.targetType, value: target.value },
      createdAt: now,
    },
  });

  const finishFlow = async (options: {
    taskStatus: string;
    errorType?: string | null;
    error?: string;
    payloadExtra?: Record<string, unknown>;
    consecutiveFailures: number;
    lastCrawlError: string | null;
  }) => {
    const finishedAt = shanghaiNow();
    await prisma.task.update({
      where: { id: parentTask.id },
      data: {
        status: options.taskStatus,
        finishedAt,
        errorType: options.errorType ?? null,
        payload: { ...(parentTask.payload as Record<string, unknown>), ...options.payloadExtra, ...(options.error ? { error: options.error } : {}) } as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.monitoringTarget.update({
      where: { id: target.id },
      data: {
        consecutiveFailures: options.consecutiveFailures,
        lastCrawlError: options.lastCrawlError,
        lastRefreshedAt: now,
        updatedAt: finishedAt,
      },
    });
    const snapshot = await makeSnapshot(target, userId);
    const updatedTarget = await prisma.monitoringTarget.findUnique({ where: { id: target.id } });
    const completedTask = await prisma.task.findUnique({ where: { id: parentTask.id } });
    return {
      target: serializeTarget(updatedTarget!),
      task: serializeTaskForMonitor(completedTask!),
      snapshot: serializeSnapshot(snapshot),
    };
  };

  // 查找 PC 账号
  const account = await findPcAccount(target);
  if (!account) {
    return finishFlow({ taskStatus: "failed", errorType: "validation", error: "No active PC account", consecutiveFailures: target.consecutiveFailures + 1, lastCrawlError: "No active PC account" });
  }

  // 解密 Cookie
  const cookies = await decryptCookies(account.id);
  if (!cookies) {
    return finishFlow({ taskStatus: "failed", errorType: "auth_expired", error: "No valid cookies", consecutiveFailures: target.consecutiveFailures + 1, lastCrawlError: "No valid cookies" });
  }

  // 限流
  if (checkRateLimit) {
    const allowed = await getRateLimiter().allow(account.id);
    if (!allowed) {
      return finishFlow({
        taskStatus: "completed",
        payloadExtra: { skipped_rate_limit: true, account_id: account.id },
        consecutiveFailures: target.consecutiveFailures,
        lastCrawlError: target.lastCrawlError,
      });
    }
  }

  const adapter = options.adapterFactory
    ? options.adapterFactory(cookies)
    : await defaultAdapter(cookies);
  const [ok, normalizedItems, errorMsg] = await crawlForTarget(adapter, target);

  if (ok && normalizedItems.length) {
    await saveNormalizedNotes(account, normalizedItems);
  }

  const snapshot = await makeSnapshot(target, userId);
  const snapshotPayload = (snapshot.payload as Record<string, unknown> | null) ?? {};
  if (ok) {
    const finishedAt = shanghaiNow();
    await prisma.task.update({
      where: { id: parentTask.id },
      data: {
        status: "completed",
        finishedAt,
        payload: {
          ...(parentTask.payload as Record<string, unknown>),
          crawled_count: normalizedItems.length,
          snapshot_id: snapshot.id,
          matched_count: snapshotPayload.matched_count ?? 0,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.monitoringTarget.update({
      where: { id: target.id },
      data: { consecutiveFailures: 0, lastCrawlError: null, lastRefreshedAt: shanghaiNow(), updatedAt: finishedAt },
    });
  } else {
    const errorType = classifyError(new Error(errorMsg));
    const finishedAt = shanghaiNow();
    await prisma.task.update({
      where: { id: parentTask.id },
      data: {
        status: "failed",
        finishedAt,
        errorType,
        payload: { ...(parentTask.payload as Record<string, unknown>), error: errorMsg } as unknown as Prisma.InputJsonValue,
      },
    });
    const nextFailures = target.consecutiveFailures + 1;
    const data: Prisma.MonitoringTargetUpdateInput = {
      consecutiveFailures: nextFailures,
      lastCrawlError: errorMsg,
      lastRefreshedAt: shanghaiNow(),
      updatedAt: finishedAt,
    };
    if (nextFailures >= 3) {
      data.status = "paused";
      await notifyTargetPaused(userId, target.name, target.id);
    }
    await prisma.monitoringTarget.update({ where: { id: target.id }, data });
  }

  const updatedTarget = await prisma.monitoringTarget.findUnique({ where: { id: target.id } });
  const completedTask = await prisma.task.findUnique({ where: { id: parentTask.id } });
  return {
    target: serializeTarget(updatedTarget!),
    task: serializeTaskForMonitor(completedTask!),
    snapshot: serializeSnapshot(snapshot),
  };
}

async function defaultAdapter(cookies: string) {
  const { XhsPcApiAdapter } = await import("@/lib/server/xhs/adapters/pc-api-adapter");
  return new XhsPcApiAdapter(cookies) as unknown as {
    searchNote: (kw: string, page?: number) => Promise<[boolean, string, unknown]>;
    getUserNotes: (url: string) => Promise<[boolean, string, unknown]>;
    getNoteInfo: (url: string) => Promise<[boolean, string, unknown]>;
  };
}

/** 最小任务序列化（避免循环依赖，字段与原版 serialize_task 一致） */
function serializeTaskForMonitor(task: {
  id: number;
  platform: string;
  taskType: string;
  status: string;
  progress: number;
  payload: unknown;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorType: string | null;
  retryCount: number;
  maxRetries: number;
  parentTaskId: number | null;
}): Record<string, unknown> {
  let durationMs: number | null = null;
  if (task.startedAt && task.finishedAt) {
    durationMs = Math.floor(task.finishedAt.getTime() - task.startedAt.getTime());
  }
  return {
    id: task.id,
    platform: task.platform,
    task_type: task.taskType,
    status: task.status,
    progress: task.progress,
    payload: (task.payload as Record<string, unknown> | null) ?? {},
    created_at: formatDateTime(task.createdAt),
    started_at: task.startedAt ? formatDateTime(task.startedAt) : null,
    finished_at: task.finishedAt ? formatDateTime(task.finishedAt) : null,
    duration_ms: durationMs,
    error_type: task.errorType,
    retry_count: task.retryCount,
    max_retries: task.maxRetries,
    parent_task_id: task.parentTaskId,
  };
}
