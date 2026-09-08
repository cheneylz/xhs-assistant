/**
 * 选题推荐服务（AI Agent 平台 P-03）
 *
 * 生成依据：账号知识库（定位/口吻/经验结论）+ 实时热点榜单 + 最新爆款拆解结构
 * 一键加入内容生产队列：accept → 生成 AiDraft 草稿
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../core/db";
import { extractJsonObject } from "../core/json-extract";
import { formatDateTime, shanghaiNow } from "../core/time";
import { renderPrompt } from "../../../prompts/loader";
import { buildKbContext } from "./knowledge-base-service";
import { latestHotTopicBatch } from "./hot-topic-service";
import type { TextClientLike } from "./review-service";
import type { ModelConfigLike } from "./ai-service";
import { makeUsageLogger } from "./usage-service";

export interface SuggestionItem {
  title: string;
  direction: string;
  predictedHeat: number;
  tags: string[];
}

/** 解析 LLM 选题输出（纯函数，可单测） */
export function parseSuggestions(content: string, count: number): SuggestionItem[] {
  const payload = extractJsonObject<Record<string, unknown>>(content);
  const items = payload && Array.isArray(payload.items) ? (payload.items as unknown[]) : [];
  const result: SuggestionItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const title = String(item.title ?? "").trim();
    if (!title) continue;
    const tags = Array.isArray(item.tags) ? item.tags.map(String).filter(Boolean).slice(0, 10) : [];
    const heat = Math.max(0, Math.min(100, Math.round(Number(item.predicted_heat) || 0)));
    result.push({
      title: title.slice(0, 100),
      direction: String(item.direction ?? "").trim().slice(0, 50),
      predictedHeat: heat,
      tags: tags.map((tag) => tag.replace(/^#/, "").slice(0, 30)),
    });
    if (result.length >= count) break;
  }
  return result;
}

/** 生成选题并落库，返回本次生成结果 */
export async function generateSuggestions(options: {
  userId: number;
  count: number;
  direction?: string;
  platformAccountId?: number | null;
  textClient: TextClientLike;
  modelConfig: ModelConfigLike;
  apiKey: string;
}): Promise<{ items: Record<string, unknown>[] }> {
  const { userId, count, direction, platformAccountId, textClient, modelConfig, apiKey } = options;

  const kbContext = await buildKbContext(userId, platformAccountId ?? null);
  const hot = await latestHotTopicBatch(userId);
  const hotText = hot.items
    .slice(0, 10)
    .map((entry) => `${entry.rank}. ${entry.keyword}（热度 ${entry.heat_score}，上升 ${entry.rise_speed}%）`)
    .join("\n");
  const latestExplosion = await prisma.explosionReport.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  const explosionText = latestExplosion
    ? `\n爆款结构参考（${latestExplosion.keyword}）：\n标题公式：${(latestExplosion.titlePatterns as string[]).join("；")}`
    : "";

  const context = [
    kbContext ? `【账号知识库】\n${kbContext}` : "",
    hotText ? `【当前热点 TOP10】\n${hotText}` : "",
    explosionText,
    direction ? `【用户指定方向】${direction}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const content = await textClient.complete({
    modelConfig,
    apiKey,
    systemPrompt: renderPrompt("suggestion.md", "suggestion"),
    userPrompt: `请生成 ${count} 个小红书选题：\n${context || "（无额外上下文，按通用种草平台规律生成）"}`,
    temperature: 0.8,
    onUsage: makeUsageLogger(userId, modelConfig.modelName), // S-06 用量采集
  });
  const items = parseSuggestions(content, count);
  if (!items.length) throw new Error("选题生成结果解析失败，请重试");

  const source = ["热点", latestExplosion ? "爆款" : "", kbContext ? "知识库" : ""].filter(Boolean).join("+") || "通用";
  const created = await prisma.$transaction(
    items.map((item) =>
      prisma.topicSuggestion.create({
        data: {
          userId,
          title: item.title,
          direction: item.direction,
          predictedHeat: item.predictedHeat,
          tags: item.tags as Prisma.InputJsonValue,
          source,
          status: "open",
          createdAt: shanghaiNow(),
        },
      }),
    ),
  );
  return { items: created.map(serializeTopicSuggestion) };
}

/** 采纳选题：一键加入内容生产队列（生成草稿） */
export async function acceptSuggestion(userId: number, suggestionId: number): Promise<{ suggestion: Record<string, unknown>; draftId: number }> {
  const suggestion = await prisma.topicSuggestion.findFirst({ where: { id: suggestionId, userId } });
  if (!suggestion) throw new Error("选题不存在");
  if (suggestion.status === "accepted") throw new Error("该选题已加入生产队列");

  const draft = await prisma.aiDraft.create({
    data: {
      userId,
      platform: "xhs",
      title: suggestion.title,
      body: "",
      tags: Array.isArray(suggestion.tags) ? (suggestion.tags as Prisma.InputJsonValue) : undefined,
      createdAt: shanghaiNow(),
    },
  });
  const updated = await prisma.topicSuggestion.update({
    where: { id: suggestionId },
    data: { status: "accepted" },
  });
  return { suggestion: serializeTopicSuggestion(updated), draftId: draft.id };
}

/** 删除选题（仅限本人） */
export async function deleteTopicSuggestion(userId: number, suggestionId: number): Promise<void> {
  const suggestion = await prisma.topicSuggestion.findFirst({ where: { id: suggestionId, userId } });
  if (!suggestion) throw new Error("选题不存在");
  await prisma.topicSuggestion.delete({ where: { id: suggestionId } });
}

/** 批量删除选题（仅限本人，返回实际删除条数） */
export async function deleteTopicSuggestions(userId: number, ids: number[]): Promise<number> {
  const result = await prisma.topicSuggestion.deleteMany({ where: { id: { in: ids }, userId } });
  return result.count;
}

export function serializeTopicSuggestion(suggestion: {
  id: number;
  title: string;
  direction: string;
  predictedHeat: number;
  tags: unknown;
  source: string;
  status: string;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: suggestion.id,
    title: suggestion.title,
    direction: suggestion.direction,
    predicted_heat: suggestion.predictedHeat,
    tags: Array.isArray(suggestion.tags) ? suggestion.tags : [],
    source: suggestion.source,
    status: suggestion.status,
    created_at: formatDateTime(suggestion.createdAt),
  };
}
