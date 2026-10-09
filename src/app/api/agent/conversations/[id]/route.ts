import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { handle, parsePathId } from "@/lib/server/core/route";
import { RENDERABLE_EVENT_TYPES } from "@/lib/server/agent/stream-events";
import {
  deleteConversationDeep,
  findConversationForUser,
  latestEventIdForRuns,
  listArtifactEvents,
  listConversationUserMessages,
  listRenderableEvents,
  listRuns,
  listToolCallsForRuns,
} from "@/lib/server/services/agent-service";
import { NextResponse } from "next/server";
import {
  serializeArtifact,
  serializeConversation,
  serializeEvent,
  serializeMessage,
  serializeRun,
  serializeToolCall,
} from "../../shared";

/** 首屏回放事件的条数上限（可渲染事件随步数线性增长：每步一条 message_end + 若干 status/error，maxSteps 默认 20） */
const EVENT_REPLAY_LIMIT = 1000;
/** 首屏工具卡与工件的条数上限（与服务层默认值一致；每行 result 可达 4000 字符，不设上限会撑爆响应） */
const TOOL_CALL_LIMIT = 200;
const ARTIFACT_LIMIT = 200;

/**
 * GET /api/agent/conversations/[id] 首屏契约（P1 设计稿 §4.4）
 *
 * 一次请求拿到整屏数据 + SSE 续传起点：
 *   messages        中栏 user 消息（助手文本一律来自下面的 events，避免两处渲染）
 *   events          id ≤ latest_event_id 的可渲染历史事件（D23 的过程文本靠它才能刷新后仍在）
 *   tool_calls      中栏已完成的工具卡（含 summary）
 *   artifacts       右栏工件
 *   latest_event_id 前端订阅 SSE 的起点：只渲染 id 大于它的事件
 *   runs            会话的全部 Run（含 step_count/max_steps 进度与 task_id）——
 *                   刷新后前端要拿 runId 才能取消 pending 的 Run（D19 只允许取消 pending）
 *   *_truncated     该列表是否因超过上限而被截断（丢了更早的条目）
 *
 * 注意 events 里**不含** artifact 事件（工件的唯一历史来源是 artifacts 字段），
 * 工具卡也**不由 events 承担**（唯一来源是 tool_calls，按 tool_call_id 归并）——
 * 两处都返回会让同一张卡片渲染两遍。
 */
export const GET = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const conversationId = parsePathId(params.id, "会话 id");
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
    // runs 行本来就在内存里（runIds 就是它的投影），这里只是多序列化一次、零额外查询
    runs: runs.map(serializeRun),
    // 截断标记：达到上限即置位（可能还有更早的内容没返回），前端据此提示。注意恰好等于上限时是假阳性
    events_truncated: replayEvents.length >= EVENT_REPLAY_LIMIT,
    tool_calls_truncated: toolCalls.length >= TOOL_CALL_LIMIT,
    artifacts_truncated: artifactEvents.length >= ARTIFACT_LIMIT,
  });
});

/**
 * DELETE /api/agent/conversations/[id] 删除会话（接口 8）
 *
 * 级联范围与「为什么执行中的会话不能删」见 deleteConversationDeep。
 * 归属校验在该服务函数的最前面 —— 他人的会话一律 404，不会因为「正在跑」而泄露出 409。
 */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const conversationId = parsePathId(params.id, "会话 id");
  const result = await deleteConversationDeep(conversationId, user.id);
  if (result === "not_found") throw notFound("会话不存在");
  if (result === "active_run") {
    throw new ApiError(409, "会话正在执行中，请先取消或等待任务结束再删除");
  }
  return NextResponse.json({ deleted: true, id: conversationId });
});
