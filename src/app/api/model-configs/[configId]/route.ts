import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { encryptText } from "@/lib/server/core/security";
import { NextResponse } from "next/server";
import { z } from "zod";

const ModelConfigUpdateSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  provider: z.string().min(1).max(64).optional(),
  model_name: z.string().max(128).optional(),
  base_url: z.string().optional(),
  api_key: z.string().optional(),
  is_default: z.boolean().optional(),
});

const DEFAULT_TEXT_MODEL_NAME = "gpt-5.4";

function normalizeModelName(modelType: string, modelName?: string | null): string {
  if (modelName === "gpt5.4") return DEFAULT_TEXT_MODEL_NAME;
  const cleaned = (modelName ?? "").trim();
  return cleaned || (modelType === "text" ? DEFAULT_TEXT_MODEL_NAME : "");
}

function serializeConfig(config: {
  id: number;
  name: string;
  modelType: string;
  provider: string;
  modelName: string;
  baseUrl: string;
  encryptedApiKey: string;
  isDefault: boolean;
}) {
  return {
    id: config.id,
    name: config.name,
    model_type: config.modelType,
    provider: config.provider,
    model_name: config.modelName,
    base_url: config.baseUrl,
    has_api_key: Boolean(config.encryptedApiKey),
    is_default: config.isDefault,
  };
}

async function getOwnedConfig(userId: number, configId: number) {
  const config = await prisma.modelConfig.findUnique({ where: { id: configId } });
  if (!config || config.userId !== userId) throw notFound("Model config not found");
  return config;
}

async function clearDefaultForType(userId: number, modelType: string): Promise<void> {
  const configs = await prisma.modelConfig.findMany({ where: { userId, modelType, isDefault: true } });
  for (const config of configs) {
    await prisma.modelConfig.update({ where: { id: config.id }, data: { isDefault: false } });
  }
}

/** PATCH /api/model-configs/{configId} 更新 */
export const PATCH = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const configId = Number.parseInt(params.configId, 10);
  const config = await getOwnedConfig(user.id, configId);
  const payload = await readJson(req, ModelConfigUpdateSchema);

  const data: Record<string, unknown> = {};
  if (payload.name !== undefined) data.name = payload.name;
  if (payload.provider !== undefined) data.provider = payload.provider;
  if (payload.model_name !== undefined) data.modelName = normalizeModelName(config.modelType, payload.model_name);
  if (payload.base_url !== undefined) data.baseUrl = payload.base_url;
  if (payload.api_key !== undefined) data.encryptedApiKey = payload.api_key ? encryptText(payload.api_key) : "";
  if (payload.is_default !== undefined) {
    if (payload.is_default) await clearDefaultForType(user.id, config.modelType);
    data.isDefault = payload.is_default;
  }
  const updated = await prisma.modelConfig.update({ where: { id: config.id }, data });
  return NextResponse.json(serializeConfig(updated));
});

/** DELETE /api/model-configs/{configId} 删除 */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const configId = Number.parseInt(params.configId, 10);
  await getOwnedConfig(user.id, configId);
  await prisma.modelConfig.delete({ where: { id: configId } });
  return NextResponse.json({ id: configId, status: "deleted" });
});
