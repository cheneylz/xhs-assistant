import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { handle, readJson } from "@/lib/server/core/route";
import { OpenAICompatibleTextClient } from "@/lib/server/services/ai-service";
import { NextResponse } from "next/server";
import { z } from "zod";
import { recordedTextTask, textModelContext } from "../shared";
import { makeUsageLogger } from "@/lib/server/services/usage-service";

const GenerateTagsSchema = z.object({
  title: z.string().max(300).default(""),
  body: z.string().min(1).max(6000),
  count: z.number().int().min(1).max(20).default(8),
});

/** POST /api/ai/generate-tags 生成话题标签（对应原版 generate_tags） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, GenerateTagsSchema);
  const { modelConfig, apiKey } = await textModelContext(user.id);
  const client = new OpenAICompatibleTextClient();
  const [task, result] = await recordedTextTask({
    userId: user.id,
    platform: "xhs",
    taskType: "ai_generate_tags",
    payload: { model_config_id: modelConfig.id, count: payload.count },
    action: async () =>
      client.generateTags({ modelConfig, apiKey, onUsage: makeUsageLogger(user.id, modelConfig.modelName), title: payload.title, body: payload.body, count: payload.count }),
  });
  const items = result as string[];
  const taskPayload = (task.payload as Record<string, unknown> | null) ?? {};
  await prisma.task.update({
    where: { id: task.id },
    data: { payload: { ...taskPayload, result_count: items.length } },
  });
  return NextResponse.json({ items });
});
