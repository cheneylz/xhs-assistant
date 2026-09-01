/**
 * 热点洞察服务（AI Agent 平台 P-01）
 *
 * 全站热点采集管线（逆向采集估算，已确认决策 2）：
 *   种子词（关键词组 + 上期榜单）→ PC 搜索（限流器内）→ 热度分计算 → TOP50 快照落库
 * 热度分 = 搜索量×0.3 + 笔记增量×0.3 + 互动增量×0.4（PRD 公式落地）
 *
 * 说明：无公开热点 API，搜索结果为近似估算，榜单前端标注「估算」；
 * 数据源层预留第三方（千瓜）可替换。
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../core/db";
import { decryptText } from "../core/security";
import { shanghaiNow, formatDateTime } from "../core/time";
import { dataItems, normalizeSearchItem } from "./crawl-normalizers";

/** PC 搜索适配器接口（worker/路由注入，避免服务层直接依赖 SDK 类） */
export interface HotTopicPcAdapter {
  searchNote: (keyword: string, page?: number) => Promise<[boolean, string, unknown]>;
}

/** 搜索结果的互动量（赞+藏+评） */
export function itemEngagement(item: Record<string, unknown>): number {
  const likes = Number(item.likes ?? 0) || 0;
  const collects = Number(item.collects ?? 0) || 0;
  const comments = Number(item.comments ?? 0) || 0;
  return likes + collects + comments;
}

// ---------- 纯函数（可单测）----------

/** 关键词分类（按特征词映射，未命中为「其他」） */
const CATEGORY_KEYWORDS: Array<[string, string[]]> = [
  ["美妆", ["妆", "护肤", "口红", "粉底", "面膜", "香水", "美甲", "防晒", "精华"]],
  ["穿搭", ["穿搭", "ootd", "衣服", "裙子", "裤子", "外套", "显瘦", "通勤"]],
  ["美食", ["美食", "探店", "食谱", "好吃", "早餐", "咖啡", "奶茶", "火锅", "蛋糕"]],
  ["旅行", ["旅行", "旅游", "攻略", "民宿", "景点", "打卡", "出境游"]],
  ["家居", ["家居", "装修", "收纳", "租房", "家具", "改造"]],
  ["知识", ["知识", "学习", "干货", "教程", "职场", "考研", "读书"]],
];

export function classifyKeyword(keyword: string): string {
  const text = keyword.toLowerCase();
  for (const [category, words] of CATEGORY_KEYWORDS) {
    if (words.some((word) => text.includes(word))) return category;
  }
  return "其他";
}

/** 热度分 = 搜索量×0.3 + 笔记增量×0.3 + 互动增量×0.4（整数） */
export function computeHeatScore(searchCount: number, noteDelta: number, interactDelta: number): number {
  return Math.round(searchCount * 0.3 + noteDelta * 0.3 + interactDelta * 0.4);
}

// ---------- 采集管线 ----------

export interface HotTopicEntry {
  keyword: string;
  category: string;
  heatScore: number;
  searchCount: number;
  engagement: number;
  noteDelta: number;
  interactDelta: number;
  riseSpeed: number;
  rank: number;
}

/** 查询用户最新一批快照（按批次时间倒序取最近一批） */
export async function latestHotTopicBatch(userId: number, category?: string): Promise<{ snapAt: Date | null; items: HotTopicEntry[] }> {
  const latest = await prisma.hotTopic.findFirst({
    where: { userId },
    orderBy: { snapAt: "desc" },
    select: { snapAt: true },
  });
  if (!latest) return { snapAt: null, items: [] };
  const rows = await prisma.hotTopic.findMany({
    where: { userId, snapAt: latest.snapAt, ...(category ? { category } : {}) },
    orderBy: { rank: "asc" },
    take: 50,
  });
  return {
    snapAt: latest.snapAt,
    items: rows.map((row) => ({
      keyword: row.keyword,
      category: row.category,
      heatScore: row.heatScore,
      searchCount: row.searchCount,
      engagement: row.engagement,
      noteDelta: row.noteDelta,
      interactDelta: row.interactDelta,
      riseSpeed: row.riseSpeed,
      rank: row.rank,
    })),
  };
}

/** 关键词热度历史（跨批次趋势，供趋势图） */
export async function hotTopicHistory(userId: number, keyword: string, limit = 12): Promise<Array<Record<string, unknown>>> {
  const rows = await prisma.hotTopic.findMany({
    where: { userId, keyword },
    orderBy: { snapAt: "desc" },
    take: Math.min(Math.max(limit, 1), 100),
  });
  return rows.reverse().map((row) => ({
    snap_at: formatDateTime(row.snapAt),
    heat_score: row.heatScore,
    search_count: row.searchCount,
    rise_speed: row.riseSpeed,
    rank: row.rank,
  }));
}

/** 收集用户种子词（关键词组优先 + 上期榜单 TOP10 补充，去重，最多 15 个） */
export async function seedKeywords(userId: number, maxKeywords = 15): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];
  const groups = await prisma.keywordGroup.findMany({
    where: { userId, platform: "xhs" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  for (const group of groups) {
    const keywords = Array.isArray(group.keywords) ? (group.keywords as unknown[]).map(String) : [];
    for (const keyword of keywords) {
      const text = keyword.trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        result.push(text);
        if (result.length >= maxKeywords) return result;
      }
    }
  }
  // 补充上期榜单 TOP10（无关键词组时也能产出）
  const latest = await latestHotTopicBatch(userId);
  for (const entry of latest.items.slice(0, 10)) {
    if (!seen.has(entry.keyword)) {
      seen.add(entry.keyword);
      result.push(entry.keyword);
      if (result.length >= maxKeywords) break;
    }
  }
  return result;
}

/** 采集单用户的单批热点：搜索种子词 → 计算热度分 → TOP50 落库 */
export async function collectHotTopicsForUser(options: {
  userId: number;
  adapterFactory: (cookies: string) => HotTopicPcAdapter;
  keywordLimit?: number;
}): Promise<{ collected: number; snapshotTime: string | null; reason?: string }> {
  const { userId, adapterFactory, keywordLimit = 15 } = options;

  // 取 PC 账号 + 最新 Cookie；无账号直接跳过
  const account = await prisma.platformAccount.findFirst({
    where: { userId, platform: "xhs", subType: "pc" },
    orderBy: { id: "asc" },
  });
  if (!account) return { collected: 0, snapshotTime: null, reason: "未绑定 PC 账号，无法采集热点" };
  const cookieVersion = await prisma.accountCookieVersion.findFirst({
    where: { platformAccountId: account.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!cookieVersion) return { collected: 0, snapshotTime: null, reason: "PC 账号无有效 Cookie" };

  const keywords = await seedKeywords(userId, keywordLimit);
  if (!keywords.length) return { collected: 0, snapshotTime: null, reason: "无种子关键词，请先配置关键词组" };

  const adapter = adapterFactory(decryptText(cookieVersion.encryptedCookies));
  const now = shanghaiNow();

  // 上一批次（用于增量计算）
  const prevBatch = await prisma.hotTopic.findFirst({
    where: { userId, snapAt: { lt: now } },
    orderBy: { snapAt: "desc" },
    select: { snapAt: true },
  });
  const prevRows = prevBatch
    ? await prisma.hotTopic.findMany({ where: { userId, snapAt: prevBatch.snapAt } })
    : [];
  const prevByKeyword = new Map(prevRows.map((row) => [row.keyword, row]));

  const entries: HotTopicEntry[] = [];
  for (const keyword of keywords) {
    try {
      const [success, , raw] = await adapter.searchNote(keyword, 1);
      if (!success) continue;
      const items = dataItems(raw).map(normalizeSearchItem);
      const noteCount = items.length;
      const engagement = items
        .map(itemEngagement)
        .sort((a, b) => b - a)
        .slice(0, 5)
        .reduce((sum, value) => sum + value, 0);
      const prev = prevByKeyword.get(keyword);
      // 绝对值为基线，跨批次增量 = 本批绝对值 - 上批绝对值（首批次以绝对值为增量，保证首榜可排序）
      const noteDelta = prev ? Math.max(0, noteCount - prev.searchCount) : noteCount;
      const interactDelta = prev ? Math.max(0, engagement - prev.engagement) : engagement;
      const searchCount = Math.max(noteCount, prev?.searchCount ?? 0);
      const heatScore = computeHeatScore(searchCount, noteDelta, interactDelta);
      const riseSpeed = prev && prev.heatScore > 0 ? Math.round(((heatScore - prev.heatScore) / prev.heatScore) * 100) : 0;
      entries.push({ keyword, category: classifyKeyword(keyword), heatScore, searchCount, engagement, noteDelta, interactDelta, riseSpeed, rank: 0 });
    } catch (error) {
      console.warn(`[hot-topics] 关键词「${keyword}」采集失败: ${(error as Error).message}`);
    }
  }

  if (!entries.length) return { collected: 0, snapshotTime: null, reason: "本次采集无有效结果" };

  // 排序取 TOP50
  const ranked = entries
    .sort((a, b) => b.heatScore - a.heatScore || b.searchCount - a.searchCount)
    .slice(0, 50)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));

  await prisma.$transaction([
    prisma.hotTopic.createMany({
      data: ranked.map(
        (entry): Prisma.HotTopicCreateManyInput => ({
          userId,
          keyword: entry.keyword,
          category: entry.category,
          heatScore: entry.heatScore,
          searchCount: entry.searchCount,
          engagement: entry.engagement,
          noteDelta: entry.noteDelta,
          interactDelta: entry.interactDelta,
          riseSpeed: entry.riseSpeed,
          rank: entry.rank,
          snapAt: now,
        }),
      ),
    }),
    // 清理 7 天前的快照
    prisma.hotTopic.deleteMany({
      where: { userId, snapAt: { lt: new Date(now.getTime() - 7 * 24 * 3600 * 1000) } },
    }),
  ]);

  return { collected: ranked.length, snapshotTime: formatDateTime(now) };
}

/** 全部用户的定时热点采集（worker 30 分钟任务） */
export async function runHotTopicsForAllUsers(options: {
  adapterFactory: (cookies: string) => HotTopicPcAdapter;
}): Promise<{ processed: number; collected: number; skipped: number }> {
  const accounts = await prisma.platformAccount.findMany({
    where: { platform: "xhs", subType: "pc" },
    select: { userId: true },
    distinct: ["userId"],
    orderBy: { userId: "asc" },
  });
  let collected = 0;
  let skipped = 0;
  for (const account of accounts) {
    try {
      const result = await collectHotTopicsForUser({ userId: account.userId, adapterFactory: options.adapterFactory });
      collected += result.collected;
      if (!result.collected) skipped += 1;
    } catch (error) {
      console.warn(`[hot-topics] 用户 ${account.userId} 采集失败: ${(error as Error).message}`);
      skipped += 1;
    }
  }
  return { processed: accounts.length, collected, skipped };
}
