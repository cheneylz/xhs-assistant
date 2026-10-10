import { describe, expect, it } from "vitest";
import type { AgentToolCard } from "./agent-state";
import {
  cutForDisplay,
  DETAIL_TEXT_LIMIT,
  formatToolDuration,
  resultTextForDisplay,
  statusViewFor,
  stringifyForDisplay,
} from "./tool-card-view";

function buildToolCard(overrides: Partial<AgentToolCard> = {}): AgentToolCard {
  return {
    runId: 1,
    toolCallId: "call_1",
    toolName: "hot_refresh",
    stepIndex: 0,
    status: "succeeded",
    summary: "",
    params: {},
    result: null,
    resultTruncated: false,
    errorType: null,
    durationMs: null,
    ...overrides,
  };
}

describe("statusViewFor（4 种状态 + 兜底）", () => {
  it("四种状态各有可辨识的颜色与中文标签（§7.2 第 3 条）", () => {
    expect(statusViewFor("running")).toEqual({ color: "processing", label: "运行中" });
    expect(statusViewFor("succeeded")).toEqual({ color: "success", label: "成功" });
    expect(statusViewFor("failed")).toEqual({ color: "error", label: "失败" });
    expect(statusViewFor("blocked")).toEqual({ color: "warning", label: "被阻断" });
  });

  it("未知状态兜底显示原始值，空串显示「未知」（不留空白徽标）", () => {
    expect(statusViewFor("cancelled")).toEqual({ color: "default", label: "cancelled" });
    expect(statusViewFor("")).toEqual({ color: "default", label: "未知" });
  });
});

describe("formatToolDuration", () => {
  it("毫秒转秒保留一位小数；null / undefined 都不显示（不会出现「NaNs」）", () => {
    expect(formatToolDuration(2100)).toBe("2.1s");
    expect(formatToolDuration(0)).toBe("0.0s");
    expect(formatToolDuration(null)).toBeNull();
    expect(formatToolDuration(undefined)).toBeNull();
  });
});

describe("cutForDisplay / stringifyForDisplay", () => {
  it("未超上限原样返回；超上限截断并带省略标记", () => {
    expect(cutForDisplay("abc", 5)).toBe("abc");
    expect(cutForDisplay("abcdef", 3)).toBe("abc…（已省略）");
  });

  it("截断点落在代理对中间时退一格（不产生孤立代理项）", () => {
    // "😀" 占两个 UTF-16 单元：limit=2 时正好切在中间
    const out = cutForDisplay("a😀b", 2);
    expect(out).toBe("a…（已省略）");
    expect(/[\uD800-\uDBFF]/.test(out)).toBe(false);
  });

  it("null 显示「（无）」；对象 pretty-print", () => {
    expect(stringifyForDisplay(null)).toBe("（无）");
    expect(stringifyForDisplay({ collected: 12 })).toBe('{\n  "collected": 12\n}');
  });

  it(`超过 ${DETAIL_TEXT_LIMIT} 字符时截断（SSE 帧的 result 未截，这里兜底）`, () => {
    const out = stringifyForDisplay({ text: "a".repeat(DETAIL_TEXT_LIMIT) });
    expect(out.endsWith("…（已省略）")).toBe(true);
  });
});

describe("resultTextForDisplay（服务端截断的结果）", () => {
  it("resultTruncated 时直接展示 truncated_text（不再二次转义、不暴露内部字段名）", () => {
    const tool = buildToolCard({
      resultTruncated: true,
      result: { truncated_text: '{"text":"AAAA' },
    });
    expect(resultTextForDisplay(tool)).toBe('{"text":"AAAA');
  });

  it("未截断时走 pretty-print；result 为 null 显示「（无）」", () => {
    expect(resultTextForDisplay(buildToolCard({ result: { collected: 12 } }))).toBe('{\n  "collected": 12\n}');
    expect(resultTextForDisplay(buildToolCard({ result: null }))).toBe("（无）");
  });
});
