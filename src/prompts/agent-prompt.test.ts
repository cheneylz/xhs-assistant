/**
 * Agent 系统提示词守卫
 *
 * 只钉两件与验收相关的事：
 *   1. content_rewrite 的改稿护栏（设计稿 §八 风险 5：改写前说明将修改哪篇草稿）
 *   2. {{toolCatalog}} 占位符仍在（由 agent-loop 的 buildToolCatalogText 注入工具目录）
 */
import { describe, expect, it } from "vitest";
import { renderPrompt } from "./loader";

describe("agent.md（Agent 系统提示词）", () => {
  it("包含 content_rewrite 的「改写前先说明改哪篇」护栏", () => {
    const prompt = renderPrompt("agent.md", "system");
    expect(prompt).toContain("content_rewrite");
    expect(prompt).toContain("无法撤销");
    expect(prompt).toContain("先说明");
  });

  it("保留 {{toolCatalog}} 占位符（渲染器对未提供变量原样保留）", () => {
    expect(renderPrompt("agent.md", "system")).toContain("{{toolCatalog}}");
  });
});
