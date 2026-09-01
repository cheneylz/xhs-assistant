import type { Prisma } from "@prisma/client";
import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { shanghaiNow } from "@/lib/server/core/time";
import { OpenAICompatibleImageClient } from "@/lib/server/services/ai-service";
import { NextResponse } from "next/server";
import { z } from "zod";
import { imageModelContext, recordedImageTask, serializeGeneratedAsset } from "../../shared";

const GenerateCoverSchema = z.object({
  prompt: z.string().min(1).max(1200),
  draft_id: z.number().int().nullish(),
  size: z.string().max(32).default("1024x1024"),
  style: z.string().max(120).default("clean"),
});

/** POST /api/ai/images/generate-cover 生成封面并保存为资产（对应原版 generate_cover） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, GenerateCoverSchema);
  if (payload.draft_id !== null && payload.draft_id !== undefined) {
    const draft = await prisma.aiDraft.findUnique({ where: { id: payload.draft_id } });
    if (!draft || draft.userId !== user.id) {
      throw notFound("Draft not found");
    }
  }
  const { modelConfig, apiKey } = await imageModelContext(user.id);
  const client = new OpenAICompatibleImageClient();
  const [task, result] = await recordedImageTask({
    userId: user.id,
    taskType: "ai_image_generate_cover",
    payload: { model_config_id: modelConfig.id, prompt: payload.prompt, size: payload.size, style: payload.style },
    action: async () =>
      client.generateCover({ modelConfig, apiKey, prompt: payload.prompt, size: payload.size, style: payload.style }),
  });
  const imageResult = result as { url: string; raw: unknown };
  const asset = await prisma.aiGeneratedAsset.create({
    data: {
      userId: user.id,
      draftId: payload.draft_id ?? null,
      prompt: payload.prompt,
      modelName: modelConfig.modelName,
      params: { size: payload.size, style: payload.style, raw: imageResult.raw } as Prisma.InputJsonValue,
      filePath: imageResult.url ?? "",
      createdAt: shanghaiNow(),
    },
  });
  const taskPayload = (task.payload as Record<string, unknown> | null) ?? {};
  await prisma.task.update({
    where: { id: task.id },
    data: { payload: { ...taskPayload, asset_id: asset.id } },
  });
  return NextResponse.json(serializeGeneratedAsset(asset));
});
