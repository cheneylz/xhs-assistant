/**
 * 评论自动响应单元测试（纯函数）
 * 覆盖：意图分类解析、规则意图匹配、模板渲染、评论提取
 */
import { describe, expect, it } from "vitest";
import { extractKeywords, extractRemoteComments, matchRuleIntent, parseIntent, renderTemplate } from "./comment-reply-service";

describe("parseIntent（LLM 意图分类解析）", () => {
  it("解析 JSON 意图", () => {
    expect(parseIntent('{"intent":"question","summary":"询问价格"}')).toBe("question");
    expect(parseIntent('{"intent":"praise"}')).toBe("praise");
  });

  it("解析纯文本意图（降级）", () => {
    expect(parseIntent("complaint")).toBe("complaint");
  });

  it("未知意图降级为 other", () => {
    expect(parseIntent("随便说说")).toBe("other");
    expect(parseIntent("")).toBe("other");
  });
});

describe("matchRuleIntent（无 LLM 规则匹配）", () => {
  it("问题类关键词命中", () => {
    expect(matchRuleIntent("这个多少钱？")).toBe("question");
    expect(matchRuleIntent("在哪里买的")).toBe("question");
  });

  it("差评关键词命中", () => {
    expect(matchRuleIntent("质量太差了")).toBe("complaint");
  });

  it("广告关键词优先命中", () => {
    expect(matchRuleIntent("加微信了解详情")).toBe("ad");
  });

  it("好评命中", () => {
    expect(matchRuleIntent("太好看了")).toBe("praise");
  });

  it("未命中返回 other", () => {
    expect(matchRuleIntent("今天天气不错")).toBe("other");
  });
});

describe("renderTemplate（模板渲染）", () => {
  it("替换 {question} 占位符", () => {
    expect(renderTemplate("可以看看我的笔记：{question}", "请问这个多少钱")).toContain("请问这个多少钱");
  });

  it("空模板返回空串", () => {
    expect(renderTemplate("", "评论内容")).toBe("");
  });
});

describe("extractKeywords（关键词提取）", () => {
  it("提取 2-8 字中文词组（贪婪匹配）", () => {
    const keywords = extractKeywords("防晒霜");
    expect(keywords).toEqual(["防晒霜"]);
    expect(keywords.length).toBeLessThanOrEqual(10);
  });
});

describe("extractRemoteComments（评论接口数据提取）", () => {
  it("提取 data.comments 列表", () => {
    const comments = extractRemoteComments({
      data: {
        comments: [
          { id: "c1", content: "第一条评论" },
          { id: "c2", content: "第二条评论", like_count: 5 },
        ],
      },
    });
    expect(comments).toHaveLength(2);
    expect(comments[0].commentId).toBe("c1");
  });

  it("兼容 id/comment_id 与 content/text 字段", () => {
    const comments = extractRemoteComments({ data: { comments: [{ comment_id: "x1", text: "文本" }] } });
    expect(comments[0]).toEqual({ commentId: "x1", content: "文本" });
  });

  it("空数据返回空数组", () => {
    expect(extractRemoteComments(null)).toEqual([]);
    expect(extractRemoteComments({ data: {} })).toEqual([]);
  });
});
