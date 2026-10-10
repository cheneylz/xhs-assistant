import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageBubble } from "./message-bubble";

/** 渲染一个气泡并返回 HTML（vitest 是 node 环境，用 react-dom/server 直出，不需要 jsdom） */
function renderBubble(role: "user" | "assistant", text: string): string {
  return renderToStaticMarkup(createElement(MessageBubble, { role, text, created_at: "2026-10-10T10:00:00" }));
}

describe("MessageBubble 的 markdown 渲染", () => {
  it("助手文本按 markdown 渲染，并包在 .agent-markdown 容器里", () => {
    const html = renderBubble("assistant", "**加粗** 与 `代码`\n\n- 一\n- 二");
    expect(html).toContain('class="agent-markdown"');
    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain("<code>代码</code>");
    expect(html).toContain("<li>一</li>");
  });

  it("用户消息保持纯文本（`#`/`*` 不被解析）", () => {
    const html = renderBubble("user", "**不是加粗** 与 # 标题");
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("agent-markdown");
    expect(html).toContain("**不是加粗** 与 # 标题");
  });

  it("内联 HTML 被转义（XSS 回归守卫：不要给 react-markdown 加 rehype-raw）", () => {
    const html = renderBubble("assistant", '<script>alert(1)</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
