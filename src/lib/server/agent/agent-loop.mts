/**
 * Agent 循环装配与驱动
 *
 * 用 Pi 的 Agent 跑 ReAct 循环。三处钩子分工（改动前先读）：
 *   - subscribe      ：只能观察。事件落库、连续失败计数、token 累计、中止判定
 *   - beforeToolCall ：准入。checkToolAllowed 判定 + 阻断记录落库
 *   - afterToolCall  ：改写。结果摘要、工件抽取、工具调用落库
 *
 * 【本文件含 Pi 依赖】—— 仅 worker 侧使用，Next.js 侧禁止 import。
 */
import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Model, Usage } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { renderPrompt } from "../../../prompts/loader.ts";
import { pruneByCharBudget, summarizeToolResult } from "./context.ts";
import { checkToolAllowed, createFailureTracker } from "./guards.ts";
import {
  extractArtifacts,
  extractMessageText,
  finalizeToolCall as finalizeToolCallInDb,
  persistToolCall as persistToolCallInDb,
} from "./persist.ts";
import { SKILL_CATALOG } from "./skill-catalog.ts";
import { buildToolCallSummary } from "./tool-summary.ts";

/** 默认字符预算（约 100k token，按「字符数 / 2」估算） */
const DEFAULT_CHAR_BUDGET = 200_000;

/** 默认连续工具失败阈值 */
const DEFAULT_MAX_TOOL_FAILURES = 3;

/** 默认单次运行墙钟超时（毫秒） */
const DEFAULT_RUN_TIMEOUT_MS = 600_000;

/** 工具结果摘要保留的列表条数 */
const SUMMARY_LIST_LIMIT = 10;

/** 本地中止原因：循环自己知道是谁按下的中止，必须显式记录 */
type AbortReason = "timeout" | "tool_failures";

/** 会话历史的一条消息（结构对齐 agent-service.listMessages 的返回值） */
export interface StoredMessage {
  role: string;
  content: string;
  toolCallId: string | null;
}

/** 工具调用落库函数签名（与 persist.ts 一致，便于测试注入假实现） */
export type PersistToolCallFn = (options: Parameters<typeof persistToolCallInDb>[0]) => Promise<number>;
export type FinalizeToolCallFn = (options: Parameters<typeof finalizeToolCallInDb>[0]) => Promise<void>;

/** 渲染给模型的工具目录文本 */
export function buildToolCatalogText(): string {
  return SKILL_CATALOG.map(
    (definition) =>
      `- **${definition.skillKey}**（${definition.name}）${definition.riskLevel === "read" ? "［只读］" : "［会产生内容］"}\n  ${definition.description}`,
  ).join("\n");
}

/** 把 unknown 收窄成普通对象（工具 details 的静态类型是 any/unknown） */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** 空 usage：历史消息不是本次请求的响应，只为满足 AssistantMessage 的类型 */
function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * 把落库的会话历史还原成 Pi 的 AgentMessage 数组（**不含**本次的新用户消息）。
 *
 * P0 的有损之处（有意，登记为 P1）：agent_messages 只存了纯文本 content，没有存
 * assistant 的 toolCalls 数组。孤立的 toolResult（没有配对的 toolCall）会被 provider
 * 拒绝，因此这里**丢弃** role="tool" 的历史行 —— 多轮对话能续上，但模型看不到
 * 「上一轮调过哪些工具」。P1 需在落库时写入 toolCalls/toolCallId 后再还原。
 */
function toAgentMessages(history: StoredMessage[], model: Model<"openai-completions">, now: number): Message[] {
  const messages: Message[] = [];
  for (const item of history) {
    if (!item.content) continue;
    if (item.role === "user") {
      messages.push({ role: "user", content: item.content, timestamp: now });
    } else if (item.role === "assistant") {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: item.content }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason: "stop",
        timestamp: now,
      });
    }
    // role === "tool"：见上方说明，P0 丢弃
  }
  return messages;
}

/** 取出助手消息里的纯文本（拼接所有 text 块） */
function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export interface LoopOutcome {
  /** 与 finishRun 的 status 联合类型一致，可直接透传 */
  status: "succeeded" | "failed" | "cancelled";
  errorType?: string;
  /** 供事件落库与验收脚本阅读的可读结论 */
  message: string;
}

/**
 * 把「本地中止原因 + 最后一条 assistant 消息的 stopReason」映射成 Run 终态。
 *
 * 为什么不看 try/catch：Pi 的 StreamFn 契约明确要求「不得为请求/模型/运行时失败抛错」，
 * 失败一律编码为最终 AssistantMessage 的 stopReason "error"/"aborted"；agent.abort()
 * 也只是中止 AbortController，waitForIdle() 永远 resolve。只看有没有抛错，会把超时、
 * 连续工具失败、Key 无效、限流、provider 500 全部记成 succeeded，并让绑定的 Task
 * 变成 completed + progress 100。
 *
 * 映射是 fail-closed 的：只有明确的 "stop" 才算成功，未知 stopReason 一律失败。
 */
export function resolveLoopOutcome(input: {
  abortReason?: AbortReason;
  stopReason?: string;
  errorMessage?: string;
}): LoopOutcome {
  if (input.abortReason === "timeout") {
    return { status: "failed", errorType: "timeout", message: "运行超过墙钟上限被中止" };
  }
  if (input.abortReason === "tool_failures") {
    return { status: "failed", errorType: "tool_failures", message: "连续工具调用失败被中止" };
  }
  switch (input.stopReason) {
    case "stop":
      return { status: "succeeded", message: "运行完成" };
    case "error":
      return {
        status: "failed",
        errorType: "model_error",
        message: `模型请求失败：${input.errorMessage ?? "未提供错误信息"}`,
      };
    case "aborted":
      // 本地中止已在上面分流，走到这里说明是外部中止
      return { status: "cancelled", errorType: "aborted", message: "运行被中止" };
    case "length":
      return { status: "failed", errorType: "output_length", message: "输出被 token 上限截断" };
    case "toolUse":
      return { status: "failed", errorType: "unfinished_tool_use", message: "循环在仍有工具待调用时结束" };
    case "pending":
      return { status: "failed", errorType: "no_response", message: "循环结束时模型仍未给出响应" };
    case "deferred":
      return { status: "failed", errorType: "deferred_unsupported", message: "P0 不支持延迟响应（deferred）" };
    default:
      return {
        status: "failed",
        errorType: "unknown_stop_reason",
        message: `未识别的 stopReason：${String(input.stopReason)}`,
      };
  }
}

export interface RunAgentLoopOptions {
  runId: number;
  conversationId: number;
  userId: number;
  userMessage: string;
  /** 会话历史（**不含** userMessage —— 它由 prompt() 追加，重复喂会变成两条相同的 user 消息） */
  historyMessages?: StoredMessage[];
  model: Model<"openai-completions">;
  tools: AgentTool[];
  apiKey?: string;
  systemPrompt?: string;
  /** 注入假 streamFn 供离线测试；不传则用 pi-ai 的真实实现 */
  fakeStreamFn?: StreamFn;
  persistEvent: (runId: number, event: Record<string, unknown>) => Promise<string>;
  persistMessage?: (message: { role: string; content: string; usage?: Usage }) => Promise<void>;
  /** 注入工具调用落库实现（离线测试用）；不传则用 persist.ts 的真实实现 */
  persistToolCall?: PersistToolCallFn;
  finalizeToolCall?: FinalizeToolCallFn;
  charBudget?: number;
  maxToolFailures?: number;
  runTimeoutMs?: number;
}

export interface RunAgentLoopResult {
  status: "succeeded" | "failed" | "cancelled";
  errorType?: string;
  /** 本轮消耗的 token（逐轮累加模型上报的 usage.totalTokens） */
  tokensUsed: number;
  /** 本轮发起的工具调用次数（含被阻断的），与 agent_tool_calls.step_index 同口径 */
  stepCount: number;
}

/**
 * 跑一次完整的 ReAct 循环。
 *
 * 事件经 persistEvent 落库；工具调用与工件在 afterToolCall 里处理（见文件头分工表）。
 */
export async function runAgentLoop(options: RunAgentLoopOptions): Promise<RunAgentLoopResult> {
  const { runId, userMessage, model, tools, apiKey, persistEvent, persistMessage } = options;
  const charBudget = options.charBudget ?? DEFAULT_CHAR_BUDGET;
  const maxToolFailures = options.maxToolFailures ?? DEFAULT_MAX_TOOL_FAILURES;
  const runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const failureTracker = createFailureTracker(maxToolFailures);
  const persistToolCallRow = options.persistToolCall ?? persistToolCallInDb;
  const finalizeToolCallRow = options.finalizeToolCall ?? finalizeToolCallInDb;
  const history = options.historyMessages ?? [];

  // 字符预算必须小于模型上下文窗口：本项目按「字符数 / 2」估 token，
  // 估算值一旦不小于窗口，裁剪永远追不上，请求必然被 provider 拒绝 —— 提前失败并说明原因。
  if (charBudget / 2 >= model.contextWindow) {
    const message = `字符预算过大：charBudget/2=${charBudget / 2} 不小于模型上下文窗口 ${model.contextWindow}`;
    await persistEvent(runId, { type: "error", message });
    return { status: "failed", errorType: "char_budget_exceeds_context_window", tokensUsed: 0, stepCount: 0 };
  }

  const systemPrompt =
    options.systemPrompt ?? renderPrompt("agent.md", "system", { toolCatalog: buildToolCatalogText() });

  // ---- 循环自有的运行状态 ----
  let stepIndex = 0; // 已发起的工具调用序号（= agent_tool_calls.step_index）
  let tokensUsed = 0; // 逐轮累加的 usage.totalTokens
  let abortReason: AbortReason | undefined;
  let finalAssistant: AssistantMessage | undefined;
  // 工具调用起点：toolCallId → { 落库行 id, stepIndex, 起始时刻, 入参 }
  // 由 subscribe 的 tool_execution_start 建立（Pi 保证它在任何钩子之前发出），
  // 这样「没走到钩子」的调用也能占到自己的序号，step_index 保持 0..n-1 连续。
  const toolCallRows = new Map<
    string,
    { rowId: number | null; stepIndex: number; startedAt: number; params: Record<string, unknown> }
  >();

  /**
   * 落库失败不能影响循环本身：
   * afterToolCall 抛错会被 Pi 捕获并把该工具结果改写成 isError（一次数据库抖动会让模型
   * 以为工具失败而重试，产生重复产出）；beforeToolCall 抛错则会让工具直接不执行。
   * 这里一律吞掉异常并留一条 warning 事件。
   */
  const notePersistFailure = async (where: string, error: unknown): Promise<void> => {
    const message = `落库失败（${where}）：${(error as Error).message}`;
    console.error("[agent]", message);
    try {
      await persistEvent(runId, { type: "status", level: "warning", message });
    } catch {
      // 连事件都写不进去，只能靠上面的 console
    }
  };

  /**
   * 计算本次运行的终态结论。
   *
   * 唯一的判定入口 —— 事件落库（agent_end 之前）与函数返回值都走这里，
   * 两处各写一份会漂移，导致「库里记 failed、返回 succeeded」这类不一致。
   */
  const buildOutcome = (): LoopOutcome =>
    finalAssistant
      ? resolveLoopOutcome({
          abortReason,
          stopReason: finalAssistant.stopReason,
          errorMessage: finalAssistant.errorMessage,
        })
      : { status: "failed", errorType: "no_assistant_message", message: "循环结束但没有产生任何助手消息" };

  const agent = new Agent({
    // 断言只包住 streamSimple：pi-ai 的 StreamFunction 与 pi-agent-core 的 StreamFn 是两个
    // 独立的具名类型（各自的 TranscriptContext 是品牌类型），结构上不互相兼容。
    // 不要把它扩大成整个表达式的 `as never` —— 那样连 fakeStreamFn 传错类型都查不出来。
    streamFn: options.fakeStreamFn ?? (streamSimple as unknown as StreamFn),
    getApiKey: async () => apiKey,
    initialState: {
      model,
      tools,
      systemPrompt,
      // 历史消息（不含新用户消息：它由 prompt() 追加）
      ...(history.length > 0 ? { messages: toAgentMessages(history, model, Date.now()) } : {}),
    },
    // 上下文预算：字符数估算裁剪（保底保留最新 user 消息，见 context.ts）。
    // **不要**给 messages 标 `never[]`：AgentMessage[] 不可赋给 never[]，会报 TS2322（已实测）。
    // 省略参数类型、交给 AgentOptions 做上下文推断即可，这样连断言都不需要。
    transformContext: async (messages) => pruneByCharBudget(messages, charBudget),
    beforeToolCall: async (context) => {
      // 序号与起始时刻在 tool_execution_start 的观察者里已分配好。
      // 兜底：真拿不到条目时（不该发生）就地分配一个，宁可序号跳号也不要丢记录。
      let entry = toolCallRows.get(context.toolCall.id);
      if (!entry) {
        entry = { rowId: null, stepIndex, startedAt: Date.now(), params: asRecord(context.args) };
        stepIndex += 1;
        toolCallRows.set(context.toolCall.id, entry);
      }
      const step = entry.stepIndex;

      const verdict = checkToolAllowed(context.toolCall.name);
      if (!verdict.allowed) {
        // 阻断的调用**不会**走 afterToolCall（Pi 直接构造错误结果返回），
        // 所以 blocked 记录必须在这里落 —— 这里才是「决定阻断」的地方。
        try {
          entry.rowId = await persistToolCallRow({
            runId,
            stepIndex: step,
            toolName: context.toolCall.name,
            toolCallId: context.toolCall.id,
            params: asRecord(context.args),
            result: null,
            status: "blocked",
            errorType: "guard_blocked",
            // 被阻断的调用不走 afterToolCall，摘要只能在这里算（结果为空、原因来自 guard）
            summary: buildToolCallSummary({
              toolName: context.toolCall.name,
              details: {},
              isError: false,
              blockedReason: verdict.reason,
            }),
          });
        } catch (error) {
          await notePersistFailure("beforeToolCall/blocked", error);
        }
        // 注意 checkToolAllowed 放行时返回 { allowed: true } 且**没有** reason 字段：
        // 若写成 return { block: verdict.allowed, reason: verdict.reason }，
        // 放行路径会得到 { block: true }，把**每一个**工具调用都阻断。必须显式分支。
        return { block: true, reason: verdict.reason };
      }

      try {
        entry.rowId = await persistToolCallRow({
          runId,
          stepIndex: step,
          toolName: context.toolCall.name,
          toolCallId: context.toolCall.id,
          params: asRecord(context.args),
          result: null,
          status: "running",
        });
      } catch (error) {
        // 落库失败不阻断执行：afterToolCall 里会用已分配的 stepIndex 补一条终态记录
        await notePersistFailure("beforeToolCall/running", error);
      }
      return undefined;
    },
    afterToolCall: async (context) => {
      const entry = toolCallRows.get(context.toolCall.id);
      const details = asRecord(context.result.details);
      const isError = context.isError;
      const durationMs = entry ? Date.now() - entry.startedAt : null;
      // 摘要与结果同一次写入：落库时是唯一同时握有「工具 + 结果」的时刻（D21）
      const summary = buildToolCallSummary({ toolName: context.toolCall.name, details, isError });
      // 失败调用的 details 恒为 {}（Pi 把错误文本放在 content 里），而首屏不回放
      // tool_execution_end 事件 —— 不补这一条，卡片摘要承诺的「展开可见错误详情」
      // 在刷新后就无处可看。**只替换落库用的对象**：details 仍原样用于摘要与工件抽取。
      const errorText = isError ? extractMessageText(context.result.content) : "";
      const persistedResult =
        isError && errorText && Object.keys(details).length === 0 ? { error: errorText } : details;

      // 1) 工具调用落库（正常执行路径）
      try {
        if (entry?.rowId != null) {
          await finalizeToolCallRow({
            id: entry.rowId,
            result: persistedResult,
            status: isError ? "failed" : "succeeded",
            errorType: isError ? "tool_error" : null,
            durationMs,
            summary,
          });
        } else {
          // 行 id 必须写回条目：否则 subscribe 在 tool_execution_end 时会以为「没有落库」
          // 而再补一行，产生重复审计行
          const rowId = await persistToolCallRow({
            runId,
            stepIndex: entry?.stepIndex ?? stepIndex,
            toolName: context.toolCall.name,
            toolCallId: context.toolCall.id,
            params: asRecord(context.args),
            result: persistedResult,
            status: isError ? "failed" : "succeeded",
            errorType: isError ? "tool_error" : null,
            durationMs,
            summary,
          });
          if (entry) entry.rowId = rowId;
        }
      } catch (error) {
        await notePersistFailure("afterToolCall/toolCall", error);
      }

      // 2) 工件抽取：只认结构化 details（extractArtifacts 的单一真相源）
      if (!isError) {
        try {
          for (const artifact of extractArtifacts(context.toolCall.name, details)) {
            await persistEvent(runId, { type: "artifact", ...artifact });
          }
        } catch (error) {
          await notePersistFailure("afterToolCall/artifact", error);
        }
      }

      // 3) 结果摘要：只改模型可见的 content，**绝不改 details**（extractArtifacts 依赖它）。
      //    出错时不改 —— 错误文本必须原样给模型看；details 为空时也不改，避免把
      //    工具自己写的 content 覆盖成 "{}"。
      if (isError || Object.keys(details).length === 0) return undefined;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(summarizeToolResult(details, SUMMARY_LIST_LIMIT)) }],
      };
    },
    toolExecution: "sequential",
    sessionId: `conv-${options.conversationId}`,
  });

  // 事件 → 落库（subscribe 只能观察，不能改写工具结果）
  agent.subscribe(async (event: unknown) => {
    const record = event as Record<string, unknown>;

    // agent_end 之前先落终态结论。两个原因：
    //   1. agent_end 必须是事件序列的最后一项（SSE 的「流已结束」契约）；
    //   2. 该结论是唯一记录「为什么失败」的可读文本 —— message_end 的 errorMessage
    //      被 serializeEventForDb 剔除了，而 agent_runs 只存 errorType、没有消息字段。
    // Pi 按订阅顺序 await 监听器（agent.js: "await listener(event, signal)"），
    // 且 waitForIdle() 要等 agent_end 的监听器结算完才 resolve，故两次落库不会乱序。
    if (record.type === "agent_end") {
      try {
        const outcome = buildOutcome();
        await persistEvent(runId, {
          type: "status",
          level: outcome.status === "succeeded" ? "info" : "error",
          message: outcome.message,
        });
      } catch (error) {
        console.error("[agent] 落库失败（终态结论）", error);
      }
    }

    // 回填必须在事件行落库**之前**：SSE 出口是「查到事件行就转发」，摘要靠转发那一刻
    // 查 agent_tool_calls 补齐 —— 若先落事件行，就会出现「事件已转发、审计行还没写完」的
    // 窗口，转发出去的帧没有摘要（正是本回填要消灭的症状）。
    //
    // 三类「没走到钩子」的调用（工具名不存在 / 参数校验失败 / 输出被 length 截断）不会在
    // beforeToolCall / afterToolCall 里落行，前端因此会收到没有卡片、没有摘要的帧。
    // 用事件载荷补一行 —— 事件里带着 toolCallId / toolName / result / isError，
    // 缺的只是入参（在 tool_execution_start 时已存进条目）。
    if (record.type === "tool_execution_end") {
      const backfillId = String(record.toolCallId ?? "");
      const backfillEntry = toolCallRows.get(backfillId);
      if (backfillEntry && backfillEntry.rowId === null) {
        try {
          const rawResult = asRecord(record.result);
          const backfillDetails = asRecord(rawResult.details);
          const backfillIsError = Boolean(record.isError);
          const backfillErrorText = backfillIsError ? extractMessageText(rawResult.content) : "";
          const toolName = String(record.toolName ?? "");
          backfillEntry.rowId = await persistToolCallRow({
            runId,
            stepIndex: backfillEntry.stepIndex,
            toolName,
            toolCallId: backfillId,
            params: backfillEntry.params,
            // 与 afterToolCall 同一处理：失败调用的 details 恒为 {}，错误文本在 content 里，
            // 不补这一条，卡片展开就是空的
            result:
              backfillIsError && backfillErrorText && Object.keys(backfillDetails).length === 0
                ? { error: backfillErrorText }
                : backfillDetails,
            status: backfillIsError ? "failed" : "succeeded",
            errorType: backfillIsError ? "not_executed" : null,
            // 短路的调用没有 durationMs：用条目里的起始时刻兜底
            durationMs: typeof record.durationMs === "number" ? record.durationMs : Date.now() - backfillEntry.startedAt,
            summary: buildToolCallSummary({
              toolName,
              details: backfillDetails,
              isError: backfillIsError,
              // 加前缀让用户看得出「根本没执行」而不是「执行后失败」——
              // 三类短路的原始原因都是 Pi 的英文报文
              failureReason: backfillErrorText ? `未执行：${backfillErrorText}` : null,
            }),
          });
        } catch (error) {
          await notePersistFailure("subscribe/toolCallBackfill", error);
        }
      }
    }

    try {
      await persistEvent(runId, record);
    } catch (error) {
      console.error("[agent] 事件落库失败", error);
    }

    // 每个工具调用都会先发 tool_execution_start（含被短路的那些），因此在这里分配序号与起始时刻。
    // 已有条目时不覆盖：那说明 beforeToolCall 已经跑过（当前 Pi 不会，但顺序是外部契约），
    // 覆盖会把已落库的行 id 冲掉，进而在 tool_execution_end 时补出重复行。
    if (record.type === "tool_execution_start") {
      const startId = String(record.toolCallId ?? "");
      if (!toolCallRows.has(startId)) {
        toolCallRows.set(startId, {
          rowId: null,
          stepIndex,
          startedAt: Date.now(),
          params: asRecord(record.args),
        });
        stepIndex += 1;
      }
    }

    // 逐轮累计 token：usage 只在 message_end 的最终消息上完整
    if (record.type === "message_end") {
      const message = record.message as Partial<AssistantMessage> | undefined;
      if (message?.role === "assistant") {
        finalAssistant = message as AssistantMessage;
        tokensUsed += Number(message.usage?.totalTokens ?? 0);
      }
    }

    // 连续失败计数（含被阻断的调用：阻断同样是「模型做错了」的信号）
    if (record.type === "tool_execution_end") {
      const failure = failureTracker.record(!record.isError);
      if (failure.exceeded && !abortReason) {
        abortReason = "tool_failures";
        try {
          await persistEvent(runId, {
            type: "status",
            level: "error",
            message: `连续 ${failure.count} 次工具调用失败，已停止执行`,
          });
        } catch (error) {
          console.error("[agent] 落库失败（失败计数）", error);
        }
        agent.abort();
      }
    }
  });

  // 墙钟超时：到点中止循环（已产出的工件仍然有效）。
  // 必须显式记录中止原因 —— abort() 只是中止 AbortController，waitForIdle() 会正常 resolve。
  let runFinished = false;
  const timeoutTimer = setTimeout(() => {
    // 循环已结束时不要改写中止原因：否则会把成功的 Run 误报成超时
    if (runFinished) return;
    abortReason = "timeout";
    void persistEvent(runId, {
      type: "status",
      level: "warning",
      message: `执行超过 ${Math.round(runTimeoutMs / 60_000)} 分钟，已中止`,
    }).catch(() => undefined);
    agent.abort();
  }, runTimeoutMs);

  try {
    await agent.prompt(userMessage);
    // 关键：waitForIdle() 不会因失败而 reject，失败被编码在 stopReason 里（见 resolveLoopOutcome）
    await agent.waitForIdle();
  } catch (error) {
    // 兜底：prompt 的前置校验等仍可能抛错
    await persistEvent(runId, { type: "error", message: (error as Error).message }).catch(() => undefined);
    return { status: "failed", errorType: "loop_error", tokensUsed, stepCount: stepIndex };
  } finally {
    runFinished = true;
    clearTimeout(timeoutTimer);
  }

  // 终态结论已由 agent_end 的监听器落库（见 subscribe），此处只取同一结果作返回值
  const outcome = buildOutcome();

  // 最终答复落库（失败/超时时若有部分文本也保留，前端按 Run 状态展示）
  const answerText = finalAssistant ? extractAssistantText(finalAssistant) : "";
  if (persistMessage && answerText) {
    try {
      await persistMessage({ role: "assistant", content: answerText, usage: finalAssistant?.usage });
    } catch (error) {
      await notePersistFailure("persistMessage", error);
    }
  }

  return { status: outcome.status, errorType: outcome.errorType, tokensUsed, stepCount: stepIndex };
}
