import { describe, expect, it } from "vitest";
import type {
  AgentArtifactItem,
  AgentConversation,
  AgentConversationDetail,
  AgentEventItem,
  AgentMessageItem,
  AgentRunItem,
  AgentToolCallItem,
} from "@/types";
import {
  applyFirstScreen,
  createInitialState,
  isActiveRunStatus,
  toolCardKey,
  upsertConversation,
} from "./agent-state";

/** 首屏快照的测试夹具：只写用例关心的字段，其余给默认值 */
function buildDetail(overrides: Partial<AgentConversationDetail> = {}): AgentConversationDetail {
  return {
    conversation: {
      id: 1,
      title: "新任务",
      status: "idle",
      created_at: "2026-10-10T10:00:00",
      updated_at: "2026-10-10T10:00:00",
    },
    messages: [],
    events: [],
    tool_calls: [],
    artifacts: [],
    latest_event_id: 0,
    runs: [],
    events_truncated: false,
    tool_calls_truncated: false,
    artifacts_truncated: false,
    ...overrides,
  };
}

function buildUserMessage(overrides: Partial<AgentMessageItem> = {}): AgentMessageItem {
  return {
    id: 1,
    role: "user",
    content: "帮我出选题",
    run_id: 1,
    tool_call_id: null,
    created_at: "2026-10-10T10:00:01",
    ...overrides,
  };
}

function buildEvent(overrides: Partial<AgentEventItem> = {}): AgentEventItem {
  return {
    id: 10,
    run_id: 1,
    type: "message_end",
    payload: { role: "assistant", text: "我先查一下热点" },
    created_at: "2026-10-10T10:00:02",
    ...overrides,
  };
}

function buildToolCall(overrides: Partial<AgentToolCallItem> = {}): AgentToolCallItem {
  return {
    id: 100,
    run_id: 1,
    step_index: 0,
    tool_name: "hot_refresh",
    tool_call_id: "call_1",
    params: {},
    result: null,
    result_truncated: false,
    status: "succeeded",
    error_type: null,
    duration_ms: 1200,
    summary: "收录 12 条热点",
    created_at: "2026-10-10T10:00:03",
    ...overrides,
  };
}

function buildArtifact(overrides: Partial<AgentArtifactItem> = {}): AgentArtifactItem {
  return {
    event_id: 20,
    run_id: 1,
    kind: "draft",
    id: 7,
    title: "《露营装备清单》",
    href: "/platforms/xhs/drafts?id=7",
    created_at: "2026-10-10T10:00:04",
    ...overrides,
  };
}

function buildRun(overrides: Partial<AgentRunItem> = {}): AgentRunItem {
  return {
    id: 1,
    conversation_id: 1,
    task_id: 1,
    status: "succeeded",
    step_count: 0,
    max_steps: 20,
    tokens_used: 0,
    token_budget: 200000,
    error_type: null,
    created_at: "2026-10-10T10:00:00",
    finished_at: null,
    ...overrides,
  };
}

describe("applyFirstScreen（首屏快照归并）", () => {
  it("空会话：状态与截断标记都取自快照，水位取 latest_event_id", () => {
    const state = applyFirstScreen(createInitialState(), buildDetail({ latest_event_id: 42 }));
    expect(state.conversation?.id).toBe(1);
    expect(state.timeline).toEqual([]);
    expect(state.artifacts).toEqual([]);
    expect(state.lastEventId).toBe(42);
    expect(state.runStatus).toEqual({ executing: false, pendingRunIds: [] });
  });

  it("用户消息来自 messages，助手文本来自 message_end 事件（渲染规则 1）", () => {
    const state = applyFirstScreen(
      createInitialState(),
      buildDetail({ messages: [buildUserMessage()], events: [buildEvent()] }),
    );
    expect(state.timeline.map((item) => item.kind)).toEqual(["user", "assistant"]);
    expect(state.timeline[1]).toMatchObject({ kind: "assistant", text: "我先查一下热点" });
  });

  it("message_end 缺 role/text 时不产生条目（渲染规则 3：空白气泡防线）", () => {
    const state = applyFirstScreen(
      createInitialState(),
      buildDetail({
        events: [
          buildEvent({ id: 11, payload: { role: "user", trimmed: true } }),
          buildEvent({ id: 12, payload: { role: "toolResult" } }),
          buildEvent({ id: 13, payload: { role: "assistant" } }),
          buildEvent({ id: 14, payload: { role: "assistant", text: "" } }),
          buildEvent({ id: 15, payload: { role: "assistant", text: 123 } }),
        ],
      }),
    );
    expect(state.timeline).toEqual([]);
  });

  it("status / error 事件变成提示行，level 归一（未知 level → info）", () => {
    const state = applyFirstScreen(
      createInitialState(),
      buildDetail({
        events: [
          buildEvent({ id: 11, type: "status", payload: { level: "info", message: "运行完成" } }),
          buildEvent({ id: 12, type: "status", payload: { level: "warning", message: "执行超过 10 分钟，已中止" } }),
          buildEvent({ id: 13, type: "error", payload: { message: "未配置默认文本模型，无法执行" } }),
          buildEvent({ id: 14, type: "status", payload: { level: "unknown", message: "级别异常" } }),
        ],
      }),
    );
    expect(state.timeline.map((item) => (item.kind === "notice" ? item.level : "?"))).toEqual([
      "info",
      "warning",
      "error",
      "info",
    ]);
  });

  it("工具卡（含 running 行）与工件原样进状态（渲染规则 2：tool_calls 不过滤 status）", () => {
    const state = applyFirstScreen(
      createInitialState(),
      buildDetail({
        tool_calls: [
          buildToolCall({ status: "running", summary: "" }),
          buildToolCall({
            id: 101,
            tool_call_id: "call_2",
            status: "blocked",
            error_type: "guard_blocked",
            summary: "需要人工确认，已阻断",
          }),
        ],
        artifacts: [buildArtifact()],
      }),
    );
    const tools = state.timeline.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ tool: { status: "running", toolCallId: "call_1", summary: "" } });
    expect(tools[1]).toMatchObject({ tool: { status: "blocked", errorType: "guard_blocked" } });
    expect(state.artifacts).toEqual([buildArtifact()]);
  });

  it("同秒内的展示顺序：用户消息 → 事件 → 工具卡", () => {
    const sameSecond = "2026-10-10T10:00:05";
    const state = applyFirstScreen(
      createInitialState(),
      buildDetail({
        messages: [buildUserMessage({ created_at: sameSecond })],
        events: [buildEvent({ created_at: sameSecond })],
        tool_calls: [buildToolCall({ created_at: sameSecond })],
      }),
    );
    expect(state.timeline.map((item) => item.kind)).toEqual(["user", "assistant", "tool"]);
  });

  it("跨秒按 created_at 字典序排（时间序即字典序）", () => {
    const state = applyFirstScreen(
      createInitialState(),
      buildDetail({
        messages: [buildUserMessage({ created_at: "2026-10-10T10:00:09" })],
        events: [buildEvent({ created_at: "2026-10-10T10:00:10" })],
      }),
    );
    expect(state.timeline.map((item) => item.kind)).toEqual(["user", "assistant"]);
  });

  it("有未结束的 Run → executing；只有 pending 的 Run 可取消（D19）", () => {
    const state = applyFirstScreen(
      createInitialState(),
      buildDetail({
        runs: [
          buildRun({ id: 1, status: "succeeded" }),
          buildRun({ id: 2, status: "pending" }),
          buildRun({ id: 3, status: "running" }),
        ],
      }),
    );
    expect(state.runStatus.executing).toBe(true);
    expect(state.runStatus.pendingRunIds).toEqual([2]);
  });

  it("快照是整体替换：旧时间线/工件不残留，水位回退到快照值", () => {
    const first = applyFirstScreen(
      createInitialState(),
      buildDetail({ events: [buildEvent()], artifacts: [buildArtifact()], latest_event_id: 99 }),
    );
    const second = applyFirstScreen(first, buildDetail({ latest_event_id: 3 }));
    expect(second.timeline).toEqual([]);
    expect(second.artifacts).toEqual([]);
    // 有意回退（不是取 max）：快照在途期间连接可能已推了更新的帧，那些帧会被这次替换丢掉，
    // 必须靠调用方紧接着「从快照水位重连重放」补回来。见 agent-state.ts 文件头。
    expect(second.lastEventId).toBe(3);
  });

  it("截断标记进状态", () => {
    const state = applyFirstScreen(
      createInitialState(),
      buildDetail({ events_truncated: true, tool_calls_truncated: true, artifacts_truncated: true }),
    );
    expect(state.eventsTruncated).toBe(true);
    expect(state.toolCallsTruncated).toBe(true);
    expect(state.artifactsTruncated).toBe(true);
  });

  it("跨 Run 的同名 tool_call_id 用复合键区分", () => {
    const state = applyFirstScreen(
      createInitialState(),
      buildDetail({ tool_calls: [buildToolCall({ run_id: 1 }), buildToolCall({ id: 102, run_id: 2 })] }),
    );
    const keys = state.timeline.filter((item) => item.kind === "tool").map((item) => item.key);
    expect(keys).toEqual([toolCardKey(1, "call_1"), toolCardKey(2, "call_1")]);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("upsertConversation / isActiveRunStatus（小工具）", () => {
  const a: AgentConversation = {
    id: 1,
    title: "A",
    status: "idle",
    created_at: "2026-10-10T10:00:00",
    updated_at: "2026-10-10T10:00:00",
  };
  const b: AgentConversation = { ...a, id: 2, title: "B" };

  it("更新的会话置顶，且不产生重复项", () => {
    const updated = { ...a, title: "A2" };
    const result = upsertConversation([a, b], updated);
    expect(result.map((item) => item.title)).toEqual(["A2", "B"]);
    expect(result).toHaveLength(2);
  });

  it("pending / running 都算未结束", () => {
    expect(isActiveRunStatus("pending")).toBe(true);
    expect(isActiveRunStatus("running")).toBe(true);
    expect(isActiveRunStatus("succeeded")).toBe(false);
    expect(isActiveRunStatus("cancelled")).toBe(false);
  });
});
