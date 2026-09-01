import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { formatDateTime } from "@/lib/server/core/time";
import type { AiDraft, Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

/** 更新草稿请求体（对应原版 DraftUpdateRequest） */
const DraftUpdateSchema = z.object({
  title: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  tags: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
});

/** 序列化草稿（含 tags，对应原版 _serialize_draft） */
function serializeDraft(draft: AiDraft) {
  return {
    id: draft.id,
    platform: draft.platform,
    title: draft.title,
    body: draft.body,
    tags: draft.tags ?? [],
    source_note_id: draft.sourceNoteId,
    created_at: formatDateTime(draft.createdAt),
  };
}

/** 获取当前用户拥有的草稿（对应原版 _get_owned_draft 逻辑） */
async function getOwnedDraft(userId: number, draftId: number) {
  const draft = await prisma.aiDraft.findUnique({ where: { id: draftId } });
  if (!draft || draft.userId !== userId) throw notFound("Draft not found");
  return draft;
}

/** PATCH /api/drafts/{draftId} 更新草稿（对应原版 update_draft） */
export const PATCH = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const draftId = Number.parseInt(params.draftId, 10);
  const draft = await getOwnedDraft(user.id, draftId);
  const payload = await readJson(req, DraftUpdateSchema);
  const updated = await prisma.aiDraft.update({
    where: { id: draft.id },
    data: {
      ...(payload.title !== null && payload.title !== undefined ? { title: payload.title } : {}),
      ...(payload.body !== null && payload.body !== undefined ? { body: payload.body } : {}),
      ...(payload.tags !== null && payload.tags !== undefined ? { tags: payload.tags as Prisma.InputJsonValue } : {}),
    },
  });
  return NextResponse.json(serializeDraft(updated));
});

/** DELETE /api/drafts/{draftId} 删除草稿（级联删除素材，对应原版 delete_draft） */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const draftId = Number.parseInt(params.draftId, 10);
  await getOwnedDraft(user.id, draftId);
  await prisma.draftAsset.deleteMany({ where: { draftId } });
  await prisma.aiDraft.delete({ where: { id: draftId } });
  return NextResponse.json({ id: draftId, status: "deleted" });
});
