/**
 * 工具卡摘要单元测试
 *
 * 摘要必须由服务端算好写进 agent_tool_calls.summary（D21）：
 * skill-catalog.ts import 了 prisma 与多个 service，前端不能 import 它。
 */
import { describe, expect, it, vi } from "vitest";
import { findSkillDefinition } from "./skill-catalog";
import { buildToolCallSummary } from "./tool-summary";

describe("buildToolCallSummary（工具卡摘要）", () => {
  it("按目录里的 summarize 生成摘要", () => {
    expect(buildToolCallSummary({ toolName: "hot_refresh", details: { collected: 87 }, isError: false })).toBe(
      "收录 87 条热点",
    );
    expect(buildToolCallSummary({ toolName: "topic_generate", details: { suggestion_ids: [1, 2, 3] }, isError: false })).toBe(
      "生成 3 个选题",
    );
    expect(
      buildToolCallSummary({
        toolName: "content_note_pack",
        details: { draft_id: 128, titles: ["露营装备清单"] },
        isError: false,
      }),
    ).toBe("已保存草稿 #128：《露营装备清单》");
    expect(buildToolCallSummary({ toolName: "review_submit", details: { review_id: 7, gate_status: "warning" }, isError: false })).toBe(
      "审校工单 #7，门禁 warning",
    );
    expect(buildToolCallSummary({ toolName: "script_generate", details: { script: "开场钩子…" }, isError: false })).toBe(
      "生成脚本 5 字",
    );
    expect(buildToolCallSummary({ toolName: "schedule_recommend", details: { slots: [{}, {}] }, isError: false })).toBe(
      "推荐 2 个发布时段",
    );
  });

  it("被护栏阻断时用 guard 给的 reason（该路径没有 details）", () => {
    const reason = "工具「not_exist」未在技能目录中注册，不可调用。请只使用已提供的工具。";
    expect(buildToolCallSummary({ toolName: "not_exist", details: {}, isError: false, blockedReason: reason })).toBe(reason);
  });

  it("guard 给了空串 reason 时用兜底文案（对外文案不能是空的）", () => {
    expect(buildToolCallSummary({ toolName: "not_exist", details: {}, isError: false, blockedReason: "" })).toBe("被护栏阻断");
  });

  it("执行失败时给固定说明，不把原始错误当摘要", () => {
    expect(buildToolCallSummary({ toolName: "hot_refresh", details: {}, isError: true })).toBe("执行失败（展开可见错误详情）");
  });

  it("未登记的工具返回空串而不是抛错（fail-soft：摘要不能拖垮循环）", () => {
    expect(buildToolCallSummary({ toolName: "not_exist", details: {}, isError: false })).toBe("");
  });

  it("summarize 自身抛错时返回空串", () => {
    const definition = findSkillDefinition("hot_refresh");
    if (!definition) throw new Error("测试前提失败：hot_refresh 不在目录里");
    const original = definition.summarize;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    definition.summarize = () => {
      throw new Error("boom");
    };
    try {
      expect(buildToolCallSummary({ toolName: "hot_refresh", details: {}, isError: false })).toBe("");
    } finally {
      definition.summarize = original;
      spy.mockRestore();
    }
  });
});
