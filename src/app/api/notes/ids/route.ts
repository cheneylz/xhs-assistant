import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";

/** GET /api/notes/ids 当前用户笔记的 note_id 列表（对应原版 get_note_ids） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const platform = searchParams.get("platform") ?? undefined;
  const notes = await prisma.note.findMany({
    where: { userId: user.id, ...(platform ? { platform } : {}) },
    select: { noteId: true },
  });
  return NextResponse.json({ items: notes.map((note) => note.noteId) });
});
