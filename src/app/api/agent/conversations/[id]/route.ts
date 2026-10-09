import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError, badRequest, notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { RENDERABLE_EVENT_TYPES } from "@/lib/server/agent/stream-events";
import {
  deleteConversationDeep,
  findConversationForUser,
  hasActiveRun,
  latestEventIdForRuns,
  listArtifactEvents,
  listConversationUserMessages,
  listRenderableEvents,
  listRuns,
  listToolCallsForRuns,
} from "@/lib/server/services/agent-service";
import { NextResponse } from "next/server";
import { serializeArtifact, serializeConversation, serializeEvent, serializeMessage, serializeToolCall } from "../../shared";

/** 首屏回放事件的条数上限（一次运行的可渲染事件通常个位数，长会话才可能触顶） */
const EVENT_REPLAY_LIMIT = 1000;
/** 首屏工具卡与工件的条数上限（与服务层默认值一致；每行 result 可达 4000 字符，不设上限会撑爆响应） */
const TOOL_CALL_LIMIT = 200;
const ARTIFACT_LIMIT = 200;

/** 解析并校验路径参数 id */
function parseId(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw badRequest("会话 id 非法");
  return value;
}

/**
 * GET /api/agent/conversations/[id] 首屏契约（P1 设计稿 §4.4）
 *
 * 一次请求拿到整屏数据 + SSE 续传起点：
 *   messages        中栏 user 消息（助手文本一律来自下面的 events，避免两处渲染）
 *   events          id ≤ latest_event_id 的可渲染历史事件（D23 的过程文本靠它才能刷新后仍在）
 *   tool_calls      中栏已完成的工具卡（含 summary）
 *   artifacts       右栏工件
 *   latest_event_id 前端订阅 SSE 的起点：只渲染 id 大于它的事件
 *   *_truncated     该列表是否因超过上限而被截断（丢了更早的条目）
 *
 * 注意 events 里**不含** artifact 事件（工件的唯一历史来源是 artifacts 字段），
 * 工具卡也**不由 events 承担**（唯一来源是 tool_calls，按 tool_call_id 归并）——
 * 两处都返回会让同一张卡片渲染两遍。
 */
export const GET = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const conversationId = parseId(params.id);
  // 服务层返回 null 表示「不存在或不属于你」，路由层统一转 404
  const conversation = await findConversationForUser(conversationId, user.id);
  if (!conversation) throw notFound("会话不存在");

  const runs = await listRuns(conversationId);
  const runIds = runs.map((run) => run.id);
  const latestEventId = await latestEventIdForRuns(runIds);

  const [messages, toolCalls, artifactEvents, replayEvents] = await Promise.all([
    listConversationUserMessages(conversationId),
    listToolCallsForRuns(runIds, TOOL_CALL_LIMIT),
    listArtifactEvents(runIds, ARTIFACT_LIMIT),
    listRenderableEvents(runIds, latestEventId, RENDERABLE_EVENT_TYPES, EVENT_REPLAY_LIMIT),
  ]);

  return NextResponse.json({
    conversation: serializeConversation(conversation),
    messages: messages.map(serializeMessage),
    events: replayEvents.map(serializeEvent),
    tool_calls: toolCalls.map(serializeToolCall),
    artifacts: artifactEvents.map(serializeArtifact).filter((item) => item !== null),
    latest_event_id: latestEventId,
    // 截断标记：更早的内容被丢掉了，前端据此提示「更早的记录已折叠」
    events_truncated: replayEvents.length >= EVENT_REPLAY_LIMIT,
    tool_calls_truncated: toolCalls.length >= TOOL_CALL_LIMIT,
    artifacts_truncated: artifactEvents.length >= ARTIFACT_LIMIT,
  });
});

/**
 * DELETE /api/agent/conversations/[id] 删除会话（接口 8）
 *
 * 级联范围见 deleteConversationDeep：Prisma 的 onDelete 只覆盖
 * agent_messages / agent_runs，事件、工具调用与 Task 必须显式清。
 *
 * **执行中的会话拒绝删除（409）**：agent_events / agent_tool_calls 与 Run 之间没有外键，
 * worker 在删完后仍会继续写库 —— 那些行会成为永远查不回来的孤儿，
 * 且 worker 的 finishRun 会因 Run 行不存在而抛错（只留下一条日志）。
 */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const conversationId = parseId(params.id);
  if (await hasActiveRun(conversationId)) {
    throw new ApiError(409, "会话正在执行中，请先取消或等待任务结束再删除");
  }
  const deleted = await deleteConversationDeep(conversationId, user.id);
  if (!deleted) throw notFound("会话不存在");
  return NextResponse.json({ deleted: true, id: conversationId });
});
