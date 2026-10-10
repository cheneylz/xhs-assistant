import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { paginated } from "@/lib/server/core/paginate";
import { handle } from "@/lib/server/core/route";
import { listNoteComments } from "@/lib/server/services/note-service";
import { NextResponse } from "next/server";

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
  const result = await listNoteComments(user.id, noteId);
  if (result.outcome === "not_found") throw notFound("Note not found");
  return NextResponse.json(paginated(result.items, page, pageSize));
});
