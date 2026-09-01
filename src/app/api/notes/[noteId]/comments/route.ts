import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { paginated } from "@/lib/server/core/paginate";
import { handle } from "@/lib/server/core/route";
import type { NoteComment } from "@prisma/client";
import { NextResponse } from "next/server";

/** 序列化评论（对应原版 _serialize_comment） */
function serializeComment(comment: NoteComment) {
  return {
    id: comment.id,
    note_id: comment.noteId,
    comment_id: comment.commentId,
    user_name: comment.userName,
    user_id: comment.userId,
    content: comment.content,
    like_count: comment.likeCount,
    parent_comment_id: comment.parentCommentId,
    created_at_remote: comment.createdAtRemote,
    raw_json: comment.rawJson,
  };
}

/** 获取当前用户拥有的笔记（对应原版 _get_owned_note） */
async function getOwnedNote(userId: number, noteId: number) {
  const note = await prisma.note.findUnique({ where: { id: noteId } });
  if (!note || note.userId !== userId) throw notFound("Note not found");
  return note;
}

/** 解析并校验分页参数（page>=1、page_size 1..200，对应原版 Query 校验） */
function parsePageParams(searchParams: URLSearchParams, defaultPageSize = 50, maxPageSize = 200) {
  const page = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(searchParams.get("page_size") ?? String(defaultPageSize), 10);
  if (Number.isNaN(page) || page < 1) throw new ApiError(422, "page must be >= 1");
  if (Number.isNaN(pageSize) || pageSize < 1 || pageSize > maxPageSize) {
    throw new ApiError(422, `page_size must be between 1 and ${maxPageSize}`);
  }
  return { page, pageSize };
}

/** GET /api/notes/{noteId}/comments 评论列表（分页，page_size 上限 200，对应原版 get_note_comments） */
export const GET = handle(async (req, { params, searchParams }) => {
  const user = await getCurrentUser(req);
  const noteId = Number.parseInt(params.noteId, 10);
  const { page, pageSize } = parsePageParams(searchParams);
  const note = await getOwnedNote(user.id, noteId);
  const comments = await prisma.noteComment.findMany({
    where: { noteId: note.id },
    orderBy: { id: "asc" },
  });
  return NextResponse.json(paginated(comments.map(serializeComment), page, pageSize));
});
