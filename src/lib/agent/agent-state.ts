/**
 * Agent 工作台前端状态归并（纯函数，D25：不引前端测试栈，逻辑抽出来用现有 vitest 覆盖）
 *
 * 两个输入源严格分工（设计稿 §5.3），否则会重复渲染：
 *   applyFirstScreen —— 首屏 / 重同步：服务端快照是权威，整体替换状态
 *   applyEventFrame  —— SSE 增量：按身份幂等归并（不是按事件顺序追加）
 *
 * 【为什么不做「id ≤ latest_event_id 就丢弃」的水位门】
 * 快照与在途帧存在竞态：重同步的响应返回时，连接里可能还有 id 小于快照水位的帧在飞
 * （典型场景：用户恰在运行结束时刷新页面，agent_end 帧在途期间快照到达）。按水位丢弃
 * 会让 agent_end 永久丢失 —— 它是前端唯一可靠的结束信号，丢了 UI 就卡在「执行中」。
 * 改为身份幂等：时间线条目按事件 id 去重、工具卡按 runId:toolCallId 归并、工件按 event_id
 * 去重。「重复应用同一帧，状态不变」使水位门不再必要；lastEventId 只承担重连起点与
 * 单调推进（噪声帧也要推进，否则重连会把它们整批再拉一次）。
 *
 * 【快照替换后必须重连 SSE】applyFirstScreen 把水位回退到快照的 latest_event_id
 * （不是取 max —— 快照在途期间连接推的更新帧会被替换丢掉，只能靠「从快照水位重放」补）。
 * 所以调用方在应用快照后必须立刻重连（页面的 resync 会把 streamKey +1）。
 */
import type {
  AgentArtifactItem,
  AgentConversation,
  AgentConversationDetail,
  AgentEventItem,
  AgentMessageItem,
  AgentRunItem,
  AgentToolCallItem,
} from "@/types";

/** 工具卡归并键：`runId:toolCallId` 复合键。
 *  provider 常按 Run 重置工具调用计数（每个 Run 都有 call_1），只用 toolCallId 会让同会话
 *  两个 Run 的卡片互相覆盖 —— 与服务端 toolCallSummaryKey 同口径。 */
export function toolCardKey(runId: number, toolCallId: string): string {
  return `${runId}:${toolCallId}`;
}

/** Run 是否未结束（pending / running 都算执行中） */
export function isActiveRunStatus(status: string): boolean {
  return status === "pending" || status === "running";
}

/** 工具卡的展示数据（首屏 DTO 与 SSE 帧都会归并成它） */
export interface AgentToolCard {
  runId: number;
  toolCallId: string;
  toolName: string;
  /** 本次 Run 内的调用序号；SSE 起点新建的卡片拿不到（重同步后才有） */
  stepIndex: number | null;
  /** running | succeeded | failed | blocked */
  status: string;
  summary: string;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  resultTruncated: boolean;
  errorType: string | null;
  durationMs: number | null;
}

/** 中栏时间线的条目：用户消息 / 助手过程文本 / 提示行 / 工具卡 */
export type AgentTimelineItem =
  | { kind: "user"; key: string; created_at: string; content: string }
  | { kind: "assistant"; key: string; created_at: string; text: string }
  | { kind: "notice"; key: string; created_at: string; level: "info" | "warning" | "error"; message: string }
  | { kind: "tool"; key: string; created_at: string; tool: AgentToolCard };

export interface AgentRunStatusView {
  /** 是否有未结束的 Run（禁用输入框、显示执行指示器、决定重连降速） */
  executing: boolean;
  /** 可取消的 Run（仅 pending，D19 只允许取消 pending）—— 决定「取消任务」按钮显隐 */
  pendingRunIds: number[];
}

export interface AgentUiState {
  conversation: AgentConversation | null;
  timeline: AgentTimelineItem[];
  artifacts: AgentArtifactItem[];
  runStatus: AgentRunStatusView;
  /** SSE 续传起点：已处理的最大事件 id（单调不减） */
  lastEventId: number;
  eventsTruncated: boolean;
  toolCallsTruncated: boolean;
  artifactsTruncated: boolean;
}

export function createInitialState(): AgentUiState {
  return {
    conversation: null,
    timeline: [],
    artifacts: [],
    runStatus: { executing: false, pendingRunIds: [] },
    lastEventId: 0,
    eventsTruncated: false,
    toolCallsTruncated: false,
    artifactsTruncated: false,
  };
}

/** 收窄 unknown → 普通对象（帧载荷里的 args / result 都可能缺失或非对象） */
function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function messageKey(id: number): string {
  return `m:${id}`;
}

/** 事件 id → 时间线条目键（幂等去重靠它） */
function eventKey(id: number): string {
  return `e:${id}`;
}

function normalizeLevel(value: unknown): "info" | "warning" | "error" {
  return value === "warning" || value === "error" ? value : "info";
}

/**
 * 事件行 → 时间线条目（助手文本 / 提示行）；不可渲染的返回 null。
 *
 * message_end 的 text 是**可选**的（渲染规则 3）：Pi 对 user / toolResult / system 也发
 * message_end，且升级前落库的旧行只有 { role, trimmed } —— 必须同时判 role 与 text，
 * 否则会出空白气泡。
 */
function timelineItemFromEvent(event: AgentEventItem): AgentTimelineItem | null {
  if (event.type === "message_end") {
    if (event.payload.role !== "assistant") return null;
    const text = event.payload.text;
    if (typeof text !== "string" || text.length === 0) return null;
    return { kind: "assistant", key: eventKey(event.id), created_at: event.created_at, text };
  }
  if (event.type === "status") {
    const message = typeof event.payload.message === "string" ? event.payload.message : "";
    if (!message) return null;
    return {
      kind: "notice",
      key: eventKey(event.id),
      created_at: event.created_at,
      level: normalizeLevel(event.payload.level),
      message,
    };
  }
  if (event.type === "error") {
    const message = typeof event.payload.message === "string" ? event.payload.message : "";
    if (!message) return null;
    return { kind: "notice", key: eventKey(event.id), created_at: event.created_at, level: "error", message };
  }
  return null;
}

function toolCardFromDto(row: AgentToolCallItem): AgentToolCard {
  return {
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    stepIndex: row.step_index,
    status: row.status,
    summary: row.summary,
    params: row.params,
    result: row.result,
    resultTruncated: row.result_truncated,
    errorType: row.error_type,
    durationMs: row.duration_ms,
  };
}

/**
 * 同秒内的展示次序：用户消息 → 事件（助手文本 / 提示）→ 工具卡。
 * created_at 只到秒（YYYY-MM-DDTHH:mm:ss），同秒碰撞时靠 rank + 各自表内的自增 id
 * 排出确定性顺序。
 * 已知局限：同秒内「工具执行完 → 下一条助手文本」仍会把文本排在卡片前
 * （只影响首屏 / 重同步回放的观感；直播流按到达顺序追加，不受影响）。
 */
const SOURCE_RANK = { user: 0, event: 1, tool: 2 } as const;

function buildTimeline(detail: AgentConversationDetail): AgentTimelineItem[] {
  const sortables: Array<{
    created_at: string;
    rank: number;
    id: number;
    item: AgentTimelineItem | null;
  }> = [];

  for (const message of detail.messages) {
    sortables.push({
      created_at: message.created_at,
      rank: SOURCE_RANK.user,
      id: message.id,
      item: {
        kind: "user",
        key: messageKey(message.id),
        created_at: message.created_at,
        content: message.content,
      },
    });
  }
  for (const event of detail.events) {
    sortables.push({
      created_at: event.created_at,
      rank: SOURCE_RANK.event,
      id: event.id,
      item: timelineItemFromEvent(event),
    });
  }
  for (const toolCall of detail.tool_calls) {
    sortables.push({
      created_at: toolCall.created_at,
      rank: SOURCE_RANK.tool,
      id: toolCall.id,
      item: {
        kind: "tool",
        key: toolCardKey(toolCall.run_id, toolCall.tool_call_id),
        created_at: toolCall.created_at,
        tool: toolCardFromDto(toolCall),
      },
    });
  }

  sortables.sort((left, right) => {
    if (left.created_at !== right.created_at) return left.created_at < right.created_at ? -1 : 1;
    if (left.rank !== right.rank) return left.rank - right.rank;
    return left.id - right.id;
  });

  return sortables.filter((entry) => entry.item !== null).map((entry) => entry.item as AgentTimelineItem);
}

/** 首屏 / 重同步：服务端快照是权威，整体替换（含水位与截断标记） */
export function applyFirstScreen(state: AgentUiState, detail: AgentConversationDetail): AgentUiState {
  return {
    conversation: detail.conversation,
    timeline: buildTimeline(detail),
    artifacts: detail.artifacts,
    runStatus: {
      executing: detail.runs.some((run) => isActiveRunStatus(run.status)),
      pendingRunIds: detail.runs.filter((run) => run.status === "pending").map((run) => run.id),
    },
    // 有意回退（不是 Math.max）：见文件头「快照替换后必须重连 SSE」
    lastEventId: detail.latest_event_id,
    eventsTruncated: detail.events_truncated,
    toolCallsTruncated: detail.tool_calls_truncated,
    artifactsTruncated: detail.artifacts_truncated,
  };
}

/** 会话列表的局部更新（新建 / 发消息后标题派生 / 列表刷新）：更新的会话置顶（按 updated_at 倒序） */
export function upsertConversation(items: AgentConversation[], conversation: AgentConversation): AgentConversation[] {
  return [conversation, ...items.filter((item) => item.id !== conversation.id)];
}

/**
 * 时间线里按键查重（幂等插入的前提）。
 * 帧的量级：一轮约 1400 帧、时间线至多几百条 —— 线性扫描足够，不必建索引。
 */
function hasTimelineKey(state: AgentUiState, key: string): boolean {
  return state.timeline.some((item) => item.key === key);
}
