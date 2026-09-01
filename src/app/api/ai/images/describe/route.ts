import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { handle, readJson } from "@/lib/server/core/route";
import { OpenAICompatibleImageClient } from "@/lib/server/services/ai-service";
import { NextResponse } from "next/server";
import { z } from "zod";
import { imageModelContext, recordedImageTask } from "../../shared";

const DescribeImageSchema = z.object({
  image_url: z.string().min(1).max(4000),
  instruction: z.string().max(800).default(""),
});

/** POST /api/ai/images/describe 描述图片（对应原版 describe_image） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, DescribeImageSchema);
  const { modelConfig, apiKey } = await imageModelContext(user.id);
  const client = new OpenAICompatibleImageClient();
  const [task, result] = await recordedImageTask({
    userId: user.id,
    taskType: "ai_image_describe",
    payload: { model_config_id: modelConfig.id, image_url: payload.image_url, instruction: payload.instruction },
    action: async () =>
      client.describeImage({ modelConfig, apiKey, imageUrl: payload.image_url, instruction: payload.instruction }),
  });
  const text = String(result);
  const taskPayload = (task.payload as Record<string, unknown> | null) ?? {};
  await prisma.task.update({
    where: { id: task.id },
    data: { payload: { ...taskPayload, result_length: text.length } },
  });
  return NextResponse.json({ text });
});
