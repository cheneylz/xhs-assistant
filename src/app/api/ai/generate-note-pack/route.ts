import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { handle, readJson } from "@/lib/server/core/route";
import { shanghaiNow } from "@/lib/server/core/time";
import { OpenAICompatibleTextClient, type NotePack } from "@/lib/server/services/ai-service";
import { buildKbContext } from "@/lib/server/services/knowledge-base-service";
import { NextResponse } from "next/server";
import { z } from "zod";
import { recordedTextTask, textModelContext } from "../shared";
import { makeUsageLogger } from "@/lib/server/services/usage-service";

const GenerateNotePackSchema = z.object({
  platform: z.enum(["xhs", "douyin", "kuaishou", "weibo", "xianyu", "taobao"]).default("xhs"),
  topic: z.string().min(1).max(300),
  direction: z.string().max(200).default(""),
  style: z.enum(["种草型", "干货型", "测评型"]).optional(),
  reference: z.string().max(4000).default(""),
  instruction: z.string().max(1000).default(""),
  platform_account_id: z.number().int().nullable().optional(), // 指定账号知识库
});

/** POST /api/ai/generate-note-pack C-01 文案包：标题 3-5 备选 + 正文 + 标签 + CTA，保存草稿并返回 */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, GenerateNotePackSchema);
  const { modelConfig, apiKey } = await textModelContext(user.id);
  const client = new OpenAICompatibleTextClient();

  // 装配知识库上下文（账号定位/口吻/可信主张/经验结论/Few-shot 风格样本）
  const kbContext = await buildKbContext(user.id, payload.platform_account_id ?? null);

  const [task, result] = await recordedTextTask({
    userId: user.id,
    platform: payload.platform,
    taskType: "ai_generate_note_pack",
    payload: {
      model_config_id: modelConfig.id,
      topic: payload.topic,
      platform_account_id: payload.platform_account_id ?? null,
    },
    action: async () =>
      client.generateNotePack({
        modelConfig,
        apiKey,
        onUsage: makeUsageLogger(user.id, modelConfig.modelName),
        topic: payload.topic,
        kbContext,
        direction: payload.direction,
        style: payload.style,
        reference: payload.reference,
        instruction: payload.instruction,
      }),
  });

  const pack = result as NotePack;
  const draft = await prisma.aiDraft.create({
    data: {
      userId: user.id,
      platform: payload.platform,
      title: pack.titles[0] ?? payload.topic,
      body: pack.body || "",
      tags: pack.tags.length ? pack.tags : undefined,
      createdAt: shanghaiNow(),
    },
  });
  const taskPayload = (task.payload as Record<string, unknown> | null) ?? {};
  await prisma.task.update({
    where: { id: task.id },
    data: {
      payload: {
        ...taskPayload,
        result_draft_id: draft.id,
        title_count: pack.titles.length,
        body_length: pack.body.length,
      },
    },
  });
  return NextResponse.json({
    titles: pack.titles,
    body: pack.body,
    tags: pack.tags,
    cta: pack.cta,
    draft_id: draft.id,
  });
});
