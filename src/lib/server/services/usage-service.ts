/**
 * AI 用量监控服务（AI Agent 平台 S-06）
 *
 * 通过 OpenAICompatibleTextClient.complete 的 onUsage 回调采集 token 用量，
 * 落 api_usage_logs 表；usageSummary 聚合展示（按模型分组）。
 */
import { prisma } from "../core/db";
import { shanghaiNow } from "../core/time";

export interface UsageRecord {
  promptTokens: number;
  completionTokens: number;
}

export type UsageCallback = (usage: UsageRecord) => void;

/** 构造用量记录回调（fire-and-forget，失败仅告警不阻塞业务） */
export function makeUsageLogger(userId: number, modelName: string, usageType = "text"): UsageCallback {
  return (usage) => {
    void prisma.apiUsageLog
      .create({
        data: {
          userId,
          modelName: modelName || "",
          usageType,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          createdAt: shanghaiNow(),
        },
      })
      .catch((error) => console.warn(`[usage] 用量记录失败: ${(error as Error).message}`));
  };
}

/** 最近 N 天用量汇总（按模型分组） */
export async function usageSummary(userId: number, days = 7): Promise<Record<string, unknown>> {
  const since = new Date(shanghaiNow().getTime() - days * 24 * 3600 * 1000);
  const logs = await prisma.apiUsageLog.findMany({
    where: { userId, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
  });
  const byModel = new Map<string, { calls: number; promptTokens: number; completionTokens: number }>();
  for (const log of logs) {
    const key = log.modelName || "未知模型";
    const entry = byModel.get(key) ?? { calls: 0, promptTokens: 0, completionTokens: 0 };
    entry.calls += 1;
    entry.promptTokens += log.promptTokens;
    entry.completionTokens += log.completionTokens;
    byModel.set(key, entry);
  }
  return {
    days,
    total_calls: logs.length,
    total_prompt_tokens: logs.reduce((sum, log) => sum + log.promptTokens, 0),
    total_completion_tokens: logs.reduce((sum, log) => sum + log.completionTokens, 0),
    by_model: [...byModel.entries()].map(([model, stats]) => ({ model, ...stats })),
  };
}
