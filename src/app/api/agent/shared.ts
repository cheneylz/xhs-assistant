/**
 * Agent API 的序列化（REST 契约统一 snake_case，P0 设计稿 D13）
 *
 * 首屏（接口 3）与工件刷新（接口 6）返回**同一形状**的工件数组 ——
 * 序列化只写这一份，避免两处漂移（P1 设计稿 §4.4）。
 */
import { toPayloadRecord, type AgentEventRowLike } from "@/lib/server/agent/stream-events";
import { formatDateTime } from "@/lib/server/core/time";

/** 工具产出原文的序列化上限：超出则截断并置 result_truncated */
const RESULT_TEXT_LIMIT = 4000;

export interface SerializedAgentConversation {
  id: number;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export function serializeConversation(row: {
  id: number;
  title: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): SerializedAgentConversation {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    created_at: formatDateTime(row.createdAt),
    updated_at: formatDateTime(row.updatedAt),
  };
}

export interface SerializedAgentRun {
  id: number;
  conversation_id: number;
  status: string;
  step_count: number;
  tokens_used: number;
  error_type: string | null;
  created_at: string;
  finished_at: string | null;
}

/** 只暴露前端需要的字段：taskId / maxSteps / tokenBudget 是内部护栏参数，不外泄 */
export function serializeRun(row: {
  id: number;
  conversationId: number;
  status: string;
  stepCount: number;
  tokensUsed: number;
  errorType: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}): SerializedAgentRun {
  return {
    id: row.id,
    conversation_id: row.conversationId,
    status: row.status,
    step_count: row.stepCount,
    tokens_used: row.tokensUsed,
    error_type: row.errorType,
    created_at: formatDateTime(row.createdAt),
    finished_at: row.finishedAt ? formatDateTime(row.finishedAt) : null,
  };
}

export interface SerializedAgentMessage {
  id: number;
  role: string;
  content: string;
  run_id: number | null;
  tool_call_id: string | null;
  created_at: string;
}

export function serializeMessage(row: {
  id: number;
  role: string;
  content: string;
  runId: number | null;
  toolCallId: string | null;
  createdAt: Date;
}): SerializedAgentMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    run_id: row.runId,
    tool_call_id: row.toolCallId,
    created_at: formatDateTime(row.createdAt),
  };
}

export interface SerializedAgentEvent {
  id: number;
  run_id: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

/**
 * 事件的 payload 归一成对象：Prisma 的 Json 列可能是 null / 数组 / 标量。
 * 参数用 AgentEventRowLike（事件行的最小契约），与 SSE 层共用同一定义。
 */
export function serializeEvent(row: AgentEventRowLike): SerializedAgentEvent {
  return {
    id: row.id,
    run_id: row.runId,
    type: row.type,
    payload: toPayloadRecord(row.payload),
    created_at: formatDateTime(row.createdAt),
  };
}

export interface SerializedToolCall {
  id: number;
  run_id: number;
  step_index: number;
  tool_name: string;
  tool_call_id: string;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  result_truncated: boolean;
  status: string;
  error_type: string | null;
  duration_ms: number | null;
  summary: string;
  created_at: string;
}

/**
 * `result` 是工具产出原文（最大可到 20k 字符），首屏整体返回会撑大响应，
 * 因此超过 RESULT_TEXT_LIMIT 就截成字符串并标记 result_truncated —— 前端据此显示「已截断」。
 */
export function serializeToolCall(row: {
  id: number;
  runId: number;
  stepIndex: number;
  toolName: string;
  toolCallId: string;
  params: unknown;
  result: unknown;
  status: string;
  errorType: string | null;
  durationMs: number | null;
  summary: string | null;
  createdAt: Date;
}): SerializedToolCall {
  const params = toPayloadRecord(row.params);
  const rawResult = row.result === null || row.result === undefined ? null : toPayloadRecord(row.result);
  const resultText = rawResult === null ? "" : JSON.stringify(rawResult);
  const truncated = resultText.length > RESULT_TEXT_LIMIT;
  return {
    id: row.id,
    run_id: row.runId,
    step_index: row.stepIndex,
    tool_name: row.toolName,
    tool_call_id: row.toolCallId,
    params,
    result: truncated ? { truncated_text: resultText.slice(0, RESULT_TEXT_LIMIT) } : rawResult,
    result_truncated: truncated,
    status: row.status,
    error_type: row.errorType,
    duration_ms: row.durationMs,
    summary: row.summary ?? "",
    created_at: formatDateTime(row.createdAt),
  };
}

export interface SerializedArtifact {
  event_id: number;
  run_id: number;
  kind: string;
  id: number;
  title: string;
  href: string;
  created_at: string;
}

/** 工件行来自 type="artifact" 的事件（载荷由 persist.extractArtifacts 产出） */
export function serializeArtifact(row: {
  id: number;
  runId: number;
  payload: unknown;
  createdAt: Date;
}): SerializedArtifact | null {
  const payload = toPayloadRecord(row.payload);
  const id = Number(payload.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return {
    event_id: row.id,
    run_id: row.runId,
    kind: String(payload.kind ?? ""),
    id,
    title: String(payload.title ?? ""),
    href: String(payload.href ?? ""),
    created_at: formatDateTime(row.createdAt),
  };
}
