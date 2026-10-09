/**
 * 模型能力探测：从 provider 的 `/models` 读取真实的上下文窗口与最大输出。
 *
 * 为什么需要它（实测依据，2026-10-09）：`model-bridge` 原先把这两个值硬编码为
 * 128_000 / 8_192。而 provider 的真实值可能大得多 —— 实测 `deepseek-flash` 的
 * `context_window` 为 1_048_576，硬编码让我们白白浪费 8 倍容量（长任务被过早裁剪）；
 * 也可能小得多 —— 若配置了 32K 窗口的模型，守卫 `charBudget/2 >= contextWindow`
 * 会放行约 100k token 的请求，被 provider 以 400 拒绝。
 *
 * 【本文件不含 Pi 依赖】—— 只用结构化最小接口，可离线单测。
 */

/** 模型能力（provider 报告的真实上限） */
export interface ModelCapabilities {
  contextWindow: number;
  /** 模型允许的最大输出 token（注意：不是我们要请求的输出上限，见 model-bridge） */
  maxOutputTokens: number;
}

/**
 * 最小 fetch 形状。
 * 与 pi-ai 自身一样把 fetch 作为可注入依赖（`buildBaseOptions` 也有 `fetch` 选项），
 * 因此这不是「为测试而开的钩子」，而是与上游一致的扩展点。
 */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface FetchModelCapabilitiesOptions {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** 缓存 TTL：避免 /models 进入每次 Run 的关键路径 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** 探测超时：宁可回退默认值，也不让探测拖慢 Run */
const DEFAULT_TIMEOUT_MS = 5_000;

/** 成功结果的缓存。失败**不**缓存 —— provider 恢复后应立刻能拿到真实值 */
const cache = new Map<string, { at: number; value: ModelCapabilities }>();

/** 清空缓存（供测试与配置变更时调用） */
export function clearModelCapabilitiesCache(): void {
  cache.clear();
}

/** 从 data 数组里取出目标模型的两项能力，任一不合法即返回 null */
function readCapabilities(payload: unknown, modelName: string): ModelCapabilities | null {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;

  const entry = (data as Array<Record<string, unknown>>).find((item) => item?.id === modelName);
  if (!entry) return null;

  const contextWindow = Number(entry.context_window);
  const maxOutputTokens = Number(entry.max_output_tokens);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) return null;

  return { contextWindow, maxOutputTokens };
}

/**
 * 探测指定模型的能力；任何失败（网络、非 200、结构不符、字段缺失）都返回 null，
 * 由调用方回退到保守默认值。**本函数不会抛异常** —— 探测失败不该拖垮一次 Run。
 */
export async function fetchModelCapabilities(options: FetchModelCapabilitiesOptions): Promise<ModelCapabilities | null> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const key = `${baseUrl}::${options.modelName}`;

  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const value = readCapabilities(await response.json(), options.modelName);
    if (value) cache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    // 网络异常 / 超时 / JSON 解析失败：一律回退默认值
    return null;
  } finally {
    clearTimeout(timer);
  }
}
