/**
 * 爆款拆解单元测试（纯函数）
 * 覆盖：LLM 拆解输出解析
 */
import { describe, expect, it } from "vitest";
import { parseExplosionPatterns } from "./exploration-service";

describe("parseExplosionPatterns（爆款拆解输出解析）", () => {
  it("解析标准 JSON", () => {
    const patterns = parseExplosionPatterns(
      JSON.stringify({
        title_patterns: ["[痛点]+[解决方案]+[结果]", "[数字]+[场景]"],
        cover_patterns: ["对比图+大字标题"],
        body_patterns: ["痛点引入→干货展开"],
        engage_patterns: ["结尾引导互动"],
      }),
    );
    expect(patterns.titlePatterns).toHaveLength(2);
    expect(patterns.coverPatterns[0]).toContain("对比图");
    expect(patterns.bodyPatterns[0]).toContain("干货");
  });

  it("解析 markdown 包裹的 JSON", () => {
    const patterns = parseExplosionPatterns('```json\n{"title_patterns":["公式A"]}\n```');
    expect(patterns.titlePatterns).toEqual(["公式A"]);
  });

  it("非 JSON 返回空结构", () => {
    const patterns = parseExplosionPatterns("模型没有按格式输出");
    expect(patterns).toEqual({ titlePatterns: [], coverPatterns: [], bodyPatterns: [], engagePatterns: [] });
  });

  it("缺失维度返回空数组", () => {
    const patterns = parseExplosionPatterns('{"title_patterns":["A"]}');
    expect(patterns.coverPatterns).toEqual([]);
    expect(patterns.titlePatterns).toEqual(["A"]);
  });
});
