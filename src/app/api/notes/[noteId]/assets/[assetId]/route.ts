import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";

/** 获取当前用户拥有的笔记（对应原版 _get_owned_note） */
async function getOwnedNote(userId: number, noteId: number) {
  const note = await prisma.note.findUnique({ where: { id: noteId } });
  if (!note || note.userId !== userId) throw notFound("Note not found");
  return note;
}

/** DELETE /api/notes/{noteId}/assets/{assetId} 删除素材（对应原版 delete_note_asset） */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const noteId = Number.parseInt(params.noteId, 10);
  const assetId = Number.parseInt(params.assetId, 10);
  const note = await getOwnedNote(user.id, noteId);
  const asset = await prisma.noteAsset.findFirst({ where: { id: assetId, noteId: note.id } });
  if (!asset) throw notFound("Asset not found");
  await prisma.noteAsset.delete({ where: { id: asset.id } });
  return NextResponse.json({ id: assetId, status: "deleted" });
});
