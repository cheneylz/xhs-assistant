import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { paginated } from "@/lib/server/core/paginate";
import { handle, readJson } from "@/lib/server/core/route";
import { decryptText, encryptText } from "@/lib/server/core/security";
import { NextResponse } from "next/server";
import { z } from "zod";

const DEFAULT_TEXT_MODEL_NAME = "gpt-5.4";

const ModelConfigCreateSchema = z.object({
  name: z.string().min(1).max(128),
  model_type: z.enum(["text", "image"]),
  provider: z.string().min(1).max(64),
  model_name: z.string().max(128).default(""),
  base_url: z.string().default(""),
  api_key: z.string().default(""),
  is_default: z.boolean().default(false),
});

const ModelConfigUpdateSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  provider: z.string().min(1).max(64).optional(),
  model_name: z.string().max(128).optional(),
  base_url: z.string().optional(),
  api_key: z.string().optional(),
  is_default: z.boolean().optional(),
});

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

function defaultModelName(modelType: string): string {
  return modelType === "text" ? DEFAULT_TEXT_MODEL_NAME : "";
}

function normalizeModelName(modelType: string, modelName?: string | null): string {
  if (modelName === "gpt5.4") return DEFAULT_TEXT_MODEL_NAME;
  const cleaned = (modelName ?? "").trim();
  return cleaned || defaultModelName(modelType);
}

async function getOwnedConfig(userId: number, configId: number) {
  const config = await prisma.modelConfig.findUnique({ where: { id: configId } });
  if (!config || config.userId !== userId) {
    throw notFound("Model config not found");
  }
  return config;
}

async function clearDefaultForType(userId: number, modelType: string): Promise<void> {
  const configs = await prisma.modelConfig.findMany({ where: { userId, modelType } });
  for (const config of configs) {
    if (config.isDefault) {
      await prisma.modelConfig.update({ where: { id: config.id }, data: { isDefault: false } });
    }
  }
}

/** GET /api/model-configs 列表 */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const modelType = searchParams.get("model_type") ?? undefined;
  if (modelType !== undefined && !["text", "image"].includes(modelType)) {
    throw new ApiError(422, "model_type must be text or image");
  }
  const page = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(searchParams.get("page_size") ?? "20", 10);
  const configs = await prisma.modelConfig.findMany({
    where: { userId: user.id, ...(modelType ? { modelType } : {}) },
    orderBy: { id: "desc" },
  });
  return NextResponse.json(paginated(configs.map(serializeConfig), page, pageSize));
});

/** POST /api/model-configs 创建 */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, ModelConfigCreateSchema);
  if (payload.is_default) {
    await clearDefaultForType(user.id, payload.model_type);
  }
  const config = await prisma.modelConfig.create({
    data: {
      userId: user.id,
      name: payload.name,
      modelType: payload.model_type,
      provider: payload.provider,
      modelName: normalizeModelName(payload.model_type, payload.model_name),
      baseUrl: payload.base_url,
      encryptedApiKey: payload.api_key ? encryptText(payload.api_key) : "",
      isDefault: payload.is_default,
    },
  });
  return NextResponse.json(serializeConfig(config), { status: 201 });
});
