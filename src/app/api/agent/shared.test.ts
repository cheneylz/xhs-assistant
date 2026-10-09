/**
 * Agent API 序列化单元测试
 *
 * shared.ts 只 import 纯模块（stream-events / time），因此可离线单测 ——
 * 截断分支与工件非法载荷这两条逻辑，端到端脚本覆盖不到（造不出 >4000 字符的真实产出）。
 */
import { describe, expect, it } from "vitest";
import { serializeArtifact, serializeEvent, serializeToolCall } from "./shared";

/** 一条工具调用行的公共字段（result / summary 由各用例覆盖） */
const BASE_TOOL_CALL = {
  id: 1,
  runId: 2,
  stepIndex: 0,
  toolName: "hot_refresh",
  toolCallId: "call-1",
  params: {},
  status: "succeeded",
  errorType: null,
  durationMs: 12,
  summary: null,
  createdAt: new Date("2026-10-09T10:00:00Z"),
};

describe("serializeToolCall（工具卡序列化）", () => {
  it("result 恰好 4000 字符时不截断", () => {
    // JSON.stringify({ text: "" }) 是 11 字符，补足到正好 4000
    const result = { text: "A".repeat(4000 - JSON.stringify({ text: "" }).length) };
    expect(JSON.stringify(result)).toHaveLength(4000);

    const serialized = serializeToolCall({ ...BASE_TOOL_CALL, result });
    expect(serialized.result_truncated).toBe(false);
    expect(serialized.result).toEqual(result);
  });

  it("result 超过 4000 字符时截断到 4000 并置标记", () => {
    const serialized = serializeToolCall({ ...BASE_TOOL_CALL, result: { text: "A".repeat(5000) } });
    expect(serialized.result_truncated).toBe(true);
    const truncated = serialized.result as { truncated_text: string };
    expect(truncated.truncated_text).toHaveLength(4000);
    expect(truncated.truncated_text.startsWith('{"text":"AAA')).toBe(true);
  });

  it("result 为 null 时原样返回 null 且不标记截断", () => {
    const serialized = serializeToolCall({ ...BASE_TOOL_CALL, result: null });
    expect(serialized.result).toBeNull();
    expect(serialized.result_truncated).toBe(false);
  });

  it("summary 为 null 时归一成空串（前端不必判空）", () => {
    expect(serializeToolCall({ ...BASE_TOOL_CALL, result: null }).summary).toBe("");
  });
});

describe("serializeEvent（事件载荷窄化）", () => {
  it("数组 / 标量 payload 归一成空对象", () => {
    const base = { id: 1, runId: 2, type: "status", createdAt: new Date("2026-10-09T10:00:00Z") };
    expect(serializeEvent({ ...base, payload: [1, 2] }).payload).toEqual({});
    expect(serializeEvent({ ...base, payload: "标量" }).payload).toEqual({});
    expect(serializeEvent({ ...base, payload: null }).payload).toEqual({});
  });
});

describe("serializeArtifact（工件序列化）", () => {
  it("载荷 id 非法时返回 null（路由据此过滤）", () => {
    const base = { id: 5, runId: 2, createdAt: new Date("2026-10-09T10:00:00Z") };
    expect(serializeArtifact({ ...base, payload: { kind: "draft", id: "abc" } })).toBeNull();
    expect(serializeArtifact({ ...base, payload: { kind: "draft", id: 0 } })).toBeNull();
    expect(serializeArtifact({ ...base, payload: { kind: "draft", id: -3 } })).toBeNull();
    expect(serializeArtifact({ ...base, payload: null })).toBeNull();
  });

  it("载荷合法时形状完整", () => {
    const serialized = serializeArtifact({
      id: 5,
      runId: 2,
      createdAt: new Date("2026-10-09T10:00:00Z"),
      payload: { kind: "draft", id: 7, title: "标题", href: "/x?id=7" },
    });
    expect(serialized).toMatchObject({
      event_id: 5,
      run_id: 2,
      kind: "draft",
      id: 7,
      title: "标题",
      href: "/x?id=7",
    });
  });
});
