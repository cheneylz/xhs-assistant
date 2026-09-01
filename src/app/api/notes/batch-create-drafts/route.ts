import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { formatDateTime, shanghaiNow } from "@/lib/server/core/time";
import type { AiDraft, Note } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

/** 批量创建草稿请求体（对应原版 BatchCreateDraftsRequest） */
const BatchCreateDraftsSchema = z.object({
  note_ids: z.array(z.number().int()).min(1),
  intent: z.string().max(32).default("rewrite"),
});

/** 序列化草稿（对应原版 _serialize_draft） */
function serializeDraft(draft: AiDraft) {
  return {
    id: draft.id,
    platform: draft.platform,
    title: draft.title,
    body: draft.body,
    source_note_id: draft.sourceNoteId,
    created_at: formatDateTime(draft.createdAt),
  };
}

/** 获取当前用户拥有的笔记（对应原版 _get_owned_note） */
async function getOwnedNote(userId: number, noteId: number) {
  const note = await prisma.note.findUnique({ where: { id: noteId } });
  if (!note || note.userId !== userId) throw notFound("Note not found");
  return note;
}

/** 去重并校验笔记均归属当前用户（对应原版 _get_unique_owned_notes） */
async function getUniqueOwnedNotes(userId: number, noteIds: number[]): Promise<Note[]> {
  const notes: Note[] = [];
  for (const noteId of [...new Set(noteIds)]) {
    notes.push(await getOwnedNote(userId, noteId));
  }
  return notes;
}

/** POST /api/notes/batch-create-drafts 批量基于笔记生成 AI 草稿（对应原版 batch_create_drafts） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, BatchCreateDraftsSchema);
  const notes = await getUniqueOwnedNotes(user.id, payload.note_ids);

  const drafts: AiDraft[] = [];
  for (const note of notes) {
    const draft = await prisma.aiDraft.create({
      data: {
        userId: user.id,
        platform: note.platform,
        title: note.title,
        body: note.content,
        sourceNoteId: note.id,
        createdAt: shanghaiNow(),
      },
    });
    drafts.push(draft);
  }
  return NextResponse.json({ created_count: drafts.length, items: drafts.map(serializeDraft) });
});
