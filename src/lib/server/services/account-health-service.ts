/**
 * 账号健康诊断服务（AI Agent 平台 A-03）
 *
 * 规则打分（0-100）：Cookie 有效性 40% + 发布稳定性 30% + 内容互动水平 30%
 * 等级：≥80 健康 / ≥60 一般 / ≥40 需关注 / <40 风险
 */
import { prisma } from "../core/db";
import { shanghaiNow } from "../core/time";

// ---------- 纯函数（可单测）----------

export interface HealthMetrics {
  hasCookie: boolean; // 是否绑定 Cookie
  cookieValid: boolean; // Cookie 是否有效（未巡检视为有效，因子中注明）
  published7d: number; // 近 7 天发布数
  published30d: number; // 近 30 天发布数
  avgEngagement: number; // 已发布内容平均互动
}

export interface HealthResult {
  score: number;
  level: string; // healthy/normal/attention/risk
  factors: string[]; // 扣分/提示项
}

/** 计算账号健康分（纯函数） */
export function computeAccountHealth(metrics: HealthMetrics): HealthResult {
  const factors: string[] = [];
  let score = 0;

  // 1) Cookie 有效性（40 分）
  if (!metrics.hasCookie) {
    factors.push("未绑定 Cookie，无法采集与发布");
  } else if (!metrics.cookieValid) {
    factors.push("Cookie 已失效，请重新登录");
    score += 15;
  } else {
    factors.push("Cookie 有效");
    score += 40;
  }

  // 2) 发布稳定性（30 分）：近 30 天 8-15 条为健康节奏（单账号 ≤3 条/日）
  if (metrics.published30d >= 8) {
    score += 30;
    factors.push(`近 30 天发布 ${metrics.published30d} 条，节奏稳定`);
  } else if (metrics.published30d >= 4) {
    score += 20;
    factors.push(`近 30 天发布 ${metrics.published30d} 条，节奏一般（建议 ≥8 条）`);
  } else if (metrics.published30d >= 1) {
    score += 10;
    factors.push(`近 30 天仅发布 ${metrics.published30d} 条，发布频率偏低`);
  } else {
    factors.push("近 30 天无发布记录");
  }

  // 3) 内容互动水平（30 分）
  if (metrics.avgEngagement >= 500) {
    score += 30;
    factors.push(`平均互动 ${metrics.avgEngagement}，内容表现优秀`);
  } else if (metrics.avgEngagement >= 100) {
    score += 20;
    factors.push(`平均互动 ${metrics.avgEngagement}，表现良好`);
  } else if (metrics.avgEngagement >= 20) {
    score += 10;
    factors.push(`平均互动 ${metrics.avgEngagement}，互动偏低（建议优化选题与标题）`);
  } else if (metrics.published30d > 0) {
    factors.push("已发布内容互动极低，需复盘内容方向");
  } else {
    factors.push("暂无互动数据");
  }

  const level = score >= 80 ? "healthy" : score >= 60 ? "normal" : score >= 40 ? "attention" : "risk";
  return { score, level, factors };
}

/** 序列化等级标签 */
export const HEALTH_LEVEL_LABEL: Record<string, string> = {
  healthy: "健康",
  normal: "一般",
  attention: "需关注",
  risk: "风险",
};

// ---------- 账号诊断 ----------

/** 诊断当前用户全部小红书账号 */
export async function diagnoseAccounts(userId: number): Promise<Array<Record<string, unknown>>> {
  const accounts = await prisma.platformAccount.findMany({
    where: { userId, platform: "xhs" },
    orderBy: { id: "asc" },
  });
  const now = shanghaiNow();
  const days7Ago = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const days30Ago = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

  const results: Array<Record<string, unknown>> = [];
  for (const account of accounts) {
    const cookieVersion = await prisma.accountCookieVersion.findFirst({
      where: { platformAccountId: account.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const hasCookie = Boolean(cookieVersion);
    const cookieValid = hasCookie && account.status !== "expired" && account.status !== "invalid";

    // 发布统计（publish_jobs.publishedAt 为 naive 上海时间）
    const publishedJobs = await prisma.publishJob.findMany({
      where: { userId, platformAccountId: account.id, status: "published", publishedAt: { not: null } },
      select: { publishedAt: true, externalNoteId: true },
    });
    const published7d = publishedJobs.filter((job) => job.publishedAt && job.publishedAt >= days7Ago).length;
    const published30d = publishedJobs.filter((job) => job.publishedAt && job.publishedAt >= days30Ago).length;

    // 平均互动（按 externalNoteId 匹配内容库笔记）
    let engagementSum = 0;
    let engagementCount = 0;
    for (const job of publishedJobs) {
      if (!job.externalNoteId) continue;
      const note = await prisma.note.findFirst({ where: { userId, platform: "xhs", noteId: job.externalNoteId } });
      if (!note) continue;
      const raw = (note.rawJson ?? {}) as Record<string, unknown>;
      const interact = (raw.interact_info ?? {}) as Record<string, unknown>;
      const likes = Number(interact.liked_count ?? interact.likes ?? 0) || 0;
      const collects = Number(interact.collected_count ?? interact.collects ?? 0) || 0;
      const comments = Number(interact.comment_count ?? interact.comments ?? 0) || 0;
      engagementSum += likes + collects + comments;
      engagementCount += 1;
    }

    const result = computeAccountHealth({
      hasCookie,
      cookieValid,
      published7d,
      published30d,
      avgEngagement: engagementCount ? Math.round(engagementSum / engagementCount) : 0,
    });
    results.push({
      account_id: account.id,
      nickname: account.nickname || "(未命名)",
      sub_type: account.subType ?? "",
      status: account.status,
      score: result.score,
      level: result.level,
      level_label: HEALTH_LEVEL_LABEL[result.level] ?? result.level,
      factors: result.factors,
      stats: {
        published_7d: published7d,
        published_30d: published30d,
        avg_engagement: engagementCount ? Math.round(engagementSum / engagementCount) : 0,
      },
    });
  }
  return results;
}
