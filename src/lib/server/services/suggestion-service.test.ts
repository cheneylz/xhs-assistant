/**
 * 选题推荐单元测试（纯函数）
 * 覆盖：LLM 选题输出解析与数量上限
 */
import { describe, expect, it } from "vitest";
import { parseSuggestions } from "./suggestion-service";

describe("parseSuggestions（选题输出解析）", () => {
  it("解析标准 JSON 并按 count 截断", () => {
    const items = parseSuggestions(
      JSON.stringify({
        items: [
          { title: "选题一", direction: "职场", predicted_heat: 80, tags: ["#职场穿搭"] },
          { title: "选题二", direction: "通勤", predicted_heat: 60, tags: [] },
          { title: "选题三", direction: "", predicted_heat: 40, tags: ["穿搭"] },
        ],
      }),
      2,
    );
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("选题一");
    expect(items[0].predictedHeat).toBe(80);
    expect(items[0].tags).toEqual(["职场穿搭"]); // # 前缀被清理
  });

  it("predicted_heat 归一化到 0-100", () => {
    const items = parseSuggestions(
      JSON.stringify({ items: [{ title: "A", predicted_heat: 150 }, { title: "B", predicted_heat: -5 }, { title: "C", predicted_heat: "70" }] }),
      3,
    );
    expect(items[0].predictedHeat).toBe(100);
    expect(items[1].predictedHeat).toBe(0);
    expect(items[2].predictedHeat).toBe(70);
  });

  it("空标题条目被过滤", () => {
    const items = parseSuggestions(
      JSON.stringify({ items: [{ title: "" }, { title: "有效选题" }] }),
      5,
    );
    expect(items).toHaveLength(1);
  });

  it("非 JSON 返回空数组", () => {
    expect(parseSuggestions("无法解析的内容", 5)).toEqual([]);
  });
});
