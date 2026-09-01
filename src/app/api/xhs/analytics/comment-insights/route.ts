import { getCurrentUser } from "@/lib/server/core/auth";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { ownedComments } from "../shared";

/** GET /api/xhs/analytics/comment-insights 评论洞察（中文关键词，对应原版 comment_insights） */
export const GET = handle(async (req) => {
  const user = await getCurrentUser(req);
  const comments = await ownedComments(user.id);
  const repeatedTerms = new Map<string, number>();
  for (const comment of comments) {
    for (const term of ["价格", "多少钱", "链接", "适合", "怎么", "哪里", "推荐", "通勤"]) {
      if (comment.content.includes(term)) repeatedTerms.set(term, (repeatedTerms.get(term) ?? 0) + 1);
    }
  }
  return NextResponse.json({
    total_comments: comments.length,
    question_count: comments.filter((comment) => comment.content.includes("?") || comment.content.includes("？")).length,
    top_terms: [...repeatedTerms.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([term, count]) => ({ term, count })),
    top_comments: comments.slice(0, 10).map((comment) => ({
      id: comment.id,
      note_id: comment.noteId,
      user_name: comment.userName,
      content: comment.content,
      like_count: comment.likeCount,
    })),
  });
});
