import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { approveCommentReply } from "@/lib/server/services/comment-reply-service";
import { NextResponse } from "next/server";

/** POST /api/xhs/comments/replies/{replyId}/approve 人工确认后回复评论（D-05） */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const replyId = Number.parseInt(params.replyId, 10);
  const { XhsPcApiAdapter } = await import("@/lib/server/xhs/adapters/pc-api-adapter");
  try {
    const result = await approveCommentReply({
      userId: user.id,
      replyId,
      adapterFactory: (cookies) => new XhsPcApiAdapter(cookies),
    });
    return NextResponse.json(result.reply);
  } catch (error) {
    throw new ApiError(400, (error as Error).message);
  }
});
