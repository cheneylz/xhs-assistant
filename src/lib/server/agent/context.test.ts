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
      assistantWithToolCall("call-1", "topic.generate"),
      toolResult("call-1", "A".repeat(2000)),
      userMsg("新问题"),
    ];
    const result = pruneByCharBudget(messages, 400);
    const hasOrphan = result.some((m) => (m as { role: string }).role === "toolResult");
    expect(hasOrphan).toBe(false);
  });

  it("保留 assistant 工具调用时其 toolResult 也保留", () => {
    const messages = [
      systemMsg("系统"),
      assistantWithToolCall("call-1", "topic.generate"),
      toolResult("call-1", "结果内容"),
    ];
    const result = pruneByCharBudget(messages, 10_000);
    expect(result).toHaveLength(3);
  });
});

describe("summarizeToolResult（工具结果摘要）", () => {
  it("列表超过上限时截断并保留总数", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: i, title: `笔记${i}` }));
    const summary = summarizeToolResult({ items }) as { items: unknown[]; total: number; truncated: boolean };
    expect(summary.items).toHaveLength(10);
    expect(summary.total).toBe(50);
    expect(summary.truncated).toBe(true);
  });

  it("列表未超上限时不截断", () => {
    const summary = summarizeToolResult({ items: [{ id: 1 }] }) as { total: number; truncated: boolean };
    expect(summary.total).toBe(1);
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
});
