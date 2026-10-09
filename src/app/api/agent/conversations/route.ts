import { getCurrentUser } from "@/lib/server/core/auth";
import { handle, readJson } from "@/lib/server/core/route";
import { createConversation, listConversations } from "@/lib/server/services/agent-service";
import { NextResponse } from "next/server";
import { z } from "zod";
import { serializeConversation } from "../shared";

const CreateConversationSchema = z.object({
  title: z.string().max(40).default("新任务"),
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
