import { getCurrentUser } from "@/lib/server/core/auth";
import { notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { deleteTopicSuggestion } from "@/lib/server/services/suggestion-service";
import { NextResponse } from "next/server";

/** DELETE /api/xhs/analytics/suggestions/{suggestionId} 删除选题（仅限本人） */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const suggestionId = Number.parseInt(params.suggestionId, 10);
  if (Number.isNaN(suggestionId)) throw notFound("Suggestion not found");
  await deleteTopicSuggestion(user.id, suggestionId).catch((error) => {
    throw notFound((error as Error).message);
  });
  return NextResponse.json({ id: suggestionId, status: "deleted" });
});
