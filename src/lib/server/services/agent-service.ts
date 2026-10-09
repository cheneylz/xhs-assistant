/**
 * Agent 会话服务
 *
 * 会话 / 消息 / Run 的持久化操作，以及 worker 侧的原子任务领取。
 * 【本文件不含 Pi 依赖】—— 可被 Next.js API 路由与 worker 两侧安全 import。
 */
import type { AgentConversation, AgentRun, Prisma } from "@prisma/client";
import { prisma } from "../core/db";
import { shanghaiNow } from "../core/time";

/** 会话标题最大长度 */
const TITLE_MAX_LENGTH = 20;

export interface RunDefaults {
  status: string;
  stepCount: number;
  tokensUsed: number;
  maxSteps: number;
  tokenBudget: number;
}

/** 从环境变量读整数，非法或非正值时用默认值（0 阈值会让护栏立刻判定超限） */
function readInt(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const parsed = Number(env[key]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Run 默认值（护栏阈值可由环境变量覆盖） */
export function buildRunDefaults(env: Record<string, string | undefined> = process.env): RunDefaults {
  return {
    status: "pending",
    stepCount: 0,
    tokensUsed: 0,
    maxSteps: readInt(env, "AGENT_MAX_STEPS", 20),
    tokenBudget: readInt(env, "AGENT_TOKEN_BUDGET", 200_000),
  };
}

/** Run 是否已处于终态 */
export function isRunTerminal(status: string): boolean {
  return ["succeeded", "failed", "cancelled"].includes(status);
}

/** 由首条用户消息派生会话标题 */
export function deriveConversationTitle(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "新任务";
  if (trimmed.length <= TITLE_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, TITLE_MAX_LENGTH)}…`;
}

/**
 * 新建会话。
 *
 * createdAt / updatedAt 均无库级默认值，必须显式传（全库一致约定）。
 * updatedAt 刻意不用 Prisma 的 @updatedAt —— 那会按真实 UTC 时钟填充，
 * 与全库「朴素上海墙钟」约定差 8 小时。
 */
export async function createConversation(userId: number, title = "新任务"): Promise<AgentConversation> {
  const now = shanghaiNow();
  return prisma.agentConversation.create({
    data: { userId, title, status: "idle", createdAt: now, updatedAt: now },
  });
}

/**
 * 更新会话状态（并同步刷新 updatedAt）。
 *
 * 调用方一律走这个函数，不要直接 prisma.agentConversation.update ——
 * 否则会漏掉 updatedAt，导致按 updated_at 排序的会话列表不再反映真实活跃度。
 */
export async function updateConversationStatus(options: {
  conversationId: number;
  status: string;
  title?: string;
}): Promise<void> {
  await prisma.agentConversation.update({
    where: { id: options.conversationId },
    data: {
      status: options.status,
      ...(options.title !== undefined ? { title: options.title } : {}),
      updatedAt: shanghaiNow(),
    },
  });
}

/** 列出用户会话（按更新时间倒序） */
export async function listConversations(userId: number): Promise<AgentConversation[]> {
  return prisma.agentConversation.findMany({
    where: { userId, status: { not: "archived" } },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
}

/** 追加一条消息 */
export async function appendMessage(options: {
  conversationId: number;
  role: "user" | "assistant" | "tool";
  content: string;
  runId?: number | null;
  toolCalls?: Prisma.InputJsonValue;
  toolCallId?: string | null;
}): Promise<{ id: number }> {
  const message = await prisma.agentMessage.create({
    data: {
      conversationId: options.conversationId,
      role: options.role,
      content: options.content,
      runId: options.runId ?? null,
      toolCalls: options.toolCalls,
      toolCallId: options.toolCallId ?? null,
      // createdAt 无库级默认值，必须显式传
      createdAt: shanghaiNow(),
    },
  });
  return { id: message.id };
}

/**
 * 用户发消息 → 建 Run。
 * 同时复用 Task 表（taskType="agent_run"），让任务中心能展示 Agent 任务。
 */
export async function createRunForMessage(options: {
  conversationId: number;
  userId: number;
  messageId: number;
  env?: Record<string, string | undefined>;
}): Promise<AgentRun> {
  const defaults = buildRunDefaults(options.env);
  const task = await prisma.task.create({
    data: {
      userId: options.userId,
      platform: "xhs",
      taskType: "agent_run",
      status: "pending",
      progress: 0,
      payload: { conversation_id: options.conversationId } as Prisma.InputJsonValue,
      // createdAt 无库级默认值，必须显式传
      createdAt: shanghaiNow(),
    },
  });
  return prisma.agentRun.create({
    data: {
      conversationId: options.conversationId,
      userId: options.userId,
      taskId: task.id,
      triggerMessageId: options.messageId,
      status: defaults.status,
      stepCount: defaults.stepCount,
      tokensUsed: defaults.tokensUsed,
      maxSteps: defaults.maxSteps,
      tokenBudget: defaults.tokenBudget,
      // createdAt 无库级默认值，必须显式传
      createdAt: shanghaiNow(),
    },
  });
}

/**
 * worker 侧：原子领取待执行的 Run。
 *
 * 用 FOR UPDATE SKIP LOCKED 避免并发 worker（或同一 worker 的重叠 tick）重复领取同一行；
 * 领取即写入 running 与 started_at，所以一条 SQL 同时完成「选」和「占」。
 *
 * started_at 用 `now() AT TIME ZONE 'Asia/Shanghai'` 而非 `now()`：
 * 全库约定为「上海时区 naive datetime」（见 core/time.ts），而 `now()` 转 timestamp
 * 会按 DB 会话时区换算（Docker 官方镜像默认 UTC，会差 8 小时），AT TIME ZONE 则在
 * 任何会话时区下都得到上海墙钟。
 */
export async function claimPendingRuns(limit: number): Promise<AgentRun[]> {
  const rows = await prisma.$queryRaw<Array<{ id: number }>>`
    UPDATE agent_runs
    SET status = 'running', started_at = (now() AT TIME ZONE 'Asia/Shanghai')
    WHERE id IN (
      SELECT id FROM agent_runs
      WHERE status = 'pending'
      ORDER BY id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `;
  if (rows.length === 0) return [];
  // 回读完整行；保持 id 升序，处理顺序与领取顺序一致
  return prisma.agentRun.findMany({
    where: { id: { in: rows.map((row) => row.id) } },
    orderBy: { id: "asc" },
  });
}

/** 标记 Run 结束 */
export async function finishRun(options: {
  runId: number;
  status: "succeeded" | "failed" | "cancelled";
  errorType?: string | null;
  stepCount?: number;
  tokensUsed?: number;
}): Promise<void> {
  const run = await prisma.agentRun.update({
    where: { id: options.runId },
    data: {
      status: options.status,
      errorType: options.errorType ?? null,
      stepCount: options.stepCount,
      tokensUsed: options.tokensUsed,
      finishedAt: shanghaiNow(),
    },
  });
  // 同步 Task 状态，让任务中心显示一致
  await prisma.task.update({
    where: { id: run.taskId },
    data: {
      status: options.status === "succeeded" ? "completed" : "failed",
      progress: options.status === "succeeded" ? 100 : 0,
      finishedAt: shanghaiNow(),
    },
  });
}

/**
 * worker 启动时的崩溃清扫：
 * 把卡在 running 且超过阈值的 Run 标记为失败（不自动重跑，避免重复产出）。
 *
 * 阈值基准用 shanghaiNow()：started_at 存的是上海墙钟，若用 Date.now() 会比较
 * 两个相差 8 小时的时钟，导致卡死 Run 要等到 8 小时后才被清扫。
 */
export async function sweepStuckRuns(thresholdMinutes: number): Promise<number> {
  const cutoff = new Date(shanghaiNow().getTime() - thresholdMinutes * 60 * 1000);
  const result = await prisma.agentRun.updateMany({
    where: { status: "running", startedAt: { lt: cutoff } },
    data: {
      status: "failed",
      errorType: "worker_restart",
      finishedAt: shanghaiNow(),
    },
  });
  return result.count;
}

/** 取会话消息（供循环组装上下文） */
export async function listMessages(conversationId: number, limit = 100): Promise<Array<{ role: string; content: string; toolCallId: string | null }>> {
  const messages = await prisma.agentMessage.findMany({
    where: { conversationId },
    orderBy: { id: "asc" },
    take: limit,
  });
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    toolCallId: message.toolCallId,
  }));
}
