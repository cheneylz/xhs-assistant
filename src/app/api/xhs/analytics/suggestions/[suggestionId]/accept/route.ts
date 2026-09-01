import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { acceptSuggestion } from "@/lib/server/services/suggestion-service";
import { NextResponse } from "next/server";

/** POST /api/xhs/analytics/suggestions/{suggestionId}/accept 采纳选题：一键加入内容生产队列 */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const suggestionId = Number.parseInt(params.suggestionId, 10);
  try {
    const result = await acceptSuggestion(user.id, suggestionId);
    return NextResponse.json(result);
  } catch (error) {
    throw new ApiError(400, (error as Error).message);
  }
});
