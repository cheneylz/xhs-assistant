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
import type { ModelCapabilities } from "./model-capabilities.ts";

/**
 * 默认上下文窗口与最大输出：仅在探测不到真实值时使用的保守回退。
 *
 * 探测来源见 model-capabilities.ts（provider 的 /models）。实测 deepseek-flash 的
 * 真实窗口是 1_048_576 —— 硬编码 128_000 会白白浪费 8 倍容量；反过来，若用户配了
 * 32K 窗口的模型，硬编码 128_000 会让守卫放行约 100k token 的请求而被 provider 400。
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * 我方**策略**输出上限（不是模型能力上限）。
 *
 * 该值会作为 `max_tokens` 发给 provider，决定「我们想要多少输出」。模型自报的
 * max_output_tokens 可能远大于此（实测 deepseek-flash 为 393_216），跟随它等于
 * 放开成本阀门，因此这里只**向下钳制**、绝不放大。
 */
export const DEFAULT_MAX_TOKENS = 8_192;

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
 *
 * capabilities：来自 model-capabilities.ts 的探测结果；为 null/undefined（探测失败、
 * provider 未提供该扩展字段）时回退保守默认值。**注意两者语义不同**：
 *   - contextWindow 是**事实**（模型真实窗口），用于 pi-ai 本地钳制与循环的预算守卫，
 *     不发给 provider；唯一的要求是别高估（高估会导致请求超窗 → 400）。
 *   - maxTokens 是**我方策略**（想要多少输出），会作为 max_tokens 发出，只向下钳制。
 */
export function buildPiModel(
  cfg: ModelConfigLike,
  capabilities?: ModelCapabilities | null,
): Model<"openai-completions"> {
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
    contextWindow: capabilities?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: capabilities ? Math.min(DEFAULT_MAX_TOKENS, capabilities.maxOutputTokens) : DEFAULT_MAX_TOKENS,
  };
}
