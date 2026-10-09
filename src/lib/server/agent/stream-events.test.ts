/**
 * SSE 事件工具单元测试
 * 覆盖：帧编码、可渲染事件判定、tool_execution_end 摘要补齐、toolCallId 收集
 */
import { describe, expect, it } from "vitest";
import {
  RENDERABLE_EVENT_TYPES,
  SSE_HEARTBEAT_FRAME,
  attachToolCallSummaries,
  collectToolCallIds,
  encodeSseFrame,
  isRenderableEvent,
} from "./stream-events";

/** 造一条事件行（结构对齐 Prisma 的 agentEvent.findMany 返回值） */
function row(type: string, payload: Record<string, unknown>, id = 1) {
  return { id, runId: 10, type, payload, createdAt: new Date("2026-10-09T10:00:00Z") };
}

describe("encodeSseFrame（帧编码）", () => {
  it("编码为 data: <json>\\n\\n，且 JSON 内不含裸换行", () => {
    const frame = encodeSseFrame({ id: 1, type: "status", payload: { message: "第一行\n第二行" } });
    expect(frame.startsWith("data: ")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    // 正文里的换行必须被 JSON 转义，否则会被客户端按帧边界切开
    expect(frame.split("\n\n")).toHaveLength(2);
    expect(JSON.parse(frame.slice(6, -2))).toMatchObject({ id: 1 });
  });

  it("心跳帧是注释行（不含 data: 前缀，客户端会跳过）", () => {
    expect(SSE_HEARTBEAT_FRAME.startsWith(":")).toBe(true);
    expect(SSE_HEARTBEAT_FRAME.endsWith("\n\n")).toBe(true);
  });
});

describe("isRenderableEvent（首屏回放判定）", () => {
  it("过程文本 / 工件 / 状态 / 错误四类要回放", () => {
    expect(RENDERABLE_EVENT_TYPES).toEqual(["message_end", "artifact", "status", "error"]);
    for (const type of RENDERABLE_EVENT_TYPES) expect(isRenderableEvent(type)).toBe(true);
  });

  it("增量与工具执行事件不回放（工具卡由 agent_tool_calls 承担，回放会渲染两遍）", () => {
    expect(isRenderableEvent("message_update")).toBe(false);
    expect(isRenderableEvent("message_start")).toBe(false);
    expect(isRenderableEvent("tool_execution_start")).toBe(false);
    expect(isRenderableEvent("tool_execution_end")).toBe(false);
    expect(isRenderableEvent("agent_end")).toBe(false);
  });
});

describe("collectToolCallIds / attachToolCallSummaries（摘要补齐）", () => {
  it("只从 tool_execution_end 收集，且去重", () => {
    const ids = collectToolCallIds([
      row("tool_execution_start", { toolCallId: "call-1" }),
      row("tool_execution_end", { toolCallId: "call-1" }),
      row("tool_execution_end", { toolCallId: "call-2" }),
      row("message_end", { text: "没有 toolCallId" }),
    ]);
    expect(ids.sort()).toEqual(["call-1", "call-2"]);
  });

  it("给 tool_execution_end 补上 summary，其余事件原样返回", () => {
    const event = row("tool_execution_end", { toolCallId: "call-1", isError: false });
    const other = row("message_end", { toolCallId: "call-1" }, 2);
    const [patched, untouched] = attachToolCallSummaries([event, other], new Map([["call-1", "收录 87 条热点"]]));

    expect((patched.payload as Record<string, unknown>).summary).toBe("收录 87 条热点");
    expect((patched.payload as Record<string, unknown>).isError).toBe(false);
    expect(untouched).toBe(other);
  });

  it("不改写入参行（Pull 事件是 Prisma 返回对象，就地改会污染后续使用者）", () => {
    const event = row("tool_execution_end", { toolCallId: "call-1" });
    attachToolCallSummaries([event], new Map([["call-1", "摘要"]]));
    expect((event.payload as Record<string, unknown>).summary).toBeUndefined();
  });

  it("缺摘要、载荷为 null、toolCallId 非字符串时都不抛错", () => {
    const rows = [
      row("tool_execution_end", { toolCallId: "call-9" }, 1),
      row("tool_execution_end", {}, 2),
      row("tool_execution_end", { toolCallId: 123 }, 3),
    ];
    const patched = attachToolCallSummaries(rows, new Map([["call-1", "摘要"]]));
    expect(patched).toHaveLength(3);
    expect(patched.every((item) => item.payload !== null)).toBe(true);
  });

  it("摘要表为空时直接返回原数组（不产生无谓拷贝）", () => {
    const rows = [row("tool_execution_end", { toolCallId: "call-1" })];
    expect(attachToolCallSummaries(rows, new Map())).toBe(rows);
  });
});
