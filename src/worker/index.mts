/**
 * 调度 Worker 进程（对应原版 APScheduler 后台任务，node-cron 实现）
 *
 * 7 个任务：
 *  ① due_publish_runner       定时发布扫描  60s（可配 SCHEDULER_INTERVAL_SECONDS）
 *  ② monitoring_refresh_runner 监控刷新     60s
 *  ③ auto_tasks_runner        自动运营管线  60s
 *  ④ cookie_health_checker    Cookie 健康巡检 2h（可配 COOKIE_HEALTH_CHECK_HOURS）
 *  ⑤ hot_topics_runner        热点榜单采集  30min（P-01）
 *  ⑥ comment_reply_runner     评论自动响应  60s（D-05）
 *  ⑦ agent_run_runner         Agent ReAct 循环 3s（可配 AGENT_POLL_INTERVAL_SECONDS）
 *
 * 互斥锁（对应 APScheduler max_instances=1 + coalesce）：
 *  同一任务上一次执行未结束时跳过本次触发
 *
 * 【本文件是 .mts 且必须保持 .mts】—— 它 import agent-loop.mts（Pi 包为 ESM-only），
 * tsx 下必须按 ESM 加载。因此本文件内**所有相对导入都要显式写后缀**（ESM 不做扩展名推断）。
 */
import cron, { type ScheduledTask } from "node-cron";
import type { AgentRun, ModelConfig, Prisma } from "@prisma/client";
import { getConfig } from "../lib/server/core/config.ts";
import {
  checkAllAccountCookiesOnce,
  getTextModelForUser,
  runDueAutoTasks,
  runDuePublishJobsForAllUsers,
  runMonitoringRefreshForAllUsers,
  type GateReviewer,
} from "../lib/server/services/scheduler-service.ts";
import { OpenAICompatibleTextClient } from "../lib/server/services/ai-service.ts";
import { runHotTopicsForAllUsers } from "../lib/server/services/hot-topic-service.ts";
import { detectNewCommentsForUser } from "../lib/server/services/comment-reply-service.ts";
import { XhsCreatorApiAdapter } from "../lib/server/xhs/adapters/creator-api-adapter.ts";
import { XhsPcApiAdapter } from "../lib/server/xhs/adapters/pc-api-adapter.ts";
import { XhsCreatorLoginAdapter } from "../lib/server/xhs/adapters/creator-login-adapter.ts";
import { XhsPcLoginAdapter } from "../lib/server/xhs/adapters/pc-login-adapter.ts";
import {
  claimPendingRuns,
  finishRun,
  listMessages,
  sweepStuckRuns,
  updateConversationStatus,
} from "../lib/server/services/agent-service.ts";
// 以下三个是 .mts（含 Pi 依赖）：ESM 不做扩展名推断，必须显式写后缀
import { buildAgentTools } from "../lib/server/agent/tool-registry.mts";
import { buildPiModel, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from "../lib/server/agent/model-bridge.mts";
import { runAgentLoop } from "../lib/server/agent/agent-loop.mts";
import { fetchModelCapabilities } from "../lib/server/agent/model-capabilities.ts";
import { persistAgentEvent } from "../lib/server/agent/persist.ts";
import { prisma } from "../lib/server/core/db.ts";
import { decryptText } from "../lib/server/core/security.ts";
import { shanghaiNow } from "../lib/server/core/time.ts";

/** 互斥锁：防止任务重叠执行 */
class Mutex {
  private running = false;

  async run(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.running) {
      console.log(`[worker] ${name} 上次执行未完成，跳过本次触发`);
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    try {
      await fn();
      console.log(`[worker] ${name} 完成，耗时 ${Date.now() - startedAt}ms`);
    } catch (error) {
      console.error(`[worker] ${name} 失败: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

const publishMutex = new Mutex();
const monitoringMutex = new Mutex();
const autoTasksMutex = new Mutex();
const cookieHealthMutex = new Mutex();
const hotTopicsMutex = new Mutex();
const commentReplyMutex = new Mutex();
const agentRunMutex = new Mutex();

/** 门禁审查器：按用户提供文本模型上下文（未配置模型时返回 null，仅规则层） */
const gateReviewer: GateReviewer = async (userId) => {
  const [modelConfig, apiKey] = await getTextModelForUser(userId);
  if (!modelConfig || !apiKey) return null;
  return {
    textClient: new OpenAICompatibleTextClient(),
    modelConfig: modelConfig as unknown as Parameters<OpenAICompatibleTextClient["complete"]>[0]["modelConfig"],
    apiKey,
  };
};

/** ① 定时发布扫描 */
async function duePublishRunner(): Promise<void> {
  await runDuePublishJobsForAllUsers({
    platform: "xhs",
    adapterFactory: (cookies) => new XhsCreatorApiAdapter(cookies),
    gateReviewer,
  });
}

/** ② 监控刷新 */
async function monitoringRefreshRunner(): Promise<void> {
  await runMonitoringRefreshForAllUsers({ platform: "xhs" });
}

/** ③ 自动运营管线 */
async function autoTasksRunner(): Promise<void> {
  await runDueAutoTasks({
    pcAdapterFactory: (cookies) => new XhsPcApiAdapter(cookies),
    creatorAdapterFactory: (cookies) => new XhsCreatorApiAdapter(cookies),
    textClient: new OpenAICompatibleTextClient(),
  });
}

/** ⑤ 热点采集（P-01，30 分钟一次） */
async function hotTopicsRunner(): Promise<void> {
  await runHotTopicsForAllUsers({
    adapterFactory: (cookies) => new XhsPcApiAdapter(cookies),
  });
}

/** ⑥ 评论自动响应检测（D-05，60s）：新评论 → 意图分类 → 生成待审核回复 */
async function commentReplyRunner(): Promise<void> {
  const accounts = await (
    await import("../lib/server/core/db")
  ).prisma.platformAccount.findMany({
    where: { platform: "xhs", subType: "pc" },
    select: { userId: true },
    distinct: ["userId"],
    orderBy: { userId: "asc" },
  });
  for (const account of accounts) {
    try {
      const modelContext = await gateReviewer(account.userId);
      await detectNewCommentsForUser({
        userId: account.userId,
        adapterFactory: (cookies) => new XhsPcApiAdapter(cookies),
        textClient: new OpenAICompatibleTextClient(),
        modelConfig: modelContext?.modelConfig ?? null,
        apiKey: modelContext?.apiKey ?? null,
      });
    } catch (error) {
      console.warn(`[worker] 评论响应检测失败（用户 ${account.userId}）: ${(error as Error).message}`);
    }
  }
}

/** ④ Cookie 健康巡检 */
async function cookieHealthChecker(): Promise<void> {
  await checkAllAccountCookiesOnce({
    userInfoFetcherFor: (account) => {
      const adapter = account.subType === "creator" ? new XhsCreatorLoginAdapter() : new XhsPcLoginAdapter();
      return async (cookies) => {
        await adapter.getUserInfo(cookies as Record<string, string>);
      };
    },
  });
}

/** Agent 并发上限 */
const AGENT_MAX_CONCURRENCY = Math.max(1, Number(process.env.AGENT_MAX_CONCURRENCY) || 3);

/** 卡死 Run 的判定阈值（分钟） */
const AGENT_STUCK_THRESHOLD_MINUTES = Math.max(1, Number(process.env.AGENT_STUCK_THRESHOLD_MINUTES) || 15);

/** 连续工具失败阈值 */
const AGENT_MAX_TOOL_FAILURES = Math.max(1, Number(process.env.AGENT_MAX_TOOL_FAILURES) || 3);

/** 单次运行墙钟超时（毫秒） */
const AGENT_RUN_TIMEOUT_MS = Math.max(10_000, Number(process.env.AGENT_RUN_TIMEOUT_MS) || 600_000);

/**
 * 取用户的完整文本模型配置。
 * 注意：getTextModelForUser 返回的是裁剪过的字段集（缺 provider），
 * 而 buildPiModel 需要完整的 ModelConfigLike，因此这里直接查全表。
 */
async function getFullTextModelForUser(userId: number): Promise<[ModelConfig | null, string]> {
  const config = await prisma.modelConfig.findFirst({
    where: { userId, modelType: "text", isDefault: true },
  });
  if (!config || !config.encryptedApiKey) return [null, ""];
  return [config, decryptText(config.encryptedApiKey)];
}

/** 跑单个 Agent Run 的完整流程 */
async function executeAgentRun(run: AgentRun): Promise<void> {
  const [modelConfig, apiKey] = await getFullTextModelForUser(run.userId);
  if (!modelConfig || !apiKey) {
    await persistAgentEvent(run.id, { type: "error", message: "未配置默认文本模型，无法执行" });
    await finishRun({ runId: run.id, status: "failed", errorType: "no_model_config" });
    return;
  }

  const conversation = await prisma.agentConversation.findUnique({ where: { id: run.conversationId } });
  const triggerMessage = await prisma.agentMessage.findFirst({
    where: { conversationId: run.conversationId, role: "user" },
    orderBy: { id: "desc" },
  });
  if (!triggerMessage) {
    await persistAgentEvent(run.id, { type: "error", message: "会话中没有用户消息" });
    await finishRun({ runId: run.id, status: "failed", errorType: "no_user_message" });
    return;
  }

  // 多轮对话的历史来源：排除本次触发的用户消息 ——
  // 它会由 runAgentLoop 的 prompt() 追加，若同时 seed 进历史就会变成两条相同的提问。
  const history = await listMessages(run.conversationId, 100, triggerMessage.id);

  // 取模型真实上限（/models）。取不到就回退保守默认值 —— 但必须显式告警：
  // 回退意味着守卫用的是硬编码 128k，若该模型真实窗口更小，请求就会被 provider 400 拒绝。
  const capabilities = await fetchModelCapabilities({
    baseUrl: modelConfig.baseUrl,
    apiKey,
    modelName: modelConfig.modelName,
  });
  if (!capabilities) {
    console.warn(
      `[worker] 未能探测模型上限（${modelConfig.modelName} @ ${modelConfig.baseUrl}），` +
        `回退保守默认值 contextWindow=${DEFAULT_CONTEXT_WINDOW} maxTokens=${DEFAULT_MAX_TOKENS}`,
    );
  }

  const result = await runAgentLoop({
    runId: run.id,
    conversationId: run.conversationId,
    userId: run.userId,
    userMessage: triggerMessage.content,
    historyMessages: history,
    model: buildPiModel(modelConfig, capabilities),
    apiKey,
    tools: buildAgentTools({
      userId: run.userId,
      textClient: new OpenAICompatibleTextClient(),
      modelConfig,
      apiKey,
    }),
    maxToolFailures: AGENT_MAX_TOOL_FAILURES,
    runTimeoutMs: AGENT_RUN_TIMEOUT_MS,
    // persistAgentEvent 直接返回自增 id（即 SSE 的 Last-Event-ID），不必回查一次
    persistEvent: async (runId, event) => String(await persistAgentEvent(runId, event)),
    persistMessage: async (message) => {
      await prisma.agentMessage.create({
        data: {
          conversationId: run.conversationId,
          runId: run.id,
          role: message.role,
          content: message.content,
          // tokenUsage 存该条消息自身的用量；Run 级累计走 agent_runs.tokens_used
          ...(message.usage ? { tokenUsage: message.usage as unknown as Prisma.InputJsonValue } : {}),
          // createdAt 无库级默认值，必须显式传（全库一致约定）
          createdAt: shanghaiNow(),
        },
      });
    },
  });

  // tokensUsed / stepCount 由循环自己统计（不再靠数 turn_end 事件 —— 那样拿不到 token）
  await finishRun({
    runId: run.id,
    status: result.status,
    errorType: result.errorType ?? null,
    stepCount: result.stepCount,
    tokensUsed: result.tokensUsed,
  });

  // 会话回到 idle；若标题仍是默认值则按首条用户消息派生。
  // 必须走 updateConversationStatus：它负责刷新 updatedAt。
  // 直接 prisma.agentConversation.update 会漏掉 updatedAt，
  // 因为该字段没有 @updatedAt、也没有库级默认值。
  await updateConversationStatus({
    conversationId: run.conversationId,
    status: "idle",
    ...(conversation?.title === "新任务" ? { title: triggerMessage.content.slice(0, 20) } : {}),
  });
}

/** Agent Run 执行器：领取待执行任务并并发跑 */
async function agentRunRunner(): Promise<void> {
  const runs = await claimPendingRuns(AGENT_MAX_CONCURRENCY);
  if (runs.length === 0) return;
  console.log(`[worker] agent 领取到 ${runs.length} 个待执行 Run`);
  await Promise.allSettled(runs.map((run) => executeAgentRun(run)));
}

/** 启动时清扫卡死的 Run */
async function sweepAgentRuns(): Promise<void> {
  const count = await sweepStuckRuns(AGENT_STUCK_THRESHOLD_MINUTES);
  if (count > 0) console.log(`[worker] 清扫了 ${count} 个卡死的 Agent Run`);
}

const scheduled: ScheduledTask[] = [];

function schedule(expression: string, name: string, mutex: Mutex, fn: () => Promise<void>): void {
  const task = cron.schedule(
    expression,
    () => {
      void mutex.run(name, fn);
    },
    { timezone: "Asia/Shanghai" },
  );
  scheduled.push(task);
  console.log(`[worker] 已注册任务 ${name}：cron=${expression}`);
}

function main(): void {
  const config = getConfig();
  const intervalSeconds = Math.max(1, Math.min(config.schedulerIntervalSeconds, 59));
  const healthHours = Math.max(1, config.cookieHealthCheckHours);

  schedule(`*/${intervalSeconds} * * * * *`, "due_publish_runner", publishMutex, duePublishRunner);
  schedule(`*/${intervalSeconds} * * * * *`, "monitoring_refresh_runner", monitoringMutex, monitoringRefreshRunner);
  schedule("* * * * *", "auto_tasks_runner", autoTasksMutex, autoTasksRunner);
  schedule(`7 */${healthHours} * * *`, "cookie_health_checker", cookieHealthMutex, cookieHealthChecker);
  schedule("*/30 * * * *", "hot_topics_runner", hotTopicsMutex, hotTopicsRunner); // P-01 热点榜单 30 分钟
  schedule("* * * * *", "comment_reply_runner", commentReplyMutex, commentReplyRunner); // D-05 评论响应 60s

  // Agent Run 轮询：默认 3s（可配 AGENT_POLL_INTERVAL_SECONDS），与前端「发送后即走」的体感匹配
  const agentPollSeconds = Math.max(1, Math.min(Number(process.env.AGENT_POLL_INTERVAL_SECONDS) || 3, 59));
  schedule(`*/${agentPollSeconds} * * * * *`, "agent_run_runner", agentRunMutex, agentRunRunner);

  // 启动时清扫上次进程崩溃遗留的 running Run（不自动重跑，避免重复产出）
  void sweepAgentRuns();

  console.log(`[worker] 启动完成：interval=${config.schedulerIntervalSeconds}s, cookieHealth=${healthHours}h`);
  console.log("[worker] 按 Ctrl+C 退出");
}

main();

// 优雅退出
process.on("SIGINT", () => {
  console.log("[worker] 收到退出信号，停止调度");
  for (const task of scheduled) task.stop();
  process.exit(0);
});
