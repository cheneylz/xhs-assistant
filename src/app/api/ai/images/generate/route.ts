import type { Prisma } from "@prisma/client";
import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { handle, readJson } from "@/lib/server/core/route";
import { shanghaiNow } from "@/lib/server/core/time";
import { OpenAICompatibleImageClient } from "@/lib/server/services/ai-service";
import { NextResponse } from "next/server";
import { z } from "zod";
import { imageModelContext, recordedImageTask, serializeGeneratedAsset } from "../../shared";

const GenerateImageSchema = z.object({
  prompt: z.string().min(1).max(2000),
  reference_images: z.array(z.string()).default([]),
  save_to_assets: z.boolean().default(true),
});

/** POST /api/ai/images/generate 生成图片（save_to_assets 为 true 时同时保存为资产，对应原版 generate_image） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, GenerateImageSchema);
  const { modelConfig, apiKey } = await imageModelContext(user.id);
  const client = new OpenAICompatibleImageClient();
  const [task, result] = await recordedImageTask({
    userId: user.id,
    taskType: "ai_image_generate",
    payload: { model_config_id: modelConfig.id, prompt: payload.prompt, reference_images: payload.reference_images },
    action: async () =>
      client.generateImage({
        modelConfig,
        apiKey,
        prompt: payload.prompt,
        referenceImages: payload.reference_images.length ? payload.reference_images : null,
      }),
  });
  const imageResult = result as { url: string; raw: unknown };
  const responseData: Record<string, unknown> = { url: imageResult.url ?? "", raw: imageResult.raw };
  if (payload.save_to_assets) {
    const asset = await prisma.aiGeneratedAsset.create({
      data: {
        userId: user.id,
        prompt: payload.prompt,
        modelName: modelConfig.modelName,
        params: { reference_images: payload.reference_images, raw: imageResult.raw } as Prisma.InputJsonValue,
        filePath: imageResult.url ?? "",
        createdAt: shanghaiNow(),
      },
    });
    const taskPayload = (task.payload as Record<string, unknown> | null) ?? {};
    await prisma.task.update({
      where: { id: task.id },
      data: { payload: { ...taskPayload, asset_id: asset.id } },
    });
    responseData.asset = serializeGeneratedAsset(asset);
  }
  return NextResponse.json(responseData);
});
