import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { handle, readJson } from "@/lib/server/core/route";
import { OpenAICompatibleTextClient } from "@/lib/server/services/ai-service";
import { NextResponse } from "next/server";
import { z } from "zod";
import { recordedTextTask, textModelContext } from "../shared";
import { makeUsageLogger } from "@/lib/server/services/usage-service";

const PolishTextSchema = z.object({
  text: z.string().min(1).max(6000),
  instruction: z.string().max(800).default(""),
});

/** POST /api/ai/polish-text 润色正文（对应原版 polish_text） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, PolishTextSchema);
  const { modelConfig, apiKey } = await textModelContext(user.id);
  const client = new OpenAICompatibleTextClient();
  const [task, result] = await recordedTextTask({
    userId: user.id,
    platform: "xhs",
    taskType: "ai_polish_text",
    payload: { model_config_id: modelConfig.id, instruction: payload.instruction },
    action: async () => client.polishText({ modelConfig, apiKey, onUsage: makeUsageLogger(user.id, modelConfig.modelName), text: payload.text, instruction: payload.instruction }),
  });
  const text = String(result);
  const taskPayload = (task.payload as Record<string, unknown> | null) ?? {};
  await prisma.task.update({
    where: { id: task.id },
    data: { payload: { ...taskPayload, result_length: text.length } },
  });
  return NextResponse.json({ text });
});
