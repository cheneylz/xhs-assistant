/**
 * Agent 会话服务
 *
 * 会话 / 消息 / Run 的持久化操作，以及 worker 侧的原子任务领取。
 * 【本文件不含 Pi 依赖】—— 可被 Next.js API 路由与 worker 两侧安全 import。
 */
import type { AgentConversation, AgentEvent, AgentMessage, AgentRun, AgentToolCall, Prisma } from "@prisma/client";
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
 * 同时复用 Task 表（taskType="agent_run"），让任务中心能展示 Agent 任务，
 * 并把会话置为 running，让前端能区分「空闲」与「执行中」（禁用输入框、显示加载态）。
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
  const run = await prisma.agentRun.create({
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

  // 会话置为 running：前端据此区分「空闲」与「执行中」。
  // 必须走 updateConversationStatus —— 它负责刷新 updatedAt（该字段既无库级默认值也无 @updatedAt）。
  // 放在 Run 创建成功之后：若建 Run 失败，不应把会话留在 running。
  await updateConversationStatus({ conversationId: options.conversationId, status: "running" });

  return run;
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

  // 先选出要清扫的行，取到 taskId 后再与 Task 一起更新。
  // 只 updateMany 改 Run 会漏掉绑定的 Task：任务中心里那条 Agent 任务将永远停在
  // pending（finishRun 是刻意保持 Run 与 Task 同步的，清扫也必须遵守同一约定）。
  const stuckRuns = await prisma.agentRun.findMany({
    where: { status: "running", startedAt: { lt: cutoff } },
    select: { id: true, taskId: true },
  });
  if (stuckRuns.length === 0) return 0;

  // finishedAt 无库级默认值，必须显式传 shanghaiNow()（全库一致约定）
  const now = shanghaiNow();
  await prisma.$transaction([
    prisma.agentRun.updateMany({
      where: { id: { in: stuckRuns.map((run) => run.id) } },
      data: {
        status: "failed",
        errorType: "worker_restart",
        finishedAt: now,
      },
    }),
    prisma.task.updateMany({
      where: { id: { in: stuckRuns.map((run) => run.taskId) } },
      data: {
        status: "failed",
        progress: 0,
        finishedAt: now,
      },
    }),
  ]);

  return stuckRuns.length;
}

/**
 * 取会话消息（供循环组装上下文）。
 * excludeMessageId：排除某条消息（worker 用它排除本次触发的用户消息）。
 */
export async function listMessages(
  conversationId: number,
  limit = 100,
  excludeMessageId?: number,
): Promise<Array<{ role: string; content: string; toolCallId: string | null }>> {
  const messages = await prisma.agentMessage.findMany({
    where: { conversationId, ...(excludeMessageId !== undefined ? { id: { not: excludeMessageId } } : {}) },
    orderBy: { id: "asc" },
    take: limit,
  });
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    toolCallId: message.toolCallId,
  }));
}

// ---------- P1-A：接口层查询 ----------

/**
 * 查会话归属：查不到（不存在或不属于该用户）返回 null。
 *
 * **不在这里抛 HTTP 错误**：本文件要被 worker 与路由两侧 import，
 * 而 `http-error` 依赖 `next/server`。服务层只表达「查不到」，状态码由路由层决定
 * —— 路由层一律把 null 转成 404（不泄露「存在但不是你的」）。
 */
export async function findConversationForUser(
  conversationId: number,
  userId: number,
): Promise<AgentConversation | null> {
  return prisma.agentConversation.findFirst({ where: { id: conversationId, userId } });
}

/**
 * 会话的全部 Run（按 id 升序）。
 * 事件范围一律由它圈定 —— SSE、首屏、工件接口三处共用，避免各写一份查询条件。
 */
export async function listRuns(conversationId: number): Promise<AgentRun[]> {
  return prisma.agentRun.findMany({ where: { conversationId }, orderBy: { id: "asc" } });
}

/** 会话内是否还有未结束的 Run（SSE 降速判定的输入） */
export async function hasActiveRun(conversationId: number): Promise<boolean> {
  const count = await prisma.agentRun.count({
    where: { conversationId, status: { in: ["pending", "running"] } },
  });
  return count > 0;
}

/**
 * 会话的**用户消息**（按 id 升序，中栏历史的 user 气泡）。
 *
 * 只取 role="user"，不是漏了别的角色：助手文本一律来自 agent_events 的 message_end
 * （首屏 `events` 字段与 SSE 同源）。最终答复同时存在于两处 ——
 * agent_messages 的 assistant 行（供 LLM 多轮上下文）与 message_end 事件 ——
 * 若这里把 assistant 行也返回，同一段文本会被渲染两遍。
 */
export async function listConversationUserMessages(conversationId: number, limit = 500): Promise<AgentMessage[]> {
  return prisma.agentMessage.findMany({
    where: { conversationId, role: "user" },
    orderBy: { id: "asc" },
    take: limit,
  });
}

/** 多个 Run 的工具调用（中栏已完成的工具卡；取**最新** limit 条再翻正序） */
export async function listToolCallsForRuns(runIds: number[], limit = 200): Promise<AgentToolCall[]> {
  if (runIds.length === 0) return [];
  const rows = await prisma.agentToolCall.findMany({
    where: { runId: { in: runIds } },
    orderBy: { id: "desc" },
    take: limit,
  });
  return rows.reverse();
}

/** 多个 Run 的工件事件（右栏工件；取**最新** limit 条再翻正序） */
export async function listArtifactEvents(runIds: number[], limit = 200): Promise<AgentEvent[]> {
  if (runIds.length === 0) return [];
  const rows = await prisma.agentEvent.findMany({
    where: { runId: { in: runIds }, type: "artifact" },
    orderBy: { id: "desc" },
    take: limit,
  });
  return rows.reverse();
}

/** 会话全部 Run 的事件 id 上界（无事件为 0）—— 前端 SSE 的续传起点 */
export async function latestEventIdForRuns(runIds: number[]): Promise<number> {
  if (runIds.length === 0) return 0;
  const result = await prisma.agentEvent.aggregate({ where: { runId: { in: runIds } }, _max: { id: true } });
  return result._max.id ?? 0;
}

/**
 * 首屏回放用的历史事件（id ≤ upToId、仅可渲染类型）。
 *
 * 取的是**最新**的 limit 条再翻正序：截断时丢掉的是最早的几条，
 * 而不是把最近的过程文本丢掉（长会话下后者会让用户看不到刚发生的事）。
 */
export async function listRenderableEvents(
  runIds: number[],
  upToId: number,
  types: readonly string[],
  limit: number,
): Promise<AgentEvent[]> {
  if (runIds.length === 0 || upToId <= 0) return [];
  const rows = await prisma.agentEvent.findMany({
    where: { runId: { in: runIds }, id: { lte: upToId }, type: { in: [...types] } },
    orderBy: { id: "desc" },
    take: limit,
  });
  return rows.reverse();
}

/** SSE：取 id > afterId 的新事件（升序，最多 limit 条） */
export async function listEventsAfter(runIds: number[], afterId: number, limit: number): Promise<AgentEvent[]> {
  if (runIds.length === 0) return [];
  return prisma.agentEvent.findMany({
    where: { runId: { in: runIds }, id: { gt: afterId } },
    orderBy: { id: "asc" },
    take: limit,
  });
}

/**
 * 批量取工具调用摘要（SSE 给 tool_execution_end 补摘要用）。
 *
 * **键是 `runId:toolCallId` 复合键**（与 stream-events 的 toolCallSummaryKey 同格式）：
 * agent_tool_calls 对 tool_call_id 没有唯一约束，provider 又常按 Run 重置计数
 * （每个 Run 都有 call_1），只用 toolCallId 做键会让同会话的两个 Run 互相串摘要。
 *
 * where 用 `runId IN (...)` + `toolCallId IN (...)` 的交集过滤即可 —— 结果可能是
 * 我们没问过的组合的超集，但键里带了 runId，查表时不会错配。
 */
export async function findToolCallSummaries(
  runIds: number[],
  toolCallIds: string[],
): Promise<Map<string, string>> {
  if (runIds.length === 0 || toolCallIds.length === 0) return new Map();
  const rows = await prisma.agentToolCall.findMany({
    where: { runId: { in: runIds }, toolCallId: { in: toolCallIds }, summary: { not: null } },
    select: { runId: true, toolCallId: true, summary: true },
  });
  const map = new Map<string, string>();
  for (const row of rows) {
    if (!row.summary) continue;
    map.set(`${row.runId}:${row.toolCallId}`, row.summary);
  }
  return map;
}

// ---------- P1-A：取消与删除 ----------

/**
 * 取消 Run 的结果：三种结局都由路由层翻译成状态码
 * （cancelled → 200 / conflict → 409 / not_found → 404）。
 */
export type CancelRunResult =
  | { outcome: "cancelled"; run: AgentRun }
  | { outcome: "conflict"; reason: string }
  | { outcome: "not_found" };

/**
 * 取消一个 Run —— **仅 pending**（P1 设计稿 D19）。
 *
 * 竞态处理：worker 的 claimPendingRuns 是 `FOR UPDATE SKIP LOCKED` + `status='pending'`，
 * 这里用 `updateMany` 带上同样的 status 条件做原子守卫 —— 若「读到 pending、写时已被领取」，
 * count 为 0，返回冲突而不是把 running 的 Run 标成 cancelled。
 */
export async function cancelPendingRun(runId: number, userId: number): Promise<CancelRunResult> {
  const run = await prisma.agentRun.findFirst({ where: { id: runId, userId } });
  if (!run) return { outcome: "not_found" };
  if (isRunTerminal(run.status)) {
    return { outcome: "conflict", reason: `Run 已是终态（${run.status}），无需取消` };
  }

  const now = shanghaiNow();
  // 三步写入必须同事务：任一步失败都会留下「Run 已取消但 Task 仍 pending、会话卡在 running」
  // 的不可修复状态 —— 重试只会拿到 409（Run 已是终态）。
  return prisma.$transaction(async (tx): Promise<CancelRunResult> => {
    // 原子守卫：worker 的 claimPendingRuns 同样带 status='pending' 条件（FOR UPDATE SKIP LOCKED），
    // 两边谁先提交谁赢 —— 读到 pending 但写时已被领走时 count 为 0。
    const updated = await tx.agentRun.updateMany({
      where: { id: runId, status: "pending" },
      data: { status: "cancelled", errorType: "cancelled_by_user", finishedAt: now },
    });
    if (updated.count === 0) {
      return {
        outcome: "conflict",
        reason: "Run 已不在 pending 状态（已被 worker 领取开始执行，或已被取消），无法取消",
      };
    }

    // 同步 Task：任务中心里这条 Agent 任务不能永远停在 pending（与 finishRun 同一约定）
    await tx.task.update({
      where: { id: run.taskId },
      data: { status: "failed", progress: 0, finishedAt: now },
    });

    // 会话必须回到 idle：否则前端会一直停在「执行中」（输入框禁用、发不出下一条）。
    // 这里直接写 updatedAt，而不是调 updateConversationStatus —— 那个助手用全局 prisma，
    // 进不了事务；漏掉 updatedAt 会让按更新时间排序的会话列表错乱。
    const stillActive = await tx.agentRun.count({
      where: { conversationId: run.conversationId, status: { in: ["pending", "running"] } },
    });
    if (stillActive === 0) {
      await tx.agentConversation.update({
        where: { id: run.conversationId },
        data: { status: "idle", updatedAt: now },
      });
    }

    return { outcome: "cancelled", run: await tx.agentRun.findUniqueOrThrow({ where: { id: runId } }) };
  });
}

/**
 * 删除会话及其全部关联行；会话不存在或不属于该用户时返回 false（路由层据此转 404）。
 *
 * Prisma 的级联**只覆盖声明了关系的表**（agent_messages / agent_runs）。
 * agent_events / agent_tool_calls / tasks 与 Run 之间只有裸整数外键、没有关系声明，
 * 不显式删就会留下孤儿行 —— 事件与工具调用的孤儿尤其难查（它们没有可关联的会话）。
 */
export async function deleteConversationDeep(conversationId: number, userId: number): Promise<boolean> {
  const conversation = await findConversationForUser(conversationId, userId);
  if (!conversation) return false;
  const runs = await prisma.agentRun.findMany({ where: { conversationId }, select: { id: true, taskId: true } });
  const runIds = runs.map((run) => run.id);
  const taskIds = runs.map((run) => run.taskId);

  await prisma.$transaction([
    prisma.agentEvent.deleteMany({ where: { runId: { in: runIds } } }),
    prisma.agentToolCall.deleteMany({ where: { runId: { in: runIds } } }),
    prisma.task.deleteMany({ where: { id: { in: taskIds } } }),
    // 放在最后：agent_messages / agent_runs 由外键 onDelete: Cascade 随会话一起清
    prisma.agentConversation.delete({ where: { id: conversationId } }),
  ]);
  return true;
}
