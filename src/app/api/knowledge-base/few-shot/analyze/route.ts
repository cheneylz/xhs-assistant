import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { badRequest, notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { analyzeNoteStyle } from "@/lib/server/services/knowledge-base-service";
import { OpenAICompatibleTextClient } from "@/lib/server/services/ai-service";
import { textModelContext } from "../../../ai/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

const AnalyzeStyleSchema = z.object({
  note_id: z.number().int().nullable().optional(),
  title: z.string().max(300).optional(),
  body: z.string().max(20000).optional(),
});

/** POST /api/knowledge-base/few-shot/analyze LLM 风格分析（C-07），返回 style_analysis 文本 */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, AnalyzeStyleSchema);

  let title = payload.title ?? "";
  let body = payload.body ?? "";
  if (payload.note_id) {
    const note = await prisma.note.findFirst({ where: { id: payload.note_id, userId: user.id } });
    if (!note) throw notFound("Note not found");
    title = title || note.title;
    body = body || note.content;
  }
  if (!title.trim() && !body.trim()) throw badRequest("分析内容不能为空");

  const { modelConfig, apiKey } = await textModelContext(user.id);
  const styleAnalysis = await analyzeNoteStyle({
    title,
    body,
    modelConfig,
    apiKey,
    textClient: new OpenAICompatibleTextClient(),
  });
  return NextResponse.json({ style_analysis: styleAnalysis });
});
