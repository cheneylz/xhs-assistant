/**
 * 热点洞察单元测试（纯函数）
 * 覆盖：关键词分类、热度分公式
 */
import { describe, expect, it } from "vitest";
import { classifyKeyword, computeHeatScore, itemEngagement } from "./hot-topic-service";

describe("classifyKeyword（关键词分类）", () => {
  it("命中分类特征词", () => {
    expect(classifyKeyword("秋冬穿搭")).toBe("穿搭");
    expect(classifyKeyword("口红试色")).toBe("美妆");
    expect(classifyKeyword("周末探店")).toBe("美食");
    expect(classifyKeyword("露营攻略")).toBe("旅行");
  });

  it("未命中返回「其他」", () => {
    expect(classifyKeyword("数码测评")).toBe("其他");
  });

  it("空串返回「其他」", () => {
    expect(classifyKeyword("")).toBe("其他");
  });
});

describe("computeHeatScore（热度分公式）", () => {
  it("按 搜索量×0.3 + 笔记增量×0.3 + 互动增量×0.4 计算并取整", () => {
    // 1000×0.3 + 200×0.3 + 500×0.4 = 300 + 60 + 200 = 560
    expect(computeHeatScore(1000, 200, 500)).toBe(560);
  });

  it("全零得 0", () => {
    expect(computeHeatScore(0, 0, 0)).toBe(0);
  });

  it("小数取整", () => {
    // 1×0.3 + 1×0.3 + 1×0.4 = 1.0
    expect(computeHeatScore(1, 1, 1)).toBe(1);
  });
});

describe("itemEngagement（搜索项互动量）", () => {
  it("赞藏评求和", () => {
    expect(itemEngagement({ likes: 100, collects: 50, comments: 10 })).toBe(160);
  });

  it("缺失字段按 0 处理", () => {
    expect(itemEngagement({ likes: 100 })).toBe(100);
    expect(itemEngagement({})).toBe(0);
  });

  it("字符串数字兼容", () => {
    expect(itemEngagement({ likes: "100", collects: "50", comments: 0 })).toBe(150);
  });
});
