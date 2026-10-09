/**
 * 模型桥接单元测试
 * 覆盖：ModelConfigLike → pi-ai Model 字段映射
 */
import { describe, expect, it } from "vitest";
// 必须显式带 .mts 后缀：Pi 包 ESM-only，tsx/Node ESM 不做扩展名推断。
// tsconfig 已开启 allowImportingTsExtensions 并纳入 **/*.mts，无需忽略静态检查。
import { buildPiModel } from "./model-bridge.mts";

const cfg = {
  id: 1,
  userId: 7,
  name: "DeepSeek 文本模型",
  modelType: "text",
  provider: "deepseek",
  modelName: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
  encryptedApiKey: "encrypted",
  isDefault: true,
};

describe("buildPiModel（ModelConfig → pi-ai Model）", () => {
  it("id 与 name 正确映射", () => {
    const model = buildPiModel(cfg);
    expect(model.id).toBe("deepseek-chat");
    expect(model.name).toBe("DeepSeek 文本模型");
  });

  it("api 固定为 openai-completions", () => {
    expect(buildPiModel(cfg).api).toBe("openai-completions");
  });

  it("baseUrl 与 provider 透传", () => {
    const model = buildPiModel(cfg);
    expect(model.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(model.provider).toBe("deepseek");
  });

  it("baseUrl 尾部斜杠被清理（避免拼出 //chat/completions）", () => {
    const model = buildPiModel({ ...cfg, baseUrl: "https://api.deepseek.com/v1///" });
    expect(model.baseUrl).toBe("https://api.deepseek.com/v1");
  });

  it("必填字段齐全：input / reasoning / contextWindow / maxTokens / cost 四字段", () => {
    const model = buildPiModel(cfg);
    expect(model.input).toEqual(["text"]);
    expect(typeof model.reasoning).toBe("boolean");
    expect(model.contextWindow).toBeGreaterThan(0);
    expect(model.maxTokens).toBeGreaterThan(0);
    // ModelCost 要求 4 个字段，缺一个 tsc 就报错
    expect(typeof model.cost.input).toBe("number");
    expect(typeof model.cost.output).toBe("number");
    expect(typeof model.cost.cacheRead).toBe("number");
    expect(typeof model.cost.cacheWrite).toBe("number");
  });

  it("baseUrl 为空时抛错（避免把请求发到错误地址）", () => {
    expect(() => buildPiModel({ ...cfg, baseUrl: "" })).toThrow(/base_url/);
  });

  it("modelName 为空时抛错", () => {
    expect(() => buildPiModel({ ...cfg, modelName: "" })).toThrow(/model_name/);
  });

  it("provider 为空时回退为 openai-compatible（项目默认值）", () => {
    const model = buildPiModel({ ...cfg, provider: "" });
    expect(model.provider).toBe("openai-compatible");
  });
});

describe("buildPiModel + 真实模型能力（capabilities）", () => {
  it("未传 capabilities 时用保守默认值（行为与之前完全一致）", () => {
    const model = buildPiModel(cfg);
    expect(model.contextWindow).toBe(128_000);
    expect(model.maxTokens).toBe(8_192);
  });

  it("传入 capabilities 时 contextWindow 用 provider 报告的真实值", () => {
    // 实测 deepseek-flash 的真实窗口是 1048576；原先硬编码 128000 会白白浪费 8 倍容量
    const model = buildPiModel(cfg, { contextWindow: 1_048_576, maxOutputTokens: 393_216 });
    expect(model.contextWindow).toBe(1_048_576);
  });

  it("模型输出上限更大时，仍保持项目的策略上限（不放大到模型上限）", () => {
    // maxTokens 会作为 max_tokens 发给 provider，是「我们想要多少输出」的策略值。
    // 直接跟到模型上限（393216）等于放开成本阀门，必须保持保守。
    const model = buildPiModel(cfg, { contextWindow: 1_048_576, maxOutputTokens: 393_216 });
    expect(model.maxTokens).toBe(8_192);
  });

  it("模型输出上限更小时被钳到模型上限（否则会触发 provider 400）", () => {
    const model = buildPiModel(cfg, { contextWindow: 32_768, maxOutputTokens: 4_096 });
    expect(model.maxTokens).toBe(4_096);
    expect(model.contextWindow).toBe(32_768);
  });

  it("传入 null（探测失败）时回退默认值", () => {
    const model = buildPiModel(cfg, null);
    expect(model.contextWindow).toBe(128_000);
    expect(model.maxTokens).toBe(8_192);
  });
});
