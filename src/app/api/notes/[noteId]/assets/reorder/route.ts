import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { z } from "zod";

/** 素材排序请求体（对应原版 ReorderAssetsRequest） */
const ReorderAssetsSchema = z.object({
  asset_ids: z.array(z.number().int()).min(1),
});

/** 获取当前用户拥有的笔记（对应原版 _get_owned_note） */
async function getOwnedNote(userId: number, noteId: number) {
  const note = await prisma.note.findUnique({ where: { id: noteId } });
  if (!note || note.userId !== userId) throw notFound("Note not found");
  return note;
}

/** PUT /api/notes/{noteId}/assets/reorder 素材排序（对应原版 reorder_note_assets） */
export const PUT = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const noteId = Number.parseInt(params.noteId, 10);
  const note = await getOwnedNote(user.id, noteId);
  const payload = await readJson(req, ReorderAssetsSchema);
  const assets = await prisma.noteAsset.findMany({ where: { noteId: note.id } });
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  // 按提交顺序写入 sort_order（仅更新存在的素材，对应原版）
  let index = 0;
  for (const assetId of payload.asset_ids) {
    const asset = assetMap.get(assetId);
    if (asset) {
      await prisma.noteAsset.update({ where: { id: asset.id }, data: { sortOrder: index } });
    }
    index++;
  }
  return NextResponse.json({ ok: true });
});
