/**
 * 模型能力探测单元测试
 * 覆盖：正常解析、字段缺失、非 200、网络异常、URL/鉴权、缓存
 *
 * 为什么需要这个模块（实测依据）：
 *   model-bridge 原先把 contextWindow 硬编码为 128_000。而 provider 的真实值可能
 *   大得多（实测 deepseek-flash 为 1_048_576，浪费 8 倍容量），也可能小得多
 *   （若配置了 32K 窗口的模型，守卫会放行 ~100k token 的请求 → provider 400）。
 *   因此从 /models 读取真实值，读不到再回退默认值。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearModelCapabilitiesCache, fetchModelCapabilities } from "./model-capabilities";

/** 造一个返回指定 JSON 的假 fetch */
function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as never;
}

/** 收集调用参数的假 fetch */
function recordingFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }) as never;
  return { calls, impl };
}

const DEEPSEEK_LIKE = {
  object: "list",
  data: [
    { id: "other-model", object: "model", context_window: 32_768, max_output_tokens: 4_096 },
    {
      id: "deepseek-flash",
      object: "model",
      name: "DeepSeek-V4.1-Flash",
      context_window: 1_048_576,
      max_output_tokens: 393_216,
    },
  ],
};

afterEach(() => {
  clearModelCapabilitiesCache();
});

describe("fetchModelCapabilities（从 /models 读模型真实上限）", () => {
  it("命中模型时返回真实的 contextWindow 与 maxOutputTokens", async () => {
    const result = await fetchModelCapabilities({
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-test",
      modelName: "deepseek-flash",
      fetchImpl: fakeFetch(200, DEEPSEEK_LIKE),
    });
    expect(result).toEqual({ contextWindow: 1_048_576, maxOutputTokens: 393_216 });
  });

  it("请求 /models 端点并带上 Bearer 鉴权", async () => {
    const { calls, impl } = recordingFetch(200, DEEPSEEK_LIKE);
    await fetchModelCapabilities({
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-test",
      modelName: "deepseek-flash",
      fetchImpl: impl,
    });
    expect(calls[0].url).toBe("https://api.deepseek.com/models");
    expect(calls[0].headers.Authorization).toBe("Bearer sk-test");
  });

  it("baseUrl 尾部斜杠被清理，不拼出 //models", async () => {
    const { calls, impl } = recordingFetch(200, DEEPSEEK_LIKE);
    await fetchModelCapabilities({
      baseUrl: "https://api.deepseek.com/v1///",
      apiKey: "sk-test",
      modelName: "deepseek-flash",
      fetchImpl: impl,
    });
    expect(calls[0].url).toBe("https://api.deepseek.com/v1/models");
  });

  it("模型不在列表里时返回 null（回退默认值，不猜）", async () => {
    const result = await fetchModelCapabilities({
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-test",
      modelName: "not-listed",
      fetchImpl: fakeFetch(200, DEEPSEEK_LIKE),
    });
    expect(result).toBeNull();
  });

  it("provider 不返回 capability 字段时返回 null（非标准扩展，多数 provider 没有）", async () => {
    const result = await fetchModelCapabilities({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      modelName: "gpt-4o-mini",
      fetchImpl: fakeFetch(200, { object: "list", data: [{ id: "gpt-4o-mini", object: "model" }] }),
    });
    expect(result).toBeNull();
  });

  it("字段非正数或非数字时返回 null（避免把 0 当成合法窗口）", async () => {
    const bad = {
      object: "list",
      data: [{ id: "m", context_window: 0, max_output_tokens: "很多" }],
    };
    const result = await fetchModelCapabilities({
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-test",
      modelName: "m",
      fetchImpl: fakeFetch(200, bad),
    });
    expect(result).toBeNull();
  });

  it("非 200 返回 null，不抛异常（探测失败不能拖垮 Run）", async () => {
    const result = await fetchModelCapabilities({
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-bad",
      modelName: "deepseek-flash",
      fetchImpl: fakeFetch(401, { error: { message: "invalid key" } }),
    });
    expect(result).toBeNull();
  });

  it("网络异常返回 null，不抛异常", async () => {
    const throwing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as never;
    const result = await fetchModelCapabilities({
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "sk-test",
      modelName: "m",
      fetchImpl: throwing,
    });
    expect(result).toBeNull();
  });

  it("响应体不是预期结构时返回 null", async () => {
    const result = await fetchModelCapabilities({
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-test",
      modelName: "m",
      fetchImpl: fakeFetch(200, { unexpected: true }),
    });
    expect(result).toBeNull();
  });

  it("同一 baseUrl+model 在 TTL 内只请求一次（不让 /models 进入每次 Run 的关键路径）", async () => {
    const { calls, impl } = recordingFetch(200, DEEPSEEK_LIKE);
    const options = {
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-test",
      modelName: "deepseek-flash",
      fetchImpl: impl,
    };
    await fetchModelCapabilities(options);
    await fetchModelCapabilities(options);
    await fetchModelCapabilities(options);
    expect(calls).toHaveLength(1);
  });

  it("探测失败不写入缓存（provider 恢复后立刻能拿到真实值）", async () => {
    let attempt = 0;
    const flaky = (async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("ECONNREFUSED");
      return { ok: true, status: 200, json: async () => DEEPSEEK_LIKE };
    }) as never;
    const options = {
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-test",
      modelName: "deepseek-flash",
      fetchImpl: flaky,
    };
    expect(await fetchModelCapabilities(options)).toBeNull();
    // 第一次失败后立即重试：应当真的再打一次网络，而不是吃缓存的 null
    expect(await fetchModelCapabilities(options)).toEqual({ contextWindow: 1_048_576, maxOutputTokens: 393_216 });
  });
});
