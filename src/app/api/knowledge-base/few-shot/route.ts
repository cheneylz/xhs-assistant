import { getCurrentUser } from "@/lib/server/core/auth";
import { handle, readJson } from "@/lib/server/core/route";
import { addFewShotNote, getKnowledgeBase, listFewShotNotes, serializeFewShotNote } from "@/lib/server/services/knowledge-base-service";
import { NextResponse } from "next/server";
import { z } from "zod";

const AddFewShotSchema = z.object({
  platform_account_id: z.number().int().nullable().optional(),
  note_id: z.number().int().nullable().optional(),
  title: z.string().max(300).optional(),
  body: z.string().max(20000).optional(),
  style_analysis: z.string().max(1000).optional(),
  sort_order: z.number().int().optional(),
});

/** GET /api/knowledge-base/few-shot 查询 Few-shot 样本列表 */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const accountId = searchParams.get("platform_account_id") ? Number.parseInt(searchParams.get("platform_account_id") ?? "", 10) : null;
  const kb = await getKnowledgeBase(user.id, Number.isNaN(accountId ?? 0) ? null : accountId);
  const items = await listFewShotNotes(kb.id);
  return NextResponse.json({ items: items.map(serializeFewShotNote) });
});

/** POST /api/knowledge-base/few-shot 新增 Few-shot 样本（note_id 关联库内笔记时自动带出内容） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, AddFewShotSchema);
  const item = await addFewShotNote({
    userId: user.id,
    platformAccountId: payload.platform_account_id ?? null,
    noteId: payload.note_id ?? null,
    title: payload.title,
    body: payload.body,
    styleAnalysis: payload.style_analysis,
    sortOrder: payload.sort_order,
  });
  return NextResponse.json(serializeFewShotNote(item));
});
