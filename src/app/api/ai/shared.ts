/**
 * AI 路由共享工具（对应原版 backend/app/api/ai.py 的模型上下文、资产序列化与任务记录逻辑）
 */
import type { Prisma, Task } from "@prisma/client";
import { prisma } from "@/lib/server/core/db";
import { ApiError } from "@/lib/server/core/http-error";
import { decryptText } from "@/lib/server/core/security";
import { formatDateTime, shanghaiNow } from "@/lib/server/core/time";
import type { ModelConfigLike } from "@/lib/server/services/ai-service";

/** 任务 payload 类型（对应 prisma Json 字段，写入时需转型为 InputJsonValue） */
export type TaskPayload = Record<string, unknown>;

/** 草稿序列化输入（prisma AiDraft 模型的子集） */
export interface DraftLike {
  id: number;
  platform: string;
  title: string;
  body: string;
  sourceNoteId: number | null;
  createdAt: Date;
}

/** 序列化 AI 草稿（snake_case，对应原版 _serialize_draft） */
export function serializeDraft(draft: DraftLike): Record<string, unknown> {
  return {
    id: draft.id,
    platform: draft.platform,
    title: draft.title,
    body: draft.body,
    source_note_id: draft.sourceNoteId,
    created_at: formatDateTime(draft.createdAt),
  };
}

/** 获取用户默认文本模型配置（对应 _get_default_text_model，未配置时 400） */
export async function getDefaultTextModel(userId: number): Promise<ModelConfigLike> {
  const config = await prisma.modelConfig.findFirst({ where: { userId, modelType: "text", isDefault: true } });
  if (!config) {
    throw new ApiError(400, "Default text model is not configured");
  }
  return config;
}

/** 获取用户默认图片模型配置（对应 _get_default_image_model，未配置时 400） */
export async function getDefaultImageModel(userId: number): Promise<ModelConfigLike> {
  const config = await prisma.modelConfig.findFirst({ where: { userId, modelType: "image", isDefault: true } });
  if (!config) {
    throw new ApiError(400, "Default image model is not configured");
  }
  return config;
}

/** 文本模型上下文（模型配置 + 解密后的 API Key，对应原版 _text_model_context） */
export async function textModelContext(userId: number): Promise<{ modelConfig: ModelConfigLike; apiKey: string }> {
  const modelConfig = await getDefaultTextModel(userId);
  const apiKey = modelConfig.encryptedApiKey ? decryptText(modelConfig.encryptedApiKey) : "";
  return { modelConfig, apiKey };
}

/** 图片模型上下文（对应原版 _image_model_context） */
export async function imageModelContext(userId: number): Promise<{ modelConfig: ModelConfigLike; apiKey: string }> {
  const modelConfig = await getDefaultImageModel(userId);
  const apiKey = modelConfig.encryptedApiKey ? decryptText(modelConfig.encryptedApiKey) : "";
  return { modelConfig, apiKey };
}

/** 生成资产序列化输入（prisma AiGeneratedAsset 模型的子集） */
export interface GeneratedAssetLike {
  id: number;
  draftId: number | null;
  prompt: string;
  modelName: string;
  params: unknown;
  filePath: string;
  createdAt: Date;
}

/** 序列化生成资产（snake_case，对应原版 _serialize_generated_asset） */
export function serializeGeneratedAsset(asset: GeneratedAssetLike): Record<string, unknown> {
  return {
    id: asset.id,
    draft_id: asset.draftId,
    prompt: asset.prompt,
    model_name: asset.modelName,
    params: (asset.params as Record<string, unknown> | null) ?? {},
    file_path: asset.filePath,
    created_at: formatDateTime(asset.createdAt),
  };
}

/**
 * 判断是否为 HTTP 层失败（原版中请求异常为非 ValueError，映射 502；
 * 校验类错误为 ValueError，映射 400）。TS 端 ai-service 的 postJson 失败会附带 response 字段
 */
function isHttpLevelError(error: unknown): boolean {
  return typeof (error as { response?: unknown } | null)?.response !== "undefined";
}

interface BaseRecordedTaskOptions {
  userId: number;
  taskType: string;
  payload: TaskPayload;
  action: () => Promise<unknown>;
}

/** 文本任务额外需要 platform 参数（对应原版 _recorded_text_task） */
export interface TextRecordedTaskOptions extends BaseRecordedTaskOptions {
  platform: string;
}

/** 图片任务固定 platform 为 "xhs"（对应原版 _recorded_image_task） */
export type ImageRecordedTaskOptions = BaseRecordedTaskOptions;

interface RecordedTaskOptions extends BaseRecordedTaskOptions {
  platform: string;
  /** 502 时的错误前缀（原版 "AI text generation failed" / "AI image generation failed"） */
  failurePrefix: string;
}

/**
 * 创建并记录 AI 任务（对应原版 _recorded_text_task / _recorded_image_task 的公共逻辑）
 * 成功：任务标记 completed；失败：任务标记 failed 并写入 error，且按原版规则抛错
 */
async function recordedTask(options: RecordedTaskOptions): Promise<[Task, unknown]> {
  const { userId, platform, taskType, payload, action, failurePrefix } = options;
  const task = await prisma.task.create({
    data: {
      userId,
      platform,
      taskType,
      status: "running",
      progress: 10,
      payload: payload as Prisma.InputJsonValue,
      createdAt: shanghaiNow(),
    },
  });
  try {
    const result = await action();
    const completed = await prisma.task.update({
      where: { id: task.id },
      data: { status: "completed", progress: 100 },
    });
    return [completed, result];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        progress: 100,
        payload: { ...payload, error: message } as Prisma.InputJsonValue,
      },
    });
    if (error instanceof ApiError) throw error;
    if (isHttpLevelError(error)) throw new ApiError(502, `${failurePrefix}: ${message}`);
    // 其余视为校验类失败（原版 ValueError -> 400）
    throw new ApiError(400, message);
  }
}

/** 记录 AI 文本任务（对应原版 _recorded_text_task） */
export function recordedTextTask(options: TextRecordedTaskOptions): Promise<[Task, unknown]> {
  return recordedTask({ ...options, failurePrefix: "AI text generation failed" });
}

/** 记录 AI 图片任务（对应原版 _recorded_image_task，platform 固定 "xhs"） */
export function recordedImageTask(options: ImageRecordedTaskOptions): Promise<[Task, unknown]> {
  return recordedTask({ ...options, platform: "xhs", failurePrefix: "AI image generation failed" });
}
