import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { prisma } from "@/lib/server/core/db";
import { serializeCommentReply } from "@/lib/server/services/comment-reply-service";
import { NextResponse } from "next/server";

/** POST /api/xhs/comments/replies/{replyId}/skip 跳过该回复（不发布） */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const replyId = Number.parseInt(params.replyId, 10);
  const reply = await prisma.commentReply.findFirst({ where: { id: replyId, userId: user.id } });
  if (!reply) throw notFound("Reply not found");
  if (reply.status !== "pending") throw new ApiError(400, "该回复已处理");
  const updated = await prisma.commentReply.update({
    where: { id: reply.id },
    data: { status: "skipped" },
  });
  return NextResponse.json(serializeCommentReply(updated));
});
