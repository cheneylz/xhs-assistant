import { describe, expect, it } from "vitest";
import type {
  SerializedAgentConversation,
  SerializedAgentEvent,
  SerializedAgentMessage,
  SerializedAgentRun,
  SerializedArtifact,
  SerializedToolCall,
} from "@/app/api/agent/shared";
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
  agentReducer,
  applyArtifacts,
  applyEventFrame,
  applyFirstScreen,
  createInitialState,
  isActiveRunStatus,
  parseSseBuffer,
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

describe("同秒同 rank 的兜底排序（id 升序）", () => {
  it("同秒内的多条消息/多条事件按各自自增 id 升序排，且键带各自的命名空间前缀", () => {
    const sameSecond = "2026-10-10T10:00:07";
    const state = applyFirstScreen(
      createInitialState(),
      buildDetail({
        // 传入顺序故意打乱：排序必须按 id，而不是依赖数组顺序
        events: [
          buildEvent({ id: 21, created_at: sameSecond, payload: { role: "assistant", text: "晚一点的事件" } }),
          buildEvent({ id: 20, created_at: sameSecond, payload: { role: "assistant", text: "早一点的事件" } }),
        ],
        messages: [
          buildUserMessage({ id: 1, created_at: sameSecond }),
          buildUserMessage({ id: 2, created_at: sameSecond, content: "第二条" }),
        ],
      }),
    );
    expect(state.timeline.map((item) => item.kind)).toEqual(["user", "user", "assistant", "assistant"]);
    expect(state.timeline.map((item) => item.key)).toEqual(["m:1", "m:2", "e:20", "e:21"]);
    const assistantTexts = state.timeline.flatMap((item) => (item.kind === "assistant" ? [item.text] : []));
    expect(assistantTexts).toEqual(["早一点的事件", "晚一点的事件"]);
  });
});

/**
 * 契约镜像（类型级断言：本文件能编译通过即为通过）
 *
 * `import type` 在编译期完全擦除、不产生运行时依赖（shared.ts 本身也不含 prisma），
 * 所以这里只借用服务端的类型做结构比对，不会把服务端代码带进客户端包。
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type SameKeys<A, B> = keyof A extends keyof B ? (keyof B extends keyof A ? true : false) : false;
/** 互为可赋值 + 键集合一致 = 结构同构（服务端新增可选字段也会被 keyof 比对拦下） */
type Mirror<A, B> = MutuallyAssignable<A, B> extends true ? SameKeys<A, B> : false;

describe("契约镜像（编译期断言）", () => {
  it("前端契约类型与服务端 shared.ts 的 Serialized* 同构（漂移 → tsc 失败）", () => {
    const mirrors: [
      Mirror<AgentConversation, SerializedAgentConversation>,
      Mirror<AgentMessageItem, SerializedAgentMessage>,
      Mirror<AgentEventItem, SerializedAgentEvent>,
      Mirror<AgentToolCallItem, SerializedToolCall>,
      Mirror<AgentArtifactItem, SerializedArtifact>,
      Mirror<AgentRunItem, SerializedAgentRun>,
    ] = [true, true, true, true, true, true];
    expect(mirrors.every(Boolean)).toBe(true);
  });
});

function buildFrame(overrides: Partial<AgentEventItem> = {}): AgentEventItem {
  return {
    id: 50,
    run_id: 1,
    type: "message_end",
    payload: { role: "assistant", text: "我先查一下热点" },
    created_at: "2026-10-10T10:01:00",
    ...overrides,
  };
}

function buildToolCardState() {
  return applyFirstScreen(createInitialState(), buildDetail({ latest_event_id: 40 }));
}

describe("applyEventFrame（SSE 增量归并）", () => {
  it("助手文本帧追加条目并推进水位", () => {
    const state = applyEventFrame(buildToolCardState(), buildFrame());
    expect(state.timeline).toHaveLength(1);
    expect(state.timeline[0]).toMatchObject({ kind: "assistant", text: "我先查一下热点" });
    expect(state.lastEventId).toBe(50);
  });

  it("噪声帧（message_start / message_update）不改状态但推进水位", () => {
    const before = buildToolCardState();
    const after = applyEventFrame(
      applyEventFrame(before, buildFrame({ id: 51, type: "message_start", payload: { role: "assistant" } })),
      buildFrame({ id: 52, type: "message_update", payload: { role: "assistant", trimmed: true } }),
    );
    expect(after.timeline).toEqual(before.timeline);
    expect(after.lastEventId).toBe(52);
  });

  it("水位单调：更旧的帧不回退水位", () => {
    const state = applyEventFrame(buildToolCardState(), buildFrame({ id: 10 }));
    expect(state.lastEventId).toBe(40);
  });

  it("重复应用同一帧状态不变（快照与在途帧重叠时的幂等）", () => {
    const withSnapshotEvent = applyFirstScreen(
      createInitialState(),
      buildDetail({ events: [buildEvent({ id: 50 })], latest_event_id: 50 }),
    );
    const again = applyEventFrame(withSnapshotEvent, buildFrame({ id: 50 }));
    expect(again.timeline).toEqual(withSnapshotEvent.timeline);
    expect(again).toEqual(withSnapshotEvent);
  });

  it("user / toolResult 的 message_end 不产生条目（渲染规则 3）", () => {
    const state = applyEventFrame(
      buildToolCardState(),
      buildFrame({ payload: { role: "user", trimmed: true } }),
    );
    expect(state.timeline).toEqual([]);
  });

  it("status / error 帧变提示行", () => {
    const state = applyEventFrame(
      applyEventFrame(buildToolCardState(), buildFrame({ id: 51, type: "status", payload: { level: "error", message: "运行超过墙钟上限被中止" } })),
      buildFrame({ id: 52, type: "error", payload: { message: "未配置默认文本模型，无法执行" } }),
    );
    expect(state.timeline.map((item) => (item.kind === "notice" ? item.level : "?"))).toEqual(["error", "error"]);
  });

  it("tool_execution_start 建一张运行中的卡（工具名取帧载荷）", () => {
    const state = applyEventFrame(
      buildToolCardState(),
      buildFrame({
        id: 60,
        type: "tool_execution_start",
        payload: { toolCallId: "call_1", toolName: "hot_refresh", args: { limit: 50 } },
        created_at: "2026-10-10T10:01:02",
      }),
    );
    expect(state.timeline).toHaveLength(1);
    expect(state.timeline[0]).toMatchObject({
      kind: "tool",
      key: "1:call_1",
      tool: { status: "running", toolName: "hot_refresh", params: { limit: 50 }, stepIndex: null },
    });
  });

  it("tool_execution_end 更新既有卡：状态、摘要、耗时；不吞掉 start 的数据，也不改旧状态", () => {
    const started = applyEventFrame(
      buildToolCardState(),
      buildFrame({
        id: 60,
        type: "tool_execution_start",
        payload: { toolCallId: "call_1", toolName: "hot_refresh", args: { limit: 50 } },
      }),
    );
    const ended = applyEventFrame(
      started,
      buildFrame({
        id: 61,
        type: "tool_execution_end",
        payload: {
          toolCallId: "call_1",
          toolName: "hot_refresh",
          result: { details: { collected: 12 }, content: [] },
          isError: false,
          durationMs: 2100,
          summary: "收录 12 条热点",
        },
      }),
    );
    expect(ended.timeline).toHaveLength(1);
    expect(ended.timeline[0]).toMatchObject({
      tool: {
        status: "succeeded",
        summary: "收录 12 条热点",
        durationMs: 2100,
        result: { collected: 12 },
        // 补丁里没带的字段必须原样保留（「缺省=不动」）：
        params: { limit: 50 },
        stepIndex: null,
      },
    });
    // 不可变性：上一版状态的卡片原封不动（copy-on-write 是身份归并的前提）
    expect(started.timeline[0]).toMatchObject({ tool: { status: "running", summary: "" } });
    expect(ended.timeline[0]).not.toBe(started.timeline[0]);
  });

  it("end 帧的摘要/耗时/结果是必写字段：非法摘要归一成空串、缺失耗时归一成 null", () => {
    const started = applyEventFrame(
      buildToolCardState(),
      buildFrame({
        id: 60,
        type: "tool_execution_start",
        payload: { toolCallId: "call_1", toolName: "hot_refresh", args: {} },
      }),
    );
    const ended = applyEventFrame(
      started,
      buildFrame({
        id: 61,
        type: "tool_execution_end",
        payload: { toolCallId: "call_1", toolName: "hot_refresh", result: {}, isError: false, summary: 123 },
      }),
    );
    expect(ended.timeline[0]).toMatchObject({
      tool: { status: "succeeded", summary: "", durationMs: null, result: null },
    });
  });

  it("tool_execution_end 没有既有卡时新建（跨边界 / 有帧无卡的容忍）", () => {
    const state = applyEventFrame(
      buildToolCardState(),
      buildFrame({
        id: 62,
        type: "tool_execution_end",
        payload: { toolCallId: "call_9", toolName: "topic_generate", result: {}, isError: true, durationMs: 300, summary: "未执行：Tool xxx not found" },
      }),
    );
    expect(state.timeline).toHaveLength(1);
    expect(state.timeline[0]).toMatchObject({
      kind: "tool",
      key: "1:call_9",
      tool: { status: "failed", summary: "未执行：Tool xxx not found", result: null },
    });
  });

  it("旧 start 帧不会把终态卡降级回运行中", () => {
    const succeeded = applyFirstScreen(
      createInitialState(),
      buildDetail({ tool_calls: [buildToolCall({ status: "succeeded", summary: "收录 12 条热点" })] }),
    );
    const state = applyEventFrame(
      succeeded,
      buildFrame({ id: 63, type: "tool_execution_start", payload: { toolCallId: "call_1", toolName: "hot_refresh", args: {} } }),
    );
    expect(state.timeline[0]).toMatchObject({ tool: { status: "succeeded", summary: "收录 12 条热点" } });
  });

  it("artifact 帧追加工件，按 event_id 幂等", () => {
    const frame = buildFrame({
      id: 70,
      type: "artifact",
      payload: { kind: "draft", id: 7, title: "《露营装备清单》", href: "/platforms/xhs/drafts?id=7" },
    });
    const once = applyEventFrame(buildToolCardState(), frame);
    const twice = applyEventFrame(once, frame);
    expect(once.artifacts).toEqual([
      {
        event_id: 70,
        run_id: 1,
        kind: "draft",
        id: 7,
        title: "《露营装备清单》",
        href: "/platforms/xhs/drafts?id=7",
        created_at: "2026-10-10T10:01:00",
      },
    ]);
    expect(twice.artifacts).toHaveLength(1);
  });

  it("agent_end 解除执行中并清空可取消列表", () => {
    const executing = applyFirstScreen(
      createInitialState(),
      buildDetail({ runs: [buildRun({ id: 9, status: "running" })] }),
    );
    expect(executing.runStatus.executing).toBe(true);
    const ended = applyEventFrame(executing, buildFrame({ id: 80, type: "agent_end", payload: {} }));
    expect(ended.runStatus).toEqual({ executing: false, pendingRunIds: [] });
  });

  it("跨 Run 的同名 tool_call_id 归到不同卡片（不做覆盖）", () => {
    const state = applyEventFrame(
      applyFirstScreen(
        createInitialState(),
        buildDetail({ tool_calls: [buildToolCall({ run_id: 1, status: "succeeded" })] }),
      ),
      buildFrame({
        id: 90,
        run_id: 2,
        type: "tool_execution_start",
        payload: { toolCallId: "call_1", toolName: "hot_refresh", args: {} },
      }),
    );
    const tools = state.timeline.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools.map((item) => item.key)).toEqual(["1:call_1", "2:call_1"]);
  });
});

describe("parseSseBuffer（SSE 缓冲解析，与 crawlXhsDataStream 同范式）", () => {
  it("拆出完整帧，半帧留在 rest", () => {
    const buffer = 'data: {"id":1,"run_id":1,"type":"status","payload":{"message":"a"},"created_at":"t"}\n\ndata: {"id":2,';
    const { frames, rest } = parseSseBuffer(buffer);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ id: 1, type: "status" });
    expect(rest).toBe('data: {"id":2,');
  });

  it("心跳与坏帧被跳过，不影响后续帧", () => {
    const buffer =
      ': ping\n\ndata: {bad json}\n\ndata: {"id":3,"run_id":1,"type":"agent_end","payload":{},"created_at":"t"}\n\n';
    const { frames, rest } = parseSseBuffer(buffer);
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe(3);
    expect(rest).toBe("");
  });

  it("缺少 id / type 的对象不算帧", () => {
    const buffer = 'data: {"type":"status"}\n\ndata: null\n\n';
    expect(parseSseBuffer(buffer).frames).toEqual([]);
  });

  it("缺 payload / payload 为 null 的帧被跳过（不会在 reducer 里解引用崩掉整页）", () => {
    const buffer =
      'data: {"id":1,"run_id":1,"type":"status","created_at":"t"}\n\ndata: {"id":2,"run_id":1,"type":"status","payload":null,"created_at":"t"}\n\n';
    expect(parseSseBuffer(buffer).frames).toEqual([]);
  });

  it("一次读入多帧：全部按序返回且 rest 为空（重连后单块最多 200 帧，这是常态路径）", () => {
    const frame = (id: number) =>
      `data: {"id":${id},"run_id":1,"type":"status","payload":{},"created_at":"t"}\n\n`;
    const { frames, rest } = parseSseBuffer(`${frame(1)}${frame(2)}${frame(3)}`);
    expect(frames.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(rest).toBe("");
  });
});

describe("applyArtifacts / agentReducer（右栏刷新与 action 包装）", () => {
  it("右栏单独刷新：整体替换工件列表", () => {
    const state = applyArtifacts(applyFirstScreen(createInitialState(), buildDetail({ artifacts: [buildArtifact()] })), [
      buildArtifact({ event_id: 99, id: 8, title: "《新草稿》" }),
    ]);
    expect(state.artifacts).toEqual([buildArtifact({ event_id: 99, id: 8, title: "《新草稿》" })]);
  });

  it("runCreated：用户消息上屏、会话更新、进入执行中（可取消的是新 Run）", () => {
    const state = agentReducer(createInitialState(), {
      type: "runCreated",
      conversation: buildDetail().conversation,
      message: buildUserMessage(),
      run: buildRun({ id: 9, status: "pending" }),
    });
    expect(state.timeline).toEqual([
      { kind: "user", key: "m:1", created_at: "2026-10-10T10:00:01", content: "帮我出选题" },
    ]);
    expect(state.runStatus).toEqual({ executing: true, pendingRunIds: [9] });
  });

  it("runCreated 重复应用不会插入两条相同的用户消息（按 message id 幂等）", () => {
    const action = {
      type: "runCreated" as const,
      conversation: buildDetail().conversation,
      message: buildUserMessage(),
      run: buildRun({ id: 9, status: "pending" }),
    };
    const state = agentReducer(agentReducer(createInitialState(), action), action);
    expect(state.timeline).toHaveLength(1);
  });

  it("runCancelled：回到空闲", () => {
    const executing = agentReducer(createInitialState(), {
      type: "runCreated",
      conversation: buildDetail().conversation,
      message: buildUserMessage(),
      run: buildRun({ id: 9, status: "pending" }),
    });
    expect(agentReducer(executing, { type: "runCancelled" }).runStatus).toEqual({
      executing: false,
      pendingRunIds: [],
    });
  });

  it("clear：切会话时回到初始态（不残留上一个会话的工件与时间线）", () => {
    const dirty = applyFirstScreen(
      createInitialState(),
      buildDetail({ events: [buildEvent()], artifacts: [buildArtifact()], latest_event_id: 9 }),
    );
    expect(agentReducer(dirty, { type: "clear" })).toEqual(createInitialState());
  });

  it("runStatus 动作：只按 runs 校正执行状态，不动时间线 / 水位 / 工件（页面兜底重同步用）", () => {
    const state = applyFirstScreen(
      createInitialState(),
      buildDetail({
        events: [buildEvent({ id: 30 })],
        latest_event_id: 50,
        runs: [buildRun({ id: 1, status: "running" })],
      }),
    );
    expect(state.runStatus.executing).toBe(true);
    // 服务端说这个 Run 已经结束了（worker 补写完终态）——只校正执行状态
    const settled = agentReducer(state, { type: "runStatus", runs: [buildRun({ id: 1, status: "succeeded" })] });
    expect(settled.runStatus).toEqual({ executing: false, pendingRunIds: [] });
    expect(settled.timeline).toEqual(state.timeline);
    expect(settled.lastEventId).toBe(50);
    expect(settled.artifacts).toEqual(state.artifacts);
  });

  it("snapshot / frame 走对应的纯函数", () => {
    const withSnapshot = agentReducer(createInitialState(), {
      type: "snapshot",
      detail: buildDetail({ events: [buildEvent()], latest_event_id: 50 }),
    });
    expect(withSnapshot.timeline).toHaveLength(1);
    const withFrame = agentReducer(withSnapshot, { type: "frame", frame: buildFrame({ id: 51 }) });
    expect(withFrame.timeline).toHaveLength(2);
    expect(withFrame.lastEventId).toBe(51);
  });

  it("runStatus 传空 runs：回到空闲（服务端一条 Run 都没有的边界）", () => {
    const executing = agentReducer(createInitialState(), {
      type: "runCreated",
      conversation: buildDetail().conversation,
      message: buildUserMessage(),
      run: buildRun({ id: 9, status: "pending" }),
    });
    expect(agentReducer(executing, { type: "runStatus", runs: [] }).runStatus).toEqual({
      executing: false,
      pendingRunIds: [],
    });
  });
});
