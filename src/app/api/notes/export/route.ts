import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getCurrentUser } from "@/lib/server/core/auth";
import { getConfig } from "@/lib/server/core/config";
import { notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { formatDateTime, shanghaiNow } from "@/lib/server/core/time";
import { findOwnedNote, getNoteTags, serializeNoteWithTags } from "@/lib/server/services/note-service";
import type { Note } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

/** 导出笔记请求体（对应原版 ExportNotesRequest） */
const ExportNotesSchema = z.object({
  note_ids: z.array(z.number().int()).min(1),
  format: z.enum(["json", "csv"]).default("json"),
});

/** 获取当前用户拥有的笔记（服务层不抛状态码，这里把 null 映射成 404） */
async function getOwnedNote(userId: number, noteId: number): Promise<Note> {
  const note = await findOwnedNote(userId, noteId);
  if (!note) throw notFound("Note not found");
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

/** CSV 字段转义（对应 Python csv 模块 QUOTE_MINIMAL 规则） */
function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** 构建笔记导出 CSV（对应原版 _build_notes_csv） */
async function buildNotesCsv(notes: Note[]): Promise<string> {
  const rows: string[] = [];
  rows.push(["note_id", "title", "author_name", "content", "tags", "created_at"].join(","));
  for (const note of notes) {
    const tags = (await getNoteTags(note.id)).map((tag) => tag.name).join(",");
    rows.push(
      [note.noteId, note.title, note.authorName, note.content, tags, formatDateTime(note.createdAt)]
        .map(csvEscape)
        .join(","),
    );
  }
  return rows.join("\r\n");
}

/** POST /api/notes/export 导出笔记为 JSON / CSV 文件（对应原版 export_notes） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, ExportNotesSchema);
  const notes = await getUniqueOwnedNotes(user.id, payload.note_ids);

  const exportDir = `${getConfig().storageDir}/exports`;
  mkdirSync(exportDir, { recursive: true });
  const exportedAt = shanghaiNow();
  const timeStamp = formatDateTime(exportedAt).replace(/[-:T]/g, "");
  const fileName = `xhs-notes-u${user.id}-${timeStamp}-${randomUUID().replace(/-/g, "").slice(0, 8)}.${payload.format}`;
  const filePath = resolve(exportDir, fileName);

  if (payload.format === "csv") {
    // CSV 加 BOM 保证 Excel 正确识别 UTF-8（对应原版 ﻿ 前缀）
    writeFileSync(filePath, "﻿" + (await buildNotesCsv(notes)), "utf-8");
  } else {
    const exportPayload: Record<string, unknown> = {
      platform: "xhs",
      format: payload.format,
      exported_at: formatDateTime(exportedAt),
      total: notes.length,
      items: [] as Array<Record<string, unknown>>,
    };
    const items: Array<Record<string, unknown>> = [];
    for (const note of notes) items.push(await serializeNoteWithTags(note));
    exportPayload.items = items;
    writeFileSync(filePath, JSON.stringify(exportPayload, null, 2), "utf-8");
  }

  return NextResponse.json({
    exported_count: notes.length,
    file_name: fileName,
    file_path: filePath,
    download_url: `/api/files/exports/${fileName}`,
  });
});
