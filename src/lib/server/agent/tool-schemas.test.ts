/**
 * 工具 schema 单元测试
 * 覆盖：映射完整性、TypeBox 校验行为
 */
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { SKILL_CATALOG } from "./skill-catalog";
import { TOOL_SCHEMAS, assertSchemasComplete, assertToolNamesProviderSafe, getToolSchema } from "./tool-schemas";

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

  it("hot_refresh 接受空对象", () => {
    expect(Value.Check(getToolSchema("hot_refresh"), {})).toBe(true);
  });

  it("topic_generate 的 count 超出范围被拒绝", () => {
    const schema = getToolSchema("topic_generate");
    expect(Value.Check(schema, {})).toBe(true);              // count 可选
    expect(Value.Check(schema, { count: 5 })).toBe(true);
    expect(Value.Check(schema, { count: 999 })).toBe(false); // 超上限
    expect(Value.Check(schema, { count: 0 })).toBe(false);   // 超下限
  });

  it("content_note_pack 缺少 topic 被拒绝", () => {
    const schema = getToolSchema("content_note_pack");
    expect(Value.Check(schema, {})).toBe(false);
    expect(Value.Check(schema, { topic: "露营装备" })).toBe(true);
    expect(Value.Check(schema, { topic: 123 })).toBe(false);
  });

  it("review_submit 的 draft_id 必须为正整数", () => {
    const schema = getToolSchema("review_submit");
    expect(Value.Check(schema, { draft_id: 12 })).toBe(true);
    expect(Value.Check(schema, { draft_id: -1 })).toBe(false);
    expect(Value.Check(schema, {})).toBe(false);
  });

  it("getToolSchema 对未知 skillKey 抛错", () => {
    expect(() => getToolSchema("not_exist")).toThrow();
  });

  it("content_rewrite 的 intensity 只接受三个枚举值，draft_id 必填", () => {
    const schema = getToolSchema("content_rewrite");
    expect(Value.Check(schema, { draft_id: 12 })).toBe(true);
    expect(Value.Check(schema, { draft_id: 12, intensity: "deep" })).toBe(true);
    expect(Value.Check(schema, { draft_id: 12, intensity: "extreme" })).toBe(false);
    expect(Value.Check(schema, {})).toBe(false);
    expect(Value.Check(schema, { draft_id: 0 })).toBe(false);
  });

  it("content_titles / content_tags 的 count 有上下限（与路由侧默认值一致）", () => {
    expect(Value.Check(getToolSchema("content_titles"), { title: "T", count: 10 })).toBe(true);
    expect(Value.Check(getToolSchema("content_titles"), { title: "T", count: 11 })).toBe(false);
    expect(Value.Check(getToolSchema("content_titles"), { count: 5 })).toBe(false); // title 必填
    expect(Value.Check(getToolSchema("content_tags"), { title: "T", count: 20 })).toBe(true);
    expect(Value.Check(getToolSchema("content_tags"), { title: "T", count: 21 })).toBe(false);
  });

  it("kb_get 接受空对象，library_note_detail 的 note_id 必填", () => {
    expect(Value.Check(getToolSchema("kb_get"), {})).toBe(true);
    expect(Value.Check(getToolSchema("library_note_detail"), {})).toBe(false);
    expect(Value.Check(getToolSchema("library_note_detail"), { note_id: 3 })).toBe(true);
  });

  it("library_search_notes 全部参数可选（无参检索 = 取最近笔记）", () => {
    const schema = getToolSchema("library_search_notes");
    expect(Value.Check(schema, {})).toBe(true);
    expect(Value.Check(schema, { keyword: "露营", limit: 20 })).toBe(true);
    expect(Value.Check(schema, { limit: 21 })).toBe(false);
    expect(Value.Check(schema, { limit: 0 })).toBe(false);
  });
});

describe("assertToolNamesProviderSafe（工具名合法性）", () => {
  it("目录里全部 skillKey 都通过校验（否则会被模型接口 400 拒绝）", () => {
    expect(() => assertToolNamesProviderSafe()).not.toThrow();
  });

  it("带点号的工具名被拒绝 —— 实测 provider 会返回 400 invalid_request_error", () => {
    // 这条守住的是真出现过的缺陷：skillKey 原为 topic.generate 时，
    // 端到端验收里模型请求被 provider 400 拒绝，且表现为「模型请求失败」，极难定位
    expect(() => assertToolNamesProviderSafe(["topic.generate"])).toThrow(/不符合供应商要求/);
  });

  it("空格 / 中文 / 空串等非法字符同样被拒绝", () => {
    expect(() => assertToolNamesProviderSafe(["topic generate"])).toThrow();
    expect(() => assertToolNamesProviderSafe(["选题生成"])).toThrow();
    expect(() => assertToolNamesProviderSafe([""])).toThrow();
  });

  it("合法字符集（字母/数字/下划线/连字符）通过", () => {
    expect(() => assertToolNamesProviderSafe(["topic_generate", "hot-refresh", "tool1", "A_b-9"])).not.toThrow();
  });
});
