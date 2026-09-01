import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { formatDateTime } from "@/lib/server/core/time";
import { noteMetrics } from "@/lib/server/services/scheduler-service";
import { NextResponse } from "next/server";

/** GET /api/xhs/monitoring/targets/{targetId}/notes 匹配笔记（对应原版 target_notes） */
export const GET = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const targetId = Number.parseInt(params.targetId, 10);
  const target = await prisma.monitoringTarget.findUnique({ where: { id: targetId } });
  if (!target || target.userId !== user.id || target.platform !== "xhs") {
    throw notFound("Monitoring target not found");
  }
  const needle = target.value.trim().toLowerCase();
  const notes = await prisma.note.findMany({
    where: { userId: user.id, platform: "xhs" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const rawText = (note: { noteId: string; title: string; content: string; authorName: string; rawJson: unknown }) =>
    [note.noteId, note.title, note.content, note.authorName, JSON.stringify(note.rawJson ?? {})].join("\n").toLowerCase();
  const matched = notes
    .filter((note) => (needle ? rawText(note).includes(needle) : false))
    .sort((a, b) => noteMetrics(b).engagement - noteMetrics(a).engagement);
  const items = matched.map((note) => ({
    id: note.id,
    note_id: note.noteId,
    title: note.title,
    author_name: note.authorName,
    created_at: formatDateTime(note.createdAt),
    ...noteMetrics(note),
  }));
  return NextResponse.json({ target_id: target.id, items });
});
