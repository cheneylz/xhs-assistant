/**
 * 爆款拆解服务（AI Agent 平台 P-02）
 *
 * 管线：搜索目标关键词 → 过滤低粉高互动（赞藏评>1000）笔记 →
 *       LLM 结构化拆解（标题公式/封面要素/正文框架/互动引导）→ 报告落库
 *
 * 说明：搜索卡片通常不返回粉丝数，以互动量阈值为主筛选；
 *       PRD 的「低粉」维度在原始 JSON 含粉丝数时顺带过滤（<5000），否则忽略。
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../core/db";
import { decryptText } from "../core/security";
import { extractJsonObject } from "../core/json-extract";
import { formatDateTime, shanghaiNow } from "../core/time";
import { renderPrompt } from "../../../prompts/loader";
import { dataItems, normalizeSearchItem } from "./crawl-normalizers";
import type { TextClientLike } from "./review-service";
import type { ModelConfigLike } from "./ai-service";
import { makeUsageLogger } from "./usage-service";
import { itemEngagement } from "./hot-topic-service";

/** 爆款筛选阈值：赞藏评 > 1000；低粉阈值 5000（原始 JSON 提供粉丝数时才过滤） */
export const EXPLOSION_ENGAGEMENT_THRESHOLD = 1000;
export const EXPLOSION_FOLLOWER_THRESHOLD = 5000;

export interface ExplosionPatterns {
  titlePatterns: string[];
  coverPatterns: string[];
  bodyPatterns: string[];
  engagePatterns: string[];
}

/** 解析 LLM 拆解输出（纯函数，可单测） */
export function parseExplosionPatterns(content: string): ExplosionPatterns {
  const payload = extractJsonObject<Record<string, unknown>>(content);
  const empty: ExplosionPatterns = { titlePatterns: [], coverPatterns: [], bodyPatterns: [], engagePatterns: [] };
  if (!payload) return empty;
  const pick = (key: string): string[] => {
    const value = payload[key];
    return Array.isArray(value) ? value.map(String).filter(Boolean).slice(0, 10) : [];
  };
  return {
    titlePatterns: pick("title_patterns"),
    coverPatterns: pick("cover_patterns"),
    bodyPatterns: pick("body_patterns"),
    engagePatterns: pick("engage_patterns"),
  };
}

/** 搜索接口适配器（与热点采集共用形态） */
export interface ExplorationSearchAdapter {
  searchNote: (keyword: string, page?: number) => Promise<[boolean, string, unknown]>;
}

/** 执行爆款拆解并落库 */
export async function analyzeExplosions(options: {
  userId: number;
  keyword: string;
  rangeDays?: number;
  adapterFactory: (cookies: string) => ExplorationSearchAdapter;
  textClient: TextClientLike;
  modelConfig: ModelConfigLike;
  apiKey: string;
}): Promise<{ report: Record<string, unknown> }> {
  const { userId, keyword, rangeDays = 7, adapterFactory, textClient, modelConfig, apiKey } = options;

  const account = await prisma.platformAccount.findFirst({
    where: { userId, platform: "xhs", subType: "pc" },
    orderBy: { id: "asc" },
  });
  if (!account) throw new Error("未绑定 PC 账号，无法执行爆款拆解");
  const cookieVersion = await prisma.accountCookieVersion.findFirst({
    where: { platformAccountId: account.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!cookieVersion) throw new Error("PC 账号无有效 Cookie");

  const adapter = adapterFactory(decryptText(cookieVersion.encryptedCookies));
  const [success, , raw] = await adapter.searchNote(keyword, 1);
  if (!success) throw new Error(`搜索「${keyword}」失败，请检查账号状态`);

  // 筛选爆款样本：互动量阈值为主，原始数据含粉丝数时叠加低粉过滤
  const samples = dataItems(raw)
    .map(normalizeSearchItem)
    .filter((item) => {
      if (itemEngagement(item) < EXPLOSION_ENGAGEMENT_THRESHOLD) return false;
      const rawItem = item.raw as Record<string, unknown> | undefined;
      const rawUser = rawItem?.user as Record<string, unknown> | undefined;
      const followerCount = Number(rawUser?.fans ?? 0);
      if (followerCount > 0 && followerCount >= EXPLOSION_FOLLOWER_THRESHOLD) return false;
      return true;
    })
    .sort((a, b) => itemEngagement(b) - itemEngagement(a))
    .slice(0, 10);

  if (!samples.length) throw new Error(`「${keyword}」未找到互动量 >${EXPLOSION_ENGAGEMENT_THRESHOLD} 的爆款样本，请更换关键词`);

  const sampleText = samples
    .map((item, index) => {
      const cover = item.cover_url ? `封面：${item.cover_url}` : "";
      return `${index + 1}. 标题：${item.title}\n正文摘录：${String(item.content ?? "").slice(0, 200)}${cover}\n互动：赞${item.likes} 藏${item.collects} 评${item.comments}`;
    })
    .join("\n\n");

  const content = await textClient.complete({
    modelConfig,
    apiKey,
    systemPrompt: renderPrompt("exploration.md", "explosion"),
    userPrompt: `分析范围：近 ${rangeDays} 天\n关键词：${keyword}\n\n爆款样本：\n${sampleText}`,
    temperature: 0.3,
    onUsage: makeUsageLogger(userId, modelConfig.modelName), // S-06 用量采集
  });
  const patterns = parseExplosionPatterns(content);

  const report = await prisma.explosionReport.create({
    data: {
      userId,
      keyword,
      rangeDays,
      titlePatterns: patterns.titlePatterns as Prisma.InputJsonValue,
      coverPatterns: patterns.coverPatterns as Prisma.InputJsonValue,
      bodyPatterns: patterns.bodyPatterns as Prisma.InputJsonValue,
      engagePatterns: patterns.engagePatterns as Prisma.InputJsonValue,
      sampleNotes: samples.map((item) => ({
        title: item.title,
        author: item.author_name,
        likes: item.likes,
        collects: item.collects,
        comments: item.comments,
        cover_url: item.cover_url,
        note_url: item.note_url, // 原贴链接（用于「查看原贴」跳转）
      })) as unknown as Prisma.InputJsonValue,
      createdAt: shanghaiNow(),
    },
  });
  return { report: serializeExplosionReport(report) };
}

/** 删除爆款拆解报告（仅限本人） */
export async function deleteExplosionReport(userId: number, reportId: number): Promise<void> {
  const report = await prisma.explosionReport.findFirst({ where: { id: reportId, userId } });
  if (!report) throw new Error("拆解报告不存在");
  await prisma.explosionReport.delete({ where: { id: reportId } });
}

/** 批量删除爆款拆解报告（仅限本人，返回实际删除条数） */
export async function deleteExplosionReports(userId: number, ids: number[]): Promise<number> {
  const result = await prisma.explosionReport.deleteMany({ where: { id: { in: ids }, userId } });
  return result.count;
}

/** 用户最近的爆款拆解报告列表（取最近 20 条） */
export async function listExplosionReports(userId: number, limit = 20): Promise<Array<Record<string, unknown>>> {
  const reports = await prisma.explosionReport.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 50),
  });
  return reports.map(serializeExplosionReport);
}

export function serializeExplosionReport(report: {
  id: number;
  keyword: string;
  rangeDays: number;
  titlePatterns: unknown;
  coverPatterns: unknown;
  bodyPatterns: unknown;
  engagePatterns: unknown;
  sampleNotes: unknown;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: report.id,
    keyword: report.keyword,
    range_days: report.rangeDays,
    title_patterns: Array.isArray(report.titlePatterns) ? report.titlePatterns : [],
    cover_patterns: Array.isArray(report.coverPatterns) ? report.coverPatterns : [],
    body_patterns: Array.isArray(report.bodyPatterns) ? report.bodyPatterns : [],
    engage_patterns: Array.isArray(report.engagePatterns) ? report.engagePatterns : [],
    sample_notes: Array.isArray(report.sampleNotes) ? report.sampleNotes : [],
    created_at: formatDateTime(report.createdAt),
  };
}
