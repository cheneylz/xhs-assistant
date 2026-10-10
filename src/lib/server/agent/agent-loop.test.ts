/**
 * Agent 循环集成测试（离线）
 *
 * 关键：注入假 streamFn 与假落库函数 —— 不调真实 LLM、不连数据库、不烧 token。
 * 覆盖「思考 → 调工具 → 看结果 → 收尾」全流程，以及两条必须失败的路径与多轮历史。
 */
import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import {
  buildToolCatalogText,
  resolveLoopOutcome,
  runAgentLoop,
  type FinalizeToolCallFn,
  type PersistToolCallFn,
  type RunAgentLoopOptions,
  type StoredMessage,
} from "./agent-loop.mts";
import { SKILL_CATALOG } from "./skill-catalog";

/** 空 usage，只为满足 AssistantMessage 形状 */
const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 造一条助手文本消息 */
function assistantText(text: string, stopReason = "stop") {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "openai-completions",
    provider: "openai-compatible",
    model: "fake-model",
    usage: { ...EMPTY_USAGE, totalTokens: 10 },
    stopReason,
    timestamp: 0,
  } as Record<string, unknown>;
}

/** 造一条「要调工具」的助手消息 */
function assistantToolCall(toolCallId: string, toolName: string, args: Record<string, unknown>) {
  return {
    ...assistantText(""),
    content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: args }],
    stopReason: "toolUse",
  };
}

/**
 * 把一条最终助手消息包装成 pi 期望的 AssistantMessageEventStream。
 * 只发 done：循环从 result() 取最终消息，中间增量事件只用于渲染。
 */
function createFakeStream(message: Record<string, unknown>) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "done" };
    },
    result: async () => message,
  };
}

/** 按脚本依次返回助手消息的假 streamFn；脚本用完后返回空 stop 消息以结束循环 */
function createScriptedStreamFn(script: Array<Record<string, unknown>>) {
  let turn = 0;
  return (() => {
    const message = script[turn] ?? assistantText("");
    turn += 1;
    return createFakeStream(message);
  }) as never;
}

/** 记录「模型实际看到了什么」的假 streamFn */
function createCapturingStreamFn(seen: Array<Record<string, unknown>>, reply: string) {
  let turn = 0;
  return ((_model: unknown, context: { messages?: Array<Record<string, unknown>> }) => {
    seen.push(...(context?.messages ?? []));
    turn += 1;
    return createFakeStream(assistantText(turn === 1 ? reply : ""));
  }) as never;
}

/**
 * 构造一个「不返回」的假 streamFn：只在收到中止信号后结束，并把 stopReason 置为 aborted
 * —— 与真实 streamSimple 被中止时的行为一致。
 */
function createHangingStreamFn() {
  return ((_model: unknown, _context: unknown, streamOptions?: { signal?: AbortSignal }) => {
    const signal = streamOptions?.signal;
    return {
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        // 一个事件都不发：循环会走「流结束但无事件」的兜底路径，取 result() 作为最终消息
      },
      result: async () => assistantText("", "aborted"),
    };
  }) as never;
}

/** 不碰数据库、不碰网络的假工具 */
function createFakeTool(
  name: string,
  output: Record<string, unknown>,
  parameters: ReturnType<typeof Type.Object> = Type.Object({}),
) {
  return {
    name,
    label: name,
    description: "假工具（测试用）",
    parameters,
    replay: "never",
    execute: async () => ({
      content: [{ type: "text", text: JSON.stringify(output) }],
      details: output,
    }),
  } as never;
}

/**
 * 造一个 execute 会抛错的假工具。
 *
 * 复现 Pi 的失败路径：抛错被 Pi 捕获后转成 isError + 错误文本，且 details 恒为 {}
 * （错误正文只在 content 里）—— 这就是「卡片展开没内容可看」的根因形态。
 */
function createThrowingTool(name: string, message: string) {
  return {
    name,
    label: name,
    description: "假工具（测试用，执行必抛错）",
    parameters: Type.Object({}),
    replay: "never",
    execute: async () => {
      throw new Error(message);
    },
  } as never;
}

/** 假落库实现：把每次调用记进数组，便于断言 */
function createFakePersisters() {
  const events: Array<Record<string, unknown>> = [];
  const messages: Array<{ role: string; content: string }> = [];
  const started: Array<Parameters<PersistToolCallFn>[0]> = [];
  const finalized: Array<Parameters<FinalizeToolCallFn>[0]> = [];
  return {
    events,
    messages,
    started,
    finalized,
    persistEvent: vi.fn(async (_runId: number, event: Record<string, unknown>): Promise<string> => {
      events.push(event);
      return String(events.length);
    }),
    persistMessage: vi.fn(async (message: { role: string; content: string }): Promise<void> => {
      messages.push(message);
    }),
    persistToolCall: vi.fn(async (options: Parameters<PersistToolCallFn>[0]): Promise<number> => {
      started.push(options);
      return started.length;
    }),
    finalizeToolCall: vi.fn(async (options: Parameters<FinalizeToolCallFn>[0]): Promise<void> => {
      finalized.push(options);
    }),
  };
}

/** 最小参数集 */
function baseOptions(overrides: Partial<RunAgentLoopOptions> = {}) {
  const fake = createFakePersisters();
  const options: RunAgentLoopOptions = {
    runId: 1,
    conversationId: 1,
    userId: 1,
    userMessage: "你好",
    // 只用到 api / provider / id / contextWindow 四个字段
    model: {
      id: "fake-model",
      api: "openai-completions",
      provider: "openai-compatible",
      contextWindow: 128_000,
    } as never,
    tools: [],
    systemPrompt: "系统提示",
    persistEvent: fake.persistEvent,
    persistMessage: fake.persistMessage,
    persistToolCall: fake.persistToolCall,
    finalizeToolCall: fake.finalizeToolCall,
    ...overrides,
  };
  return { fake, options };
}

describe("buildToolCatalogText（工具目录文本）", () => {
  it("列出全部 13 个技能的 skillKey 与描述", () => {
    const text = buildToolCatalogText();
    expect(SKILL_CATALOG).toHaveLength(13);
    for (const definition of SKILL_CATALOG) {
      expect(text, `目录文本缺少 ${definition.skillKey}`).toContain(definition.skillKey);
      expect(text, `目录文本缺少 ${definition.name}`).toContain(definition.name);
    }
  });
});

describe("resolveLoopOutcome（终态映射）", () => {
  it("stopReason 为 stop 时记为 succeeded", () => {
    expect(resolveLoopOutcome({ stopReason: "stop" }).status).toBe("succeeded");
  });

  it("stopReason 为 error 时记为 failed（Key 无效 / 限流 / provider 5xx 都走这条）", () => {
    const outcome = resolveLoopOutcome({ stopReason: "error", errorMessage: "invalid api key" });
    expect(outcome.status).toBe("failed");
    expect(outcome.errorType).toBe("model_error");
  });

  it("stopReason 为 length 时记为 failed", () => {
    expect(resolveLoopOutcome({ stopReason: "length" }).status).toBe("failed");
  });

  it("无本地中止原因时 aborted 记为 cancelled（外部中止）", () => {
    expect(resolveLoopOutcome({ stopReason: "aborted" }).status).toBe("cancelled");
  });

  it("本地中止原因优先：超时 → failed(timeout)", () => {
    const outcome = resolveLoopOutcome({ abortReason: "timeout", stopReason: "aborted" });
    expect(outcome.status).toBe("failed");
    expect(outcome.errorType).toBe("timeout");
  });

  it("本地中止原因优先：连续工具失败 → failed(tool_failures)", () => {
    const outcome = resolveLoopOutcome({ abortReason: "tool_failures", stopReason: "aborted" });
    expect(outcome.status).toBe("failed");
    expect(outcome.errorType).toBe("tool_failures");
  });

  it("stopReason 缺失或未知时 fail-closed 记为 failed（绝不能默认 succeeded）", () => {
    expect(resolveLoopOutcome({}).status).toBe("failed");
    expect(resolveLoopOutcome({ stopReason: "whatever" }).status).toBe("failed");
  });
});

describe("runAgentLoop（循环编排）", () => {
  it("事件按顺序落库，agent_start 在最前、agent_end 在最后", async () => {
    const { fake, options } = baseOptions({ fakeStreamFn: createScriptedStreamFn([assistantText("你好，我是运营助手。")]) });
    await runAgentLoop(options);

    const types = fake.events.map((event) => String(event.type));
    expect(types[0]).toBe("agent_start");
    expect(types[types.length - 1]).toBe("agent_end");
  });

  it("模型不调用工具时直接收尾：产出助手消息、记为 succeeded，且 token 有计量", async () => {
    const { fake, options } = baseOptions({ fakeStreamFn: createScriptedStreamFn([assistantText("你好，我是运营助手。")]) });
    const result = await runAgentLoop(options);

    expect(result.status).toBe("succeeded");
    expect(result.stepCount).toBe(0);
    // 假消息的 usage.totalTokens 为 10 —— 证明 usage 被累计（C5）
    expect(result.tokensUsed).toBe(10);
    expect(fake.messages.some((message) => message.role === "assistant")).toBe(true);
  });

  it("模型返回 stopReason=error 时记为 failed，而不是 succeeded", async () => {
    const { options } = baseOptions({ fakeStreamFn: createScriptedStreamFn([assistantText("", "error")]) });
    const result = await runAgentLoop(options);

    expect(result.status).toBe("failed");
    expect(result.errorType).toBe("model_error");
  });

  it("墙钟超时中止后记为 failed(timeout)", async () => {
    const { options } = baseOptions({ fakeStreamFn: createHangingStreamFn(), runTimeoutMs: 30 });
    const result = await runAgentLoop(options);

    expect(result.status).toBe("failed");
    expect(result.errorType).toBe("timeout");
  });

  it("工具调用落库为 running → succeeded，并按 stepIndex 记录", async () => {
    const items = Array.from({ length: 3 }, (_, i) => i + 1);
    const { fake, options } = baseOptions({
      tools: [createFakeTool("topic_generate", { suggestion_ids: items, titles: ["A", "B", "C"] }, Type.Object({ count: Type.Optional(Type.Number()) }))],
      fakeStreamFn: createScriptedStreamFn([
        assistantToolCall("call-1", "topic_generate", { count: 3 }),
        assistantText("已完成"),
      ]),
    });
    const result = await runAgentLoop(options);

    expect(fake.started).toHaveLength(1);
    expect(fake.started[0]).toMatchObject({ stepIndex: 0, toolName: "topic_generate", status: "running", params: { count: 3 } });
    expect(fake.finalized).toHaveLength(1);
    expect(fake.finalized[0]).toMatchObject({ id: 1, status: "succeeded" });
    expect(result.stepCount).toBe(1);
    // 3 个选题 → 3 条工件事件
    expect(fake.events.filter((event) => event.type === "artifact")).toHaveLength(3);
  });

  it("结果摘要只改模型可见的 content，details 保持完整（多数组键同时截断）", async () => {
    const { fake, options } = baseOptions({
      tools: [
        createFakeTool("topic_generate", {
          suggestion_ids: Array.from({ length: 20 }, (_, i) => i + 1),
          titles: Array.from({ length: 20 }, (_, i) => `标题${i}`),
          count: 20,
        }),
      ],
      fakeStreamFn: createScriptedStreamFn([
        assistantToolCall("call-1", "topic_generate", {}),
        assistantText("已完成"),
      ]),
    });
    await runAgentLoop(options);

    // 模型看到的是 toolResult 消息的 content —— 必须是摘要（截断 + 原始条数）
    const toolResultEvent = fake.events.find(
      (event) => event.type === "message_end" && (event.message as { role?: string })?.role === "toolResult",
    );
    const text = ((toolResultEvent?.message as { content?: Array<{ text?: string }> })?.content ?? [])
      .map((block) => block.text ?? "")
      .join("");
    const summary = JSON.parse(text) as {
      truncated?: boolean;
      totals?: Record<string, number>;
      suggestion_ids?: unknown[];
      titles?: unknown[];
    };
    expect(summary.truncated).toBe(true);
    expect(summary.totals).toEqual({ suggestion_ids: 20, titles: 20 });
    // 两个数组必须同步截断，否则 id 与标题错位
    expect(summary.suggestion_ids).toHaveLength(10);
    expect(summary.titles).toHaveLength(10);
    // details 未被摘要污染：工件抽取因此拿到的是完整产出
    expect(fake.finalized[0]?.result).toMatchObject({ count: 20 });
    expect(((fake.finalized[0]?.result as { titles?: unknown[] })?.titles ?? [])).toHaveLength(20);
  });

  it("护栏阻断的调用落一条 blocked 记录，且不中断整体流程", async () => {
    const { fake, options } = baseOptions({
      tools: [createFakeTool("not_exist", {})],
      fakeStreamFn: createScriptedStreamFn([
        assistantToolCall("call-1", "not_exist", {}),
        assistantText("该工具不可用，已放弃"),
      ]),
    });
    const result = await runAgentLoop(options);

    expect(fake.started).toHaveLength(1);
    expect(fake.started[0]).toMatchObject({ toolName: "not_exist", status: "blocked", errorType: "guard_blocked" });
    // 阻断走的是 immediate 分支，不会进 afterToolCall
    expect(fake.finalized).toHaveLength(0);
    expect(result.status).toBe("succeeded");
  });

  it("工具调用落库时带上摘要（D21）", async () => {
    const { fake, options } = baseOptions({
      tools: [createFakeTool("hot_refresh", { collected: 87 })],
      fakeStreamFn: createScriptedStreamFn([
        assistantToolCall("call-1", "hot_refresh", {}),
        assistantText("热点已刷新"),
      ]),
    });
    await runAgentLoop(options);

    expect(fake.finalized).toHaveLength(1);
    expect(fake.finalized[0]?.summary).toBe("收录 87 条热点");
  });

  it("工具执行失败时落库可读错误文本（首屏不回放 tool_execution_end，卡片展开要有内容）", async () => {
    const { fake, options } = baseOptions({
      tools: [createThrowingTool("hot_refresh", "小红书接口超时")],
      fakeStreamFn: createScriptedStreamFn([
        assistantToolCall("call-1", "hot_refresh", {}),
        assistantText("热点刷新失败"),
      ]),
    });
    await runAgentLoop(options);

    expect(fake.finalized).toHaveLength(1);
    expect(fake.finalized[0]?.status).toBe("failed");
    // 失败调用的 details 是 {}，落库必须补上错误正文，否则刷新后卡片展开空无一物
    expect(fake.finalized[0]?.result).toMatchObject({ error: "小红书接口超时" });
    expect(fake.finalized[0]?.summary).toBe("执行失败（展开可见错误详情）");
  });

  it("beforeToolCall 落库失败时走兜底分支，终态记录仍带摘要", async () => {
    const { fake, options } = baseOptions({
      tools: [createFakeTool("hot_refresh", { collected: 87 })],
      fakeStreamFn: createScriptedStreamFn([
        assistantToolCall("call-1", "hot_refresh", {}),
        assistantText("完成"),
      ]),
    });
    // 第一次落库（running）失败 → entry.rowId 保持 null → afterToolCall 走 persistToolCall 兜底分支
    fake.persistToolCall.mockRejectedValueOnce(new Error("数据库抖动"));
    await runAgentLoop(options);

    // 两次落库尝试：第一次（running）被拒，第二次是兜底写的终态记录
    expect(fake.persistToolCall.mock.calls).toHaveLength(2);
    expect(fake.persistToolCall.mock.calls[0]?.[0]).toMatchObject({ status: "running" });
    // 被拒的那次没进 started 数组，因此 started[0] 就是兜底的终态记录
    expect(fake.started).toHaveLength(1);
    expect(fake.started[0]).toMatchObject({ status: "succeeded" });
    expect(fake.started[0]?.summary).toBe("收录 87 条热点");
    // 没有 rowId → 不走 finalize 分支（终态记录由兜底 persistToolCall 写入）
    expect(fake.finalized).toHaveLength(0);
  });

  it("阻断路径的摘要用 guard 的 reason（该路径不写 finalized）", async () => {
    const { fake, options } = baseOptions({
      tools: [createFakeTool("not_exist", {})],
      fakeStreamFn: createScriptedStreamFn([assistantToolCall("call-1", "not_exist", {}), assistantText("放弃")]),
    });
    await runAgentLoop(options);

    expect(fake.finalized).toHaveLength(0);
    expect(fake.started[0]?.summary).toContain("未在技能目录中注册");
  });

  it("多轮：第二次运行能读到第一次的消息，孤立的 tool 历史被丢弃", async () => {
    const history: StoredMessage[] = [
      { role: "user", content: "第一轮的提问", toolCallId: null },
      { role: "assistant", content: "第一轮的回答", toolCallId: null },
      { role: "tool", content: "上一轮的工具产出", toolCallId: "call-9" },
    ];
    const seen: Array<Record<string, unknown>> = [];
    const { options } = baseOptions({
      userMessage: "接着上一轮继续",
      historyMessages: history,
      fakeStreamFn: createCapturingStreamFn(seen, "好的"),
    });
    await runAgentLoop(options);

    const text = JSON.stringify(seen);
    expect(text).toContain("第一轮的提问");
    expect(text).toContain("第一轮的回答");
    expect(text).toContain("接着上一轮继续");
    // 没有配对 toolCall 的 toolResult 会被 provider 拒绝，P0 直接丢弃
    expect(text).not.toContain("上一轮的工具产出");
  });

  it("charBudget/2 不小于上下文窗口时直接失败，不发请求", async () => {
    let called = 0;
    const { options } = baseOptions({
      charBudget: 300_000, // 300000 / 2 = 150000 > 128000
      fakeStreamFn: (() => {
        called += 1;
        return createFakeStream(assistantText("不该被调用"));
      }) as never,
    });
    const result = await runAgentLoop(options);

    expect(result.status).toBe("failed");
    expect(result.errorType).toBe("char_budget_exceeds_context_window");
    expect(called).toBe(0);
  });

  it("工具名不存在（没走到任何钩子）的调用由事件回填审计行", async () => {
    // 只注册 hot_refresh：脚本里调 not_exist，Pi 会在 prepareToolCall 阶段直接短路，
    // 既不进 beforeToolCall 也不进 afterToolCall —— 没有回填就没有任何审计行
    const { fake, options } = baseOptions({
      tools: [createFakeTool("hot_refresh", { collected: 1 })],
      fakeStreamFn: createScriptedStreamFn([
        assistantToolCall("call-1", "not_exist", {}),
        assistantText("该工具不存在，我换个方式"),
      ]),
    });
    await runAgentLoop(options);

    expect(fake.started).toHaveLength(1);
    expect(fake.started[0]).toMatchObject({
      toolName: "not_exist",
      toolCallId: "call-1",
      status: "failed",
      errorType: "not_executed",
      stepIndex: 0,
    });
    // 摘要必须非空（B 块靠它渲染卡片；「工具不存在」也比泛泛的「执行失败」有用）
    expect(fake.started[0]?.summary ?? "").toContain("not found");
  });

  it("回填不破坏 stepIndex 连续性（短路调用也占一个序号）", async () => {
    const { fake, options } = baseOptions({
      tools: [createFakeTool("hot_refresh", { collected: 87 })],
      fakeStreamFn: createScriptedStreamFn([
        assistantToolCall("call-1", "not_exist", {}),
        assistantToolCall("call-2", "hot_refresh", {}),
        assistantText("完成"),
      ]),
    });
    await runAgentLoop(options);

    // 两次调用各占一个序号：短路调用（无 rowId）由回填写终态，真实调用先写 running、终态走 finalize。
    // 注意 started 也记录 running 行，因此终态断言要分别落在 started（回填）与 finalized（finalize）上。
    expect(fake.started.map((row) => row.stepIndex)).toEqual([0, 1]);
    expect(fake.started[0]).toMatchObject({ status: "failed", errorType: "not_executed" });
    expect(fake.started[1]).toMatchObject({ stepIndex: 1, status: "running" });
    expect(fake.finalized).toHaveLength(1);
    expect(fake.finalized[0]).toMatchObject({ status: "succeeded", summary: "收录 87 条热点" });
  });

  it("afterToolCall 的兜底落库会回填行 id，不产生重复审计行", async () => {
    const { fake, options } = baseOptions({
      tools: [createFakeTool("hot_refresh", { collected: 87 })],
      fakeStreamFn: createScriptedStreamFn([
        assistantToolCall("call-1", "hot_refresh", {}),
        assistantText("完成"),
      ]),
    });
    // 第一次落库（running）失败 → entry.rowId 保持 null → afterToolCall 走兜底分支
    fake.persistToolCall.mockRejectedValueOnce(new Error("数据库抖动"));
    await runAgentLoop(options);

    // 一共只该有两次落库尝试：失败的 running + 兜底的终态。
    // 若兜底没有把行 id 写回条目，事件侧的回填会再补一行（第三次）—— 那就是重复审计行
    expect(fake.persistToolCall.mock.calls).toHaveLength(2);
  });

  it("参数校验失败的调用也被回填（第二类短路）", async () => {
    // 工具声明了必填参数，脚本却给空对象 → Pi 的 validateToolArguments 抛错 → 短路，不进钩子
    const strictTool = {
      name: "hot_refresh",
      label: "热点采集",
      description: "测试用",
      parameters: Type.Object({ keyword: Type.String() }),
      replay: "never",
      execute: async () => ({ content: [{ type: "text" as const, text: "{}" }], details: {} }),
    } as never;
    const { fake, options } = baseOptions({
      tools: [strictTool],
      fakeStreamFn: createScriptedStreamFn([
        assistantToolCall("call-1", "hot_refresh", {}),
        assistantText("参数不对，我重新调"),
      ]),
    });
    await runAgentLoop(options);

    expect(fake.started).toHaveLength(1);
    expect(fake.started[0]).toMatchObject({ status: "failed", errorType: "not_executed", stepIndex: 0 });
    expect(fake.started[0]?.summary ?? "").toContain("未执行：");
  });

  it("输出被 length 截断的调用也被回填（第三类短路）", async () => {
    const { fake, options } = baseOptions({
      tools: [createFakeTool("hot_refresh", { collected: 1 })],
      fakeStreamFn: createScriptedStreamFn([
        { ...assistantToolCall("call-1", "hot_refresh", {}), stopReason: "length" },
        assistantText("输出被截断了"),
      ]),
    });
    await runAgentLoop(options);

    expect(fake.started).toHaveLength(1);
    expect(fake.started[0]).toMatchObject({ status: "failed", errorType: "not_executed" });
    expect(fake.started[0]?.summary ?? "").toContain("未执行：");
  });

  it("回填行带上了入参、可读错误与耗时兜底", async () => {
    const { fake, options } = baseOptions({
      tools: [createFakeTool("hot_refresh", { collected: 1 })],
      fakeStreamFn: createScriptedStreamFn([
        assistantToolCall("call-1", "not_exist", { keyword: "露营" }),
        assistantText("换个方式"),
      ]),
    });
    await runAgentLoop(options);

    const row = fake.started[0];
    // 入参来自 tool_execution_start 的 args（条目里存的）
    expect(row?.params).toMatchObject({ keyword: "露营" });
    // 失败且 details 为空时把错误文本塞进 result.error（否则卡片展开是空的）
    expect(row?.result).toMatchObject({ error: expect.stringContaining("not found") });
    // 短路调用没有 durationMs，用条目里的起始时刻兜底（必须是数字且非负）
    expect(typeof row?.durationMs).toBe("number");
    expect(row?.durationMs ?? -1).toBeGreaterThanOrEqual(0);
  });
});
