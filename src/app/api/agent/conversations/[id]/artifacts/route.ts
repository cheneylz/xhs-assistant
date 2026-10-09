import { getCurrentUser } from "@/lib/server/core/auth";
import { notFound } from "@/lib/server/core/http-error";
import { handle, parsePathId } from "@/lib/server/core/route";
import { findConversationForUser, listArtifactEvents, listRuns } from "@/lib/server/services/agent-service";
import { NextResponse } from "next/server";
import { serializeArtifact } from "../../../shared";

/** GET /api/agent/conversations/[id]/artifacts 工件列表（右栏单独刷新用，P1 设计稿 §4.4） */
export const GET = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const conversationId = parsePathId(params.id, "会话 id");
  const conversation = await findConversationForUser(conversationId, user.id);
  if (!conversation) throw notFound("会话不存在");

  const runs = await listRuns(conversationId);
  const events = await listArtifactEvents(runs.map((run) => run.id));
  return NextResponse.json({ items: events.map(serializeArtifact).filter((item) => item !== null) });
});
