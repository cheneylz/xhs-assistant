/**
 * ModelConfig → pi-ai Model 桥接
 *
 * Pi 的 Model 是普通对象字面量（BaseModel 接口），无需注册 provider。
 * compat 字段不填，pi-ai 会按 baseUrl 自动探测 OpenAI 兼容性。
 *
 * 【本文件含 Pi 依赖】—— 仅 worker 侧使用，Next.js 侧禁止 import。
 */
import type { Model } from "@earendil-works/pi-ai";
import type { ModelConfigLike } from "../services/ai-service";

/** 默认上下文窗口与最大输出（pi-ai 必填字段，先用保守值） */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

/** 项目里 provider 是自由文本，为空时回退到默认值 */
const DEFAULT_PROVIDER = "openai-compatible";

/** 去掉尾部斜杠，避免拼出 //chat/completions 这类双斜杠路径 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * ModelConfigLike → pi-ai Model<"openai-completions">
 *
 * 注意：本项目 provider 字段是自由文本（默认 "openai-compatible"），
 * 不匹配 pi-ai 任何已知 provider ID。因此 compat 探测实际依赖 baseUrl 子串
 * （pi-ai 的 detectCompat 匹配 deepseek.com / open.bigmodel.cn / api.moonshot. 等）；
 * 未匹配的 URL 会回退到**有效的**标准 OpenAI 配置，不会失败。
 * 代价是 provider 特有差异（如 DeepSeek 的 max_tokens vs max_completion_tokens）
 * 不会自动生效。待真实 provider 出现问题时再考虑显式 compat 映射。
 *
 * 类型说明：pi-ai 的 BaseModel.provider 类型为 ProviderId = KnownProvider | string，
 * 接受任意字符串，因此自由文本 provider 无需断言转换。
 */
export function buildPiModel(cfg: ModelConfigLike): Model<"openai-completions"> {
  if (!cfg.baseUrl) throw new Error("Text model base_url is required");
  if (!cfg.modelName) throw new Error("Text model model_name is required");

  return {
    id: cfg.modelName,
    name: cfg.name,
    api: "openai-completions",
    provider: cfg.provider || DEFAULT_PROVIDER,
    baseUrl: normalizeBaseUrl(cfg.baseUrl),
    input: ["text"],
    // ModelCost 要求 4 个字段；本项目按用量另算成本，此处填 0
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}
