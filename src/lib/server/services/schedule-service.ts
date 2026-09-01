/**
 * 智能排期服务（AI Agent 平台 D-01）
 *
 * 规则版推荐（已确认决策 1：单账号每日 ≤3 条）：
 *   账号历史发布时段互动统计 → 取互动高峰时段 → 满足约束生成推荐排期
 * 约束：
 *   - 单账号每日 ≤3 条
 *   - 同类目间隔 ≥2 小时（统一按所有推荐槽位间隔 ≥2h 处理）
 *   - 库存缓冲 ≥3 条（已排期待发布 ≥3 时不再推荐）
 */
import { prisma } from "../core/db";
import { formatDateTime, shanghaiNow } from "../core/time";

/** 单条时段统计记录（纯函数输入） */
export interface HourEngagementRecord {
  hour: number; // 0-23
  engagement: number;
}

/** 时段聚合结果 */
export interface HourScore {
  hour: number;
  avgEngagement: number;
  count: number;
}

/** 按小时聚合平均互动量（纯函数，可单测） */
export function aggregateHourScores(records: HourEngagementRecord[]): HourScore[] {
  const buckets = new Map<number, { sum: number; count: number }>();
  for (const record of records) {
    if (record.hour < 0 || record.hour > 23) continue;
    const bucket = buckets.get(record.hour) ?? { sum: 0, count: 0 };
    bucket.sum += record.engagement;
    bucket.count += 1;
    buckets.set(record.hour, bucket);
  }
  return [...buckets.entries()]
    .map(([hour, bucket]) => ({ hour, avgEngagement: Math.round(bucket.sum / bucket.count), count: bucket.count }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement);
}

/** 默认活跃时段（无历史数据时兜底） */
export const DEFAULT_HOURS = [20, 10];

/** 从高分时段中挑选推荐时段：数量上限 + 间隔约束（纯函数，可单测） */
export function pickTopHours(
  scores: HourScore[],
  options: { count?: number; minGap?: number; occupiedHours?: number[] } = {},
): HourScore[] {
  const count = Math.max(1, Math.min(options.count ?? 3, 3)); // 单账号每日 ≤3 条
  const minGap = options.minGap ?? 2; // 同类目间隔 ≥2 小时
  const occupied = new Set(options.occupiedHours ?? []);
  const picked: HourScore[] = [];
  const ordered = [...scores].sort((a, b) => b.avgEngagement - a.avgEngagement || a.hour - b.hour);
  for (const score of ordered) {
    if (occupied.has(score.hour)) continue;
    if (picked.some((item) => Math.abs(item.hour - score.hour) < minGap)) continue;
    picked.push(score);
    if (picked.length >= count) break;
  }
  return picked;
}

/** 库存缓冲：待发布（pending/scheduled/pending_approval）数量 */
export async function pendingPublishCount(userId: number, platformAccountId: number): Promise<number> {
  return prisma.publishJob.count({
    where: {
      userId,
      platformAccountId,
      status: { in: ["pending", "pending_approval", "scheduled"] },
    },
  });
}

export interface ScheduleSlot {
  date: string; // YYYY-MM-DD
  hour: number;
  reason: string;
}

/**
 * 生成推荐排期（未来 N 天，每天最多 3 个槽位，间隔 ≥2h）
 * 无历史数据时使用默认活跃时段；库存不足时停止推荐
 */
export async function recommendSchedules(options: {
  userId: number;
  platformAccountId: number;
  days?: number;
}): Promise<{ slots: ScheduleSlot[]; bufferRemaining: number; reason: string }> {
  const { userId, platformAccountId, days = 3 } = options;
  const account = await prisma.platformAccount.findFirst({ where: { id: platformAccountId, userId } });
  if (!account) throw new Error("发布账号不存在");

  // 历史发布时段互动统计：publish_jobs.publishedAt 小时 × 对应笔记互动量
  const publishedJobs = await prisma.publishJob.findMany({
    where: { userId, platformAccountId, publishedAt: { not: null } },
    orderBy: { publishedAt: "asc" },
    take: 200,
  });
  const records: HourEngagementRecord[] = [];
  for (const job of publishedJobs) {
    if (!job.publishedAt) continue;
    const engagement = await noteEngagementForJob(job.externalNoteId, userId);
    records.push({ hour: job.publishedAt.getUTCHours(), engagement }); // naive 约定：UTC 字段即上海墙钟小时
  }

  const scores = aggregateHourScores(records);
  const source =
    scores.length > 0
      ? `历史 ${publishedJobs.length} 条发布数据互动高峰时段`
      : "无历史发布数据，使用平台通用活跃时段";

  const now = shanghaiNow();
  const slots: ScheduleSlot[] = [];
  let bufferRemaining = 3 - (await pendingPublishCount(userId, platformAccountId));

  for (let dayOffset = 0; dayOffset < days && bufferRemaining > 0; dayOffset++) {
    // 上海日期零点（UTC 字段即墙钟时间，与 naive 约定一致）
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, 0, 0, 0));
    // 当天已排期/待发布的时段（约束：不重复推荐已占用时段）
    const occupiedRows = await prisma.publishJob.findMany({
      where: {
        userId,
        platformAccountId,
        status: { in: ["pending", "pending_approval", "scheduled"] },
        scheduledAt: {
          gte: dayStart,
          lt: new Date(dayStart.getTime() + 24 * 3600 * 1000),
        },
      },
      select: { scheduledAt: true },
    });
    // 同日已占用时段（pickTopHours 内部同时保证同日槽位间隔 ≥2h）
    const occupied = new Set<number>(occupiedRows.map((row) => row.scheduledAt?.getUTCHours() ?? -1));

    const base = scores.length > 0 ? scores : DEFAULT_HOURS.map((hour) => ({ hour, avgEngagement: 0, count: 0 }));
    const picked = pickTopHours(base, { count: Math.min(3, bufferRemaining), minGap: 2, occupiedHours: [...occupied] });

    for (const score of picked) {
      if (dayOffset === 0 && score.hour <= now.getUTCHours()) continue; // 今日已过时段不推荐
      const date = `${dayStart.getUTCFullYear()}-${String(dayStart.getUTCMonth() + 1).padStart(2, "0")}-${String(dayStart.getUTCDate()).padStart(2, "0")}`;
      slots.push({
        date,
        hour: score.hour,
        reason: score.count > 0 ? `${source}，该时段历史平均互动 ${score.avgEngagement}` : source,
      });
      bufferRemaining -= 1;
      if (bufferRemaining <= 0) break;
    }
  }

  return {
    slots,
    bufferRemaining: Math.max(0, bufferRemaining),
    reason: bufferRemaining <= 0 ? "待发布内容已达库存缓冲上限（3 条），建议先发布后再排期" : source,
  };
}

/** 根据发布任务的 externalNoteId 查笔记互动量（无匹配返回 0） */
async function noteEngagementForJob(externalNoteId: string, userId: number): Promise<number> {
  if (!externalNoteId) return 0;
  const note = await prisma.note.findFirst({ where: { userId, platform: "xhs", noteId: externalNoteId } });
  if (!note) return 0;
  const raw = (note.rawJson ?? {}) as Record<string, unknown>;
  const interact = (raw.interact_info ?? {}) as Record<string, unknown>;
  const likes = Number(interact.liked_count ?? interact.likes ?? 0) || 0;
  const collects = Number(interact.collected_count ?? interact.collects ?? 0) || 0;
  const comments = Number(interact.comment_count ?? interact.comments ?? 0) || 0;
  return likes + collects + comments;
}

/** 将推荐槽位落库（返回持久化的推荐列表） */
export async function saveScheduleSlots(options: {
  userId: number;
  platformAccountId: number;
  slots: ScheduleSlot[];
}): Promise<Array<Record<string, unknown>>> {
  const { userId, platformAccountId, slots } = options;
  const created = await prisma.$transaction(
    slots.map((slot) =>
      prisma.scheduleSuggestion.create({
        data: {
          userId,
          platformAccountId,
          suggestedAt: parseSlotDate(slot.date, slot.hour),
          reason: slot.reason,
          accepted: false,
          createdAt: shanghaiNow(),
        },
      }),
    ),
  );
  return created.map(serializeScheduleSuggestion);
}

/** 解析槽位为上海时区 naive datetime（UTC 字段 = 墙钟时间，与 parseNaiveDateTime 约定一致） */
export function parseSlotDate(date: string, hour: number): Date {
  return new Date(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
}

export function serializeScheduleSuggestion(suggestion: {
  id: number;
  platformAccountId: number;
  suggestedAt: Date | null;
  reason: string;
  accepted: boolean;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: suggestion.id,
    platform_account_id: suggestion.platformAccountId,
    suggested_at: suggestion.suggestedAt ? formatDateTime(suggestion.suggestedAt) : null,
    reason: suggestion.reason,
    accepted: suggestion.accepted,
    created_at: formatDateTime(suggestion.createdAt),
  };
}
