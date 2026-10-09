import { getCurrentUser } from "@/lib/server/core/auth";
import { handle, readJson } from "@/lib/server/core/route";
import { createConversation, DEFAULT_CONVERSATION_TITLE, listConversations } from "@/lib/server/services/agent-service";
import { NextResponse } from "next/server";
import { z } from "zod";
import { serializeConversation } from "../shared";

const CreateConversationSchema = z.object({
  // 手工标题允许比自动派生的长（派生规则见 deriveConversationTitle：20 字 + 省略号），
  // 因为那是用户自己起的名字；trim 是为了挡住纯空白
  title: z.string().trim().min(1).max(40).default(DEFAULT_CONVERSATION_TITLE),
});

/** GET /api/agent/conversations 会话列表（左栏，按更新时间倒序） */
export const GET = handle(async (req) => {
  const user = await getCurrentUser(req);
  const conversations = await listConversations(user.id);
  return NextResponse.json({ items: conversations.map(serializeConversation) });
});

/** POST /api/agent/conversations 新建会话（请求体可传 { title }，默认「新任务」） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, CreateConversationSchema);
  const conversation = await createConversation(user.id, payload.title);
  return NextResponse.json(serializeConversation(conversation));
});
