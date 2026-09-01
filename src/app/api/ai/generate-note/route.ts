import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { handle, readJson } from "@/lib/server/core/route";
import { shanghaiNow } from "@/lib/server/core/time";
import { OpenAICompatibleTextClient } from "@/lib/server/services/ai-service";
import { NextResponse } from "next/server";
import { z } from "zod";
import { recordedTextTask, serializeDraft, textModelContext } from "../shared";
import { makeUsageLogger } from "@/lib/server/services/usage-service";

const GenerateNoteSchema = z.object({
  platform: z.enum(["xhs", "douyin", "kuaishou", "weibo", "xianyu", "taobao"]).default("xhs"),
  topic: z.string().min(1).max(300),
  reference: z.string().max(4000).default(""),
  instruction: z.string().max(1000).default(""),
});

/** POST /api/ai/generate-note 生成笔记并保存为草稿（对应原版 generate_note） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, GenerateNoteSchema);
  const { modelConfig, apiKey } = await textModelContext(user.id);
  const client = new OpenAICompatibleTextClient();
  const [task, result] = await recordedTextTask({
    userId: user.id,
    platform: payload.platform,
    taskType: "ai_generate_note",
    payload: { model_config_id: modelConfig.id, topic: payload.topic },
    action: async () =>
      client.generateNote({
        modelConfig,
        apiKey,
        onUsage: makeUsageLogger(user.id, modelConfig.modelName),
        topic: payload.topic,
        reference: payload.reference,
        instruction: payload.instruction,
      }),
  });
  const generated = result as { title: string; body: string };
  const draft = await prisma.aiDraft.create({
    data: {
      userId: user.id,
      platform: payload.platform,
      title: generated.title || payload.topic,
      body: generated.body || "",
      createdAt: shanghaiNow(),
    },
  });
  const taskPayload = (task.payload as Record<string, unknown> | null) ?? {};
  await prisma.task.update({
    where: { id: task.id },
    data: { payload: { ...taskPayload, result_draft_id: draft.id } },
  });
  return NextResponse.json(serializeDraft(draft));
});
