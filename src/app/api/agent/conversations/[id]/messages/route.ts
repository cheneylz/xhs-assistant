import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { handle, parsePathId, readJson } from "@/lib/server/core/route";
import {
  appendMessage,
  createRunForMessage,
  DEFAULT_CONVERSATION_TITLE,
  deriveConversationTitle,
  findConversationForUser,
  hasActiveRun,
} from "@/lib/server/services/agent-service";
import { NextResponse } from "next/server";
import { z } from "zod";
import { serializeConversation, serializeMessage, serializeRun } from "../../../shared";

const SendMessageSchema = z.object({
  content: z.string().min(1).max(4000),
});

/**
 * POST /api/agent/conversations/[id]/messages 发消息 → 建 Run（P1 设计稿 §3.2 ①②）
 *
 * 一次只允许一个 Run：同一会话并行两个循环会交叉写 agent_messages，
 * 让模型的上下文顺序错乱（worker 的并发上限是 3，同一个会话必须串行）。
 *
 * 已知局限（P1 接受）：这里的检查是 TOCTOU —— 两个并发的 POST 可能都通过检查。
 * 窗口是毫秒级、前端在运行中会禁用输入框，且没有可用的部分唯一索引
 * （`db push` 管不了 partial unique index），故不在 P1 用数据库约束兜底。
 */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const conversationId = parsePathId(params.id, "会话 id");
  const conversation = await findConversationForUser(conversationId, user.id);
  if (!conversation) throw notFound("会话不存在");

  const payload = await readJson(req, SendMessageSchema);
  const content = payload.content.trim();
  if (!content) throw new ApiError(422, "消息内容不能为空");

  if (await hasActiveRun(conversationId)) {
    throw new ApiError(409, "会话正在执行中，请等待当前任务完成后继续");
  }

  const message = await appendMessage({ conversationId, role: "user", content });
  // Task + Run + 会话状态在 createRunForMessage 里同事务写入（原因见该函数注释）。
  // 用户消息在事务之前单独落库：建 Run 失败会留下一条没有 Run 的消息，
  // 用户重发即可 —— 比把消息写入卷进事务更简单，且不会让消息丢失。
  const title = conversation.title === DEFAULT_CONVERSATION_TITLE ? deriveConversationTitle(content) : undefined;
  const run = await createRunForMessage({ conversationId, userId: user.id, messageId: message.id, title });

  // 回读一次拿最终状态：worker 若已跑完，这里读到的 idle 才是真实状态
  const fresh = await findConversationForUser(conversationId, user.id);
  if (!fresh) throw notFound("会话不存在");

  return NextResponse.json({
    conversation: serializeConversation(fresh),
    message: serializeMessage(message),
    run: serializeRun(run),
  });
});
