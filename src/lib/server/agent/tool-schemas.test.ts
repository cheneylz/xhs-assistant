/**
 * 工具 schema 单元测试
 * 覆盖：映射完整性、TypeBox 校验行为
 */
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { SKILL_CATALOG } from "./skill-catalog";
import { TOOL_SCHEMAS, assertSchemasComplete, getToolSchema } from "./tool-schemas";

describe("TOOL_SCHEMAS（工具入参 schema）", () => {
  it("每个 SKILL_CATALOG 技能都有对应的 TypeBox schema", () => {
    for (const item of SKILL_CATALOG) {
      expect(TOOL_SCHEMAS[item.skillKey], `缺少 ${item.skillKey} 的 schema`).toBeDefined();
    }
  });

  it("没有多余的 schema（避免拼写错误的孤儿项）", () => {
    const catalogKeys = new Set(SKILL_CATALOG.map((item) => item.skillKey));
    for (const key of Object.keys(TOOL_SCHEMAS)) {
      expect(catalogKeys.has(key), `TOOL_SCHEMAS 中的 ${key} 不在 SKILL_CATALOG 里`).toBe(true);
    }
  });

  it("assertSchemasComplete 在完整时不抛错", () => {
    expect(() => assertSchemasComplete()).not.toThrow();
  });

  it("hot.refresh 接受空对象", () => {
    expect(Value.Check(getToolSchema("hot.refresh"), {})).toBe(true);
  });

  it("topic.generate 的 count 超出范围被拒绝", () => {
    const schema = getToolSchema("topic.generate");
    expect(Value.Check(schema, {})).toBe(true);              // count 可选
    expect(Value.Check(schema, { count: 5 })).toBe(true);
    expect(Value.Check(schema, { count: 999 })).toBe(false); // 超上限
    expect(Value.Check(schema, { count: 0 })).toBe(false);   // 超下限
  });

  it("content.notePack 缺少 topic 被拒绝", () => {
    const schema = getToolSchema("content.notePack");
    expect(Value.Check(schema, {})).toBe(false);
    expect(Value.Check(schema, { topic: "露营装备" })).toBe(true);
    expect(Value.Check(schema, { topic: 123 })).toBe(false);
  });

  it("review.submit 的 draft_id 必须为正整数", () => {
    const schema = getToolSchema("review.submit");
    expect(Value.Check(schema, { draft_id: 12 })).toBe(true);
    expect(Value.Check(schema, { draft_id: -1 })).toBe(false);
    expect(Value.Check(schema, {})).toBe(false);
  });

  it("getToolSchema 对未知 skillKey 抛错", () => {
    expect(() => getToolSchema("not.exist")).toThrow();
  });
});
