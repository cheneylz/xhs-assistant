import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { findOwnedNote, getNoteDetail } from "@/lib/server/services/note-service";
import { NextResponse } from "next/server";

/** GET /api/notes/{noteId} 笔记详情（含标签，对应原版 get_note） */
export const GET = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const noteId = Number.parseInt(params.noteId, 10);
  const detail = await getNoteDetail(user.id, noteId);
  if (!detail) throw notFound("Note not found");
  return NextResponse.json(detail);
});

/** DELETE /api/notes/{noteId} 删除笔记（级联清理标签/素材/评论，对应原版 delete_note） */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const noteId = Number.parseInt(params.noteId, 10);
  const note = await findOwnedNote(user.id, noteId);
  if (!note) throw notFound("Note not found");
  await prisma.noteTags.deleteMany({ where: { noteId: note.id } });
  await prisma.noteAsset.deleteMany({ where: { noteId: note.id } });
  await prisma.noteComment.deleteMany({ where: { noteId: note.id } });
  // 解除相关草稿的 source_note_id 引用（对应原版 update 置空）
  await prisma.aiDraft.updateMany({ where: { sourceNoteId: note.id }, data: { sourceNoteId: null } });
  await prisma.note.delete({ where: { id: note.id } });
  return NextResponse.json({ id: noteId, status: "deleted" });
});
