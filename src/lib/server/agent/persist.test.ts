/**
 * 事件落库单元测试
 * 覆盖：事件序列化、工件事件抽取、工具调用记录
 */
import { describe, expect, it } from "vitest";
import { extractArtifacts, extractMessageText, serializeEventForDb } from "./persist";

describe("serializeEventForDb（事件序列化）", () => {
  it("保留事件类型与关键载荷", () => {
    const serialized = serializeEventForDb({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "topic_generate",
      result: { suggestion_ids: [1, 2] },
      isError: false,
      durationMs: 1200,
    });
    expect(serialized.type).toBe("tool_execution_end");
    const payload = serialized.payload as Record<string, unknown>;
    expect(payload.toolName).toBe("topic_generate");
    expect(payload.durationMs).toBe(1200);
  });

  it("剔除 message_update 中的完整消息体（体积过大且增量重复）", () => {
    const serialized = serializeEventForDb({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "A".repeat(5000) }] },
    });
    const payload = serialized.payload as Record<string, unknown>;
    expect(JSON.stringify(payload).length).toBeLessThan(2000);
  });

  it("message_end 保留助手正文与 usage（D23：过程文本必须落库）", () => {
    const serialized = serializeEventForDb({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "我先查一下当前热点，" },
          { type: "toolCall", id: "call-1", name: "hot_refresh", arguments: {} },
          { type: "text", text: "再生成选题。" },
        ],
        usage: { input: 100, output: 20, totalTokens: 120 },
      },
    });
    const payload = serialized.payload as Record<string, unknown>;
    expect(payload.role).toBe("assistant");
    // 只拼 text 块：toolCall 块的 arguments 不能混进正文
    expect(payload.text).toBe("我先查一下当前热点，再生成选题。");
    // usage 是 token 基线的唯一来源，P0 验收脚本会断言它在
    expect(payload.usage).toEqual({ input: 100, output: 20, totalTokens: 120 });
  });

  it("message_end 的 user / toolResult 消息不留正文（避免与 agent_messages 重复渲染）", () => {
    const userEnd = serializeEventForDb({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "帮我出选题" }] },
    });
    expect(userEnd.payload as Record<string, unknown>).toEqual({ role: "user" });

    // Pi 的工具结果消息角色是 "toolResult"（不是 "tool"，角色集合见 pi-ai 的 types.d.ts）
    const toolEnd = serializeEventForDb({
      type: "message_end",
      message: { role: "toolResult", content: [{ type: "text", text: "ok" }] },
    });
    expect(toolEnd.payload as Record<string, unknown>).toEqual({ role: "toolResult" });
  });

  it("message_end 内容为空时仍落一条（前端靠它判断该步结束）", () => {
    const serialized = serializeEventForDb({ type: "message_end", message: { role: "assistant", content: [] } });
    expect(serialized.payload as Record<string, unknown>).toEqual({ role: "assistant" });
  });

  it("extractMessageText 对畸形输入安全返回（模型返回的 payload 不可信）", () => {
    expect(extractMessageText(undefined)).toBe("");
    expect(extractMessageText("不是数组")).toBe("");
    expect(extractMessageText([null, "字符串", { type: "text", text: 123 }, { type: "text" }])).toBe("");
    expect(extractMessageText([{ type: "text", text: "ok" }, { type: "thinking", text: "思考中" }])).toBe("ok");
  });

  it("message_end 缺失 message 字段时按助手角色兜底（不抛错）", () => {
    const serialized = serializeEventForDb({ type: "message_end" });
    expect(serialized.payload as Record<string, unknown>).toEqual({ role: "assistant" });
  });
});

describe("extractArtifacts（工件抽取）", () => {
  it("topic_generate 的产出被识别为 topic 工件", () => {
    const artifacts = extractArtifacts("topic_generate", {
      suggestion_ids: [11, 12],
      titles: ["露营选题A", "露营选题B"],
    });
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]).toMatchObject({ kind: "topic", id: 11, title: "露营选题A" });
  });

  it("content_note_pack 的产出被识别为 draft 工件并带跳转链接", () => {
    const artifacts = extractArtifacts("content_note_pack", {
      draft_id: 128,
      titles: ["标题A"],
    });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      kind: "draft",
      id: 128,
      href: "/platforms/xhs/drafts?id=128",
    });
  });

  it("review_submit 的产出被识别为 review 工件", () => {
    const artifacts = extractArtifacts("review_submit", { review_id: 7, gate_status: "pass" });
    expect(artifacts[0]).toMatchObject({ kind: "review", id: 7 });
  });

  it("无产出的工具返回空数组", () => {
    expect(extractArtifacts("hot_refresh", { collected: 30 })).toEqual([]);
  });

  it("script_generate 无 artifact 声明，返回空数组（返回纯文本无 id 可映射）", () => {
    expect(extractArtifacts("script_generate", { script: "开场钩子…" })).toEqual([]);
  });

  it("未知工具返回空数组", () => {
    expect(extractArtifacts("not_exist", {})).toEqual([]);
  });

  it("content_rewrite 的字符串 titleField 被用作工件标题（D-C2：单产出也能带标题）", () => {
    const artifacts = extractArtifacts("content_rewrite", { draft_id: 12, title: "露营装备清单", length: 356 });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      kind: "draft",
      id: 12,
      title: "露营装备清单",
      href: "/platforms/xhs/drafts?id=12",
    });
  });

  it("字符串 titleField 为空串时回退「技能名 #id」（不产出空标题）", () => {
    const artifacts = extractArtifacts("content_rewrite", { draft_id: 12, title: "", length: 10 });
    expect(artifacts[0]?.title).toBe("去 AI 味改写 #12");
  });
});
