import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { findOwnedNote, serializeNoteWithTags } from "@/lib/server/services/note-service";
import type { Note } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

/** 批量打标签请求体（对应原版 BatchTagNotesRequest） */
const BatchTagNotesSchema = z.object({
  note_ids: z.array(z.number().int()).min(1),
  tag_ids: z.array(z.number().int()).default([]),
  mode: z.enum(["replace", "add", "remove"]).default("replace"),
});

/** 获取当前用户拥有的笔记（服务层不抛状态码，这里把 null 映射成 404） */
async function getOwnedNote(userId: number, noteId: number): Promise<Note> {
  const note = await findOwnedNote(userId, noteId);
  if (!note) throw notFound("Note not found");
  return note;
}

/** POST /api/notes/batch-tag 批量打标签（replace / add / remove，对应原版 batch_tag_notes） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, BatchTagNotesSchema);

  // 去重并校验笔记归属（对应原版 _get_owned_note 循环）
  const noteIds = [...new Set(payload.note_ids)];
  const notes: Note[] = [];
  for (const noteId of noteIds) {
    notes.push(await getOwnedNote(user.id, noteId));
  }

  // 校验标签均归属当前用户（对应原版）
  const tagIds = [...new Set(payload.tag_ids)];
  for (const tagId of tagIds) {
    const tag = await prisma.tag.findUnique({ where: { id: tagId } });
    if (!tag || tag.userId !== user.id) throw notFound("Tag not found");
  }

  for (const note of notes) {
    if (payload.mode === "replace") {
      // replace：清空后全量重建关联（对应原版）
      await prisma.noteTags.deleteMany({ where: { noteId: note.id } });
      if (tagIds.length) {
        await prisma.noteTags.createMany({ data: tagIds.map((tagId) => ({ noteId: note.id, tagId })) });
      }
      continue;
    }
    if (payload.mode === "add") {
      // add：仅补充不存在的关联（对应原版）
      const existing = await prisma.noteTags.findMany({ where: { noteId: note.id }, select: { tagId: true } });
      const existingIds = new Set(existing.map((link) => link.tagId));
      const toAdd = tagIds.filter((tagId) => !existingIds.has(tagId));
      if (toAdd.length) {
        await prisma.noteTags.createMany({ data: toAdd.map((tagId) => ({ noteId: note.id, tagId })) });
      }
      continue;
    }
    // remove：仅移除指定标签的关联（对应原版 in_ 删除）
    if (tagIds.length) {
      await prisma.noteTags.deleteMany({ where: { noteId: note.id, tagId: { in: tagIds } } });
    }
  }

  const items: Array<Record<string, unknown>> = [];
  for (const note of notes) items.push(await serializeNoteWithTags(note));
  return NextResponse.json({ updated_count: notes.length, items });
});
