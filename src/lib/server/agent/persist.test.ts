/**
 * 事件落库单元测试
 * 覆盖：事件序列化、工件事件抽取、工具调用记录
 */
import { describe, expect, it } from "vitest";
import { extractArtifacts, serializeEventForDb } from "./persist";

describe("serializeEventForDb（事件序列化）", () => {
  it("保留事件类型与关键载荷", () => {
    const serialized = serializeEventForDb({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "topic.generate",
      result: { suggestion_ids: [1, 2] },
      isError: false,
      durationMs: 1200,
    });
    expect(serialized.type).toBe("tool_execution_end");
    const payload = serialized.payload as Record<string, unknown>;
    expect(payload.toolName).toBe("topic.generate");
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

  it("message_end 保留 usage（token 基线的唯一来源），大字段仍剔除", () => {
    const serialized = serializeEventForDb({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "A".repeat(5000) }],
        usage: { input: 100, output: 20, totalTokens: 120 },
      },
    });
    const payload = serialized.payload as Record<string, unknown>;
    expect(payload.trimmed).toBe(true);
    expect(payload.usage).toEqual({ input: 100, output: 20, totalTokens: 120 });
    expect(JSON.stringify(payload).length).toBeLessThan(2000);
  });
});

describe("extractArtifacts（工件抽取）", () => {
  it("topic.generate 的产出被识别为 topic 工件", () => {
    const artifacts = extractArtifacts("topic.generate", {
      suggestion_ids: [11, 12],
      titles: ["露营选题A", "露营选题B"],
    });
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]).toMatchObject({ kind: "topic", id: 11, title: "露营选题A" });
  });

  it("content.notePack 的产出被识别为 draft 工件并带跳转链接", () => {
    const artifacts = extractArtifacts("content.notePack", {
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

  it("review.submit 的产出被识别为 review 工件", () => {
    const artifacts = extractArtifacts("review.submit", { review_id: 7, gate_status: "pass" });
    expect(artifacts[0]).toMatchObject({ kind: "review", id: 7 });
  });

  it("无产出的工具返回空数组", () => {
    expect(extractArtifacts("hot.refresh", { collected: 30 })).toEqual([]);
  });

  it("script.generate 无 artifact 声明，返回空数组（返回纯文本无 id 可映射）", () => {
    expect(extractArtifacts("script.generate", { script: "开场钩子…" })).toEqual([]);
  });

  it("未知工具返回空数组", () => {
    expect(extractArtifacts("not.exist", {})).toEqual([]);
  });
});
