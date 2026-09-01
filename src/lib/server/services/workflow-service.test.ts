/**
 * 工作流编排单元测试（纯函数）
 * 覆盖：步骤参数占位符解析（{stepId.字段} 引用）
 */
import { describe, expect, it } from "vitest";
import { resolveStepParams } from "./workflow-service";

describe("resolveStepParams（步骤参数占位符解析）", () => {
  const outputs = new Map([
    ["s1", { titles: ["选题一", "选题二"], count: 2 }],
    ["s2", { draft_id: 42 }],
  ]);

  it("解析 {s1.titles.0} 数组路径", () => {
    const params = resolveStepParams({ topic: "{s1.titles.0}" }, outputs);
    expect(params.topic).toBe("选题一");
  });

  it("解析 {s2.draft_id} 普通字段", () => {
    const params = resolveStepParams({ draft_id: "{s2.draft_id}" }, outputs);
    expect(params.draft_id).toBe("42");
  });

  it("未找到步骤时保留原占位符", () => {
    const params = resolveStepParams({ topic: "{s9.title}" }, outputs);
    expect(params.topic).toBe("{s9.title}");
  });

  it("非字符串参数原样传递", () => {
    const params = resolveStepParams({ count: 5, flag: true }, outputs);
    expect(params.count).toBe(5);
    expect(params.flag).toBe(true);
  });
});
