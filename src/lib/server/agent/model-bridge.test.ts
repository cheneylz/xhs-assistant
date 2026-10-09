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
