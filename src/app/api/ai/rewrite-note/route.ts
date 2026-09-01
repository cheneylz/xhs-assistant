import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { OpenAICompatibleTextClient } from "@/lib/server/services/ai-service";
import { NextResponse } from "next/server";
import { z } from "zod";
import { recordedTextTask, serializeDraft, textModelContext } from "../shared";
import { makeUsageLogger } from "@/lib/server/services/usage-service";

const RewriteNoteSchema = z.object({
  draft_id: z.number().int(),
  instruction: z.string().max(800).default(""),
  intensity: z.enum(["light", "medium", "deep"]).default("medium"), // 去AI味强度（C-02）
});

/** POST /api/ai/rewrite-note 改写笔记正文（对应原版 rewrite_note） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, RewriteNoteSchema);
  const draft = await prisma.aiDraft.findUnique({ where: { id: payload.draft_id } });
  if (!draft || draft.userId !== user.id) {
    throw notFound("Draft not found");
  }
  const { modelConfig, apiKey } = await textModelContext(user.id);
  const client = new OpenAICompatibleTextClient();
  const [task, result] = await recordedTextTask({
    userId: user.id,
    platform: draft.platform,
    taskType: "ai_rewrite",
    payload: { draft_id: draft.id, model_config_id: modelConfig.id, instruction: payload.instruction, intensity: payload.intensity },
    action: async () =>
      client.rewriteNote({
        modelConfig,
        apiKey,
        onUsage: makeUsageLogger(user.id, modelConfig.modelName),
        title: draft.title,
        body: draft.body,
        instruction: payload.instruction,
        intensity: payload.intensity,
      }),
  });
  const rewrittenBody = String(result);
  const updatedDraft = await prisma.aiDraft.update({ where: { id: draft.id }, data: { body: rewrittenBody } });
  const taskPayload = (task.payload as Record<string, unknown> | null) ?? {};
  await prisma.task.update({
    where: { id: task.id },
    data: {
      payload: { ...taskPayload, result_draft_id: draft.id, result_length: rewrittenBody.length },
    },
  });
  return NextResponse.json(serializeDraft(updatedDraft));
});
