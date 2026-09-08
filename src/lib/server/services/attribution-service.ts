/**
 * 数据分析服务（AI Agent 平台 A-02 归因分析 / A-04 周报）
 *
 * A-02：对比同账号高/低表现内容，LLM 归因（标题/封面/发布时间/话题标签等维度）
 * A-04：基于本地笔记库数据汇总，LLM 生成运营周报叙述
 * A-06 闭环学习：归因结论由前端「写入知识库」按钮调 /api/knowledge-base/lessons 落库（Phase 1 已实现）
 */
import { prisma } from "../core/db";
import { formatDateTime, shanghaiNow } from "../core/time";
import { extractJsonObject } from "../core/json-extract";
// 复用现有 XHS 分析共享工具（指标提取/话题聚合，见 src/app/api/xhs/analytics/shared.ts）
import { ownedNotes, noteMetrics, rawObject, rawTopics } from "../../../app/api/xhs/analytics/shared";
import type { TextClientLike } from "./review-service";
import type { ModelConfigLike } from "./ai-service";
import { makeUsageLogger } from "./usage-service";
import { renderPrompt } from "../../../prompts/loader";

// ---------- A-02 归因分析 ----------

export interface AttributionConclusion {
  dimension: string; // 标题/封面/发布时间/话题标签/正文
  finding: string; // 结论
  evidence: string; // 数据证据
}

/** 解析 LLM 归因输出（纯函数，可单测） */
export function parseAttribution(content: string): AttributionConclusion[] {
  const payload = extractJsonObject<Record<string, unknown>>(content);
  const items = payload && Array.isArray(payload.conclusions) ? (payload.conclusions as unknown[]) : [];
  const result: AttributionConclusion[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const finding = String(item.finding ?? "").trim();
    if (!finding) continue;
    result.push({
      dimension: String(item.dimension ?? "其他").slice(0, 20),
      finding: finding.slice(0, 200),
      evidence: String(item.evidence ?? "").slice(0, 200),
    });
  }
  return result;
}

/** 生成归因分析报告（高表现 TOP5 vs 低表现 TOP5） */
export async function generateAttribution(options: {
  userId: number;
  textClient: TextClientLike;
  modelConfig: ModelConfigLike;
  apiKey: string;
}): Promise<{ conclusions: AttributionConclusion[]; samples: Record<string, unknown> }> {
  const { userId, textClient, modelConfig, apiKey } = options;
  const notes = await ownedNotes(userId);
  if (!notes.length) throw new Error("内容库为空，暂无可归因的数据");

  const withMetrics = notes
    .map((note) => ({ note, engagement: noteMetrics(note).engagement }))
    .sort((a, b) => b.engagement - a.engagement);
  const topNotes = withMetrics.slice(0, 5);
  const lowCandidates = withMetrics.filter((item) => item.engagement > 0);
  const lowNotes = (lowCandidates.length ? lowCandidates : withMetrics).slice(-5).reverse();

  const describe = (items: Array<{ note: (typeof notes)[number]; engagement: number }>): string =>
    items
      .map(({ note, engagement }, index) => {
        const raw = rawObject(note.rawJson);
        const topics = rawTopics(raw).slice(0, 5).join("/");
        const hour = note.createdAt.getHours();
        return `${index + 1}. 标题：${note.title || "(无标题)"} | 互动 ${engagement} | 发布时间 ${hour} 时 | 话题 ${topics || "无"}`;
      })
      .join("\n");

  const content = await textClient.complete({
    modelConfig,
    apiKey,
    systemPrompt: renderPrompt("attribution.md", "attribution"),
    userPrompt: `【高表现内容 TOP5】\n${describe(topNotes)}\n\n【低表现内容 TOP5】\n${describe(lowNotes)}`,
    temperature: 0.3,
    onUsage: makeUsageLogger(userId, modelConfig.modelName), // S-06 用量采集
  });
  const conclusions = parseAttribution(content);
  if (!conclusions.length) throw new Error("归因分析结果解析失败，请重试");

  return {
    conclusions,
    samples: {
      top: topNotes.map(({ note, engagement }) => ({ id: note.id, title: note.title, engagement })),
      low: lowNotes.map(({ note, engagement }) => ({ id: note.id, title: note.title, engagement })),
    },
  };
}

// ---------- A-04 运营周报 ----------

/** 生成运营周报（LLM 叙述 + 数据汇总） */
export async function generateWeeklyReport(options: {
  userId: number;
  textClient: TextClientLike;
  modelConfig: ModelConfigLike;
  apiKey: string;
}): Promise<{ markdown: string; summary: Record<string, unknown> }> {
  const { userId, textClient, modelConfig, apiKey } = options;
  const notes = await ownedNotes(userId);
  const now = shanghaiNow();

  const ranked = [...notes].sort((a, b) => noteMetrics(b).engagement - noteMetrics(a).engagement);
  const totalEngagement = notes.reduce((sum, note) => sum + noteMetrics(note).engagement, 0);
  const commentCount = await prisma.noteComment.count({
    where: { note: { userId, platform: "xhs" } },
  });

  const summary: Record<string, unknown> = {
    period: formatDateTime(now),
    note_count: notes.length,
    total_engagement: totalEngagement,
    comment_count: commentCount,
    top_notes: ranked.slice(0, 5).map((note) => ({
      title: note.title,
      engagement: noteMetrics(note).engagement,
    })),
  };

  let markdown: string;
  try {
    markdown = await textClient.complete({
      modelConfig,
      apiKey,
      systemPrompt: renderPrompt("attribution.md", "weekly-report"),
      userPrompt: `本周运营数据：\n${JSON.stringify(summary, null, 2)}`,
      temperature: 0.5,
      onUsage: makeUsageLogger(userId, modelConfig.modelName), // S-06 用量采集
    });
  } catch {
    markdown = `本周共发布/入库 ${notes.length} 条内容，总互动 ${totalEngagement}，评论 ${commentCount} 条。`;
  }
  return { markdown: markdown.trim(), summary };
}
