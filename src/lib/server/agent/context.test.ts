/**
 * 上下文装配单元测试
 * 覆盖：字符预算裁剪、system 不裁、工具调用与结果配对不拆散、工具结果摘要
 */
import { describe, expect, it } from "vitest";
import { estimateChars, pruneByCharBudget, summarizeToolResult } from "./context";

/** 造一条 user 消息 */
function userMsg(text: string) {
  return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as never;
}

/** 造一条 assistant 消息（带一个 toolCall） */
function assistantWithToolCall(id: string, toolName: string) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: toolName, arguments: {} }],
    timestamp: 0,
  } as never;
}

/**
 * 造一条「带正文 + toolCall」的 assistant 消息。
 *
 * 修正循环的测试必须用这个：estimateChars 只统计 text 块、对 toolCall 块计 0 字符，
 * 所以纯 toolCall 的 assistant 永远放得进预算，切点根本落不到 toolResult 上，
 * 那样测出来的「无孤立 toolResult」是假通过 —— 删掉修正循环测试照样绿。
 */
function assistantWithTextAndToolCall(id: string, toolName: string, text: string) {
  return {
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "toolCall", id, name: toolName, arguments: {} },
    ],
    timestamp: 0,
  } as never;
}

/** 造一条 toolResult 消息 */
function toolResult(id: string, text: string) {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "x",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  } as never;
}

/** 造一条 system 消息 */
function systemMsg(text: string) {
  return { role: "system", content: text, timestamp: 0 } as never;
}

describe("estimateChars（字符数估算）", () => {
  it("数字符串内容长度", () => {
    expect(estimateChars(userMsg("abcd"))).toBeGreaterThanOrEqual(4);
  });

  it("空消息返回 0 附近的小值", () => {
    expect(estimateChars(systemMsg(""))).toBeLessThan(10);
  });

  it("toolCall 块的 arguments 也计入字符数", () => {
    const withArgs = {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "x", arguments: { topic: "A".repeat(100) } }],
      timestamp: 0,
    } as never;
    expect(estimateChars(withArgs)).toBeGreaterThan(100);
  });
});

describe("pruneByCharBudget（按字符预算裁剪）", () => {
  it("预算充足时原样返回", () => {
    const messages = [systemMsg("系统"), userMsg("你好")];
    expect(pruneByCharBudget(messages, 10_000)).toHaveLength(2);
  });

  it("预算不足时丢弃最老的消息", () => {
    const messages = [
      systemMsg("系统"),
      userMsg("A".repeat(500)),
      userMsg("B".repeat(500)),
      userMsg("最新的消息"),
    ];
    const result = pruneByCharBudget(messages, 600);
    expect(result.length).toBeLessThan(messages.length);
    expect(JSON.stringify(result)).toContain("最新的消息");
  });

  it("system 消息永不被裁剪", () => {
    const messages = [systemMsg("系统提示必须保留"), userMsg("A".repeat(5000))];
    const result = pruneByCharBudget(messages, 10);
    expect(result.some((m) => (m as { role: string }).role === "system")).toBe(true);
  });

  it("不留下孤立的 toolResult（其 assistant 已被裁掉时一并裁掉）", () => {
    const messages = [
      systemMsg("系统"),
      assistantWithToolCall("call-1", "topic_generate"),
      toolResult("call-1", "A".repeat(2000)),
      userMsg("新问题"),
    ];
    const result = pruneByCharBudget(messages, 400);
    const hasOrphan = result.some((m) => (m as { role: string }).role === "toolResult");
    expect(hasOrphan).toBe(false);
  });

  it("切点恰好落在 toolResult 时被修正循环推进（真正守护孤立不变量）", () => {
    // 上一个用例是「假通过」：那里 toolResult 有 2000 字符，永远放不进 400 的预算，
    // 切点会落在 user 消息上，修正循环一次都不执行 —— 把它删掉测试照样绿。
    // 这里用带正文的 assistant（计 50 字符）+ 500 字符 toolResult + 2 字符 user，
    // 预算取 520：正好容得下 user + toolResult，容不下 assistant，
    // 于是切点停在 toolResult 上，必须靠修正循环推进。
    const messages = [
      systemMsg(""),
      assistantWithTextAndToolCall("call-1", "topic_generate", "字".repeat(50)),
      toolResult("call-1", "A".repeat(500)),
      userMsg("短"),
    ];
    const result = pruneByCharBudget(messages, 520) as Array<{ role: string }>;
    // 修正循环未生效时结果是 [..., toolResult, user]，孤立结果会留给模型
    expect(result.some((m) => m.role === "toolResult")).toBe(false);
    // 同时最新的 user 消息必须保留（不能为了消除孤立把有效内容一起丢掉）
    expect(result.some((m) => m.role === "user")).toBe(true);
    // assistant 与其 toolResult 应当成对消失
    expect(result.some((m) => m.role === "assistant")).toBe(false);
  });

  it("预算小于 system 时仍保留最新 user 消息（否则模型拿不到任何指令）", () => {
    const messages = [systemMsg("S".repeat(5000)), userMsg("这是一定要保留的指令")];
    const result = pruneByCharBudget(messages, 10);
    expect(JSON.stringify(result)).toContain("这是一定要保留的指令");
  });

  it("保留 assistant 工具调用时其 toolResult 也保留", () => {
    const messages = [
      systemMsg("系统"),
      assistantWithToolCall("call-1", "topic_generate"),
      toolResult("call-1", "结果内容"),
    ];
    const result = pruneByCharBudget(messages, 10_000);
    expect(result).toHaveLength(3);
  });
});

describe("summarizeToolResult（工具结果摘要）", () => {
  it("列表超过上限时截断并保留总数", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: i, title: `笔记${i}` }));
    const summary = summarizeToolResult({ items }) as {
      items: unknown[];
      totals: Record<string, number>;
      truncated: boolean;
    };
    expect(summary.items).toHaveLength(10);
    expect(summary.totals.items).toBe(50);
    expect(summary.truncated).toBe(true);
  });

  it("列表未超上限时不截断", () => {
    const summary = summarizeToolResult({ items: [{ id: 1 }] }) as {
      totals: Record<string, number>;
      truncated: boolean;
    };
    expect(summary.totals.items).toBe(1);
    expect(summary.truncated).toBe(false);
  });

  it("非列表结果原样返回", () => {
    expect(summarizeToolResult({ draft_id: 12 })).toEqual({ draft_id: 12 });
  });

  it("支持自定义上限", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    const summary = summarizeToolResult({ items }, 3) as { items: unknown[] };
    expect(summary.items).toHaveLength(3);
  });

  it("多个数组键同时截断，且各自给出原始条数（topic_generate 场景）", () => {
    const summary = summarizeToolResult({
      suggestion_ids: Array.from({ length: 20 }, (_, i) => i + 1),
      titles: Array.from({ length: 20 }, (_, i) => `标题${i}`),
      count: 20,
    }) as {
      suggestion_ids: unknown[];
      titles: unknown[];
      totals: Record<string, number>;
      truncated: boolean;
      count: number;
    };
    // 两个数组必须同步截断，否则 id 与标题会错位
    expect(summary.suggestion_ids).toHaveLength(10);
    expect(summary.titles).toHaveLength(10);
    expect(summary.totals).toEqual({ suggestion_ids: 20, titles: 20 });
    expect(summary.truncated).toBe(true);
    expect(summary.count).toBe(20);
  });
});
