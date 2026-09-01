import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { OpenAICompatibleTextClient } from "@/lib/server/services/ai-service";
import { NextResponse } from "next/server";
import { z } from "zod";
import { recordedTextTask, textModelContext } from "../shared";
import { makeUsageLogger } from "@/lib/server/services/usage-service";

const GenerateScriptSchema = z.object({
  draft_id: z.number().int(),
});

/** POST /api/ai/generate-script C-05 基于草稿文案生成短视频分镜脚本 */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, GenerateScriptSchema);
  const draft = await prisma.aiDraft.findFirst({ where: { id: payload.draft_id, userId: user.id } });
  if (!draft) throw notFound("Draft not found");
  const { modelConfig, apiKey } = await textModelContext(user.id);
  const client = new OpenAICompatibleTextClient();
  const [task, result] = await recordedTextTask({
    userId: user.id,
    platform: draft.platform,
    taskType: "ai_generate_script",
    payload: { draft_id: draft.id, model_config_id: modelConfig.id },
    action: async () =>
      client.generateVideoScript({
        modelConfig,
        apiKey,
        onUsage: makeUsageLogger(user.id, modelConfig.modelName),
        title: draft.title,
        body: draft.body,
      }),
  });
  const script = String(result);
  const taskPayload = (task.payload as Record<string, unknown> | null) ?? {};
  await prisma.task.update({
    where: { id: task.id },
    data: { payload: { ...taskPayload, script_length: script.length } },
  });
  return NextResponse.json({ draft_id: draft.id, script });
});
