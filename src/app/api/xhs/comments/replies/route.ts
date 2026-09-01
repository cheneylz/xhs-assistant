import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { handle } from "@/lib/server/core/route";
import { serializeCommentReply } from "@/lib/server/services/comment-reply-service";
import { NextResponse } from "next/server";

/** GET /api/xhs/comments/replies 评论响应审核队列（?status= 筛选，pending 优先） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const status = searchParams.get("status");
  const items = await prisma.commentReply.findMany({
    where: { userId: user.id, ...(status ? { status } : {}) },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 100,
  });
  return NextResponse.json({ items: items.map(serializeCommentReply) });
});
