/**
 * 账号健康诊断单元测试（纯函数）
 * 覆盖：健康分计算、等级划分、诊断因素
 */
import { describe, expect, it } from "vitest";
import { computeAccountHealth, HEALTH_LEVEL_LABEL } from "./account-health-service";

describe("computeAccountHealth（健康分计算）", () => {
  it("Cookie 有效 + 稳定发布 + 高互动 → 健康（100 分）", () => {
    const result = computeAccountHealth({
      hasCookie: true,
      cookieValid: true,
      published7d: 5,
      published30d: 15,
      avgEngagement: 800,
    });
    expect(result.score).toBe(100);
    expect(result.level).toBe("healthy");
    expect(result.factors.some((factor) => factor.includes("Cookie 有效"))).toBe(true);
  });

  it("无 Cookie → 至少扣 40 分", () => {
    const result = computeAccountHealth({
      hasCookie: false,
      cookieValid: false,
      published7d: 3,
      published30d: 10,
      avgEngagement: 200,
    });
    expect(result.score).toBeLessThanOrEqual(60);
    expect(result.factors.some((factor) => factor.includes("未绑定 Cookie"))).toBe(true);
  });

  it("Cookie 失效 → 部分得分", () => {
    const result = computeAccountHealth({
      hasCookie: true,
      cookieValid: false,
      published7d: 0,
      published30d: 0,
      avgEngagement: 0,
    });
    expect(result.score).toBe(15); // Cookie 失效给 15
    expect(result.level).toBe("risk");
    expect(result.factors.some((factor) => factor.includes("Cookie 已失效"))).toBe(true);
  });

  it("发布频率低 → 稳定性扣分", () => {
    const healthy = computeAccountHealth({
      hasCookie: true, cookieValid: true, published7d: 1, published30d: 2, avgEngagement: 300,
    });
    expect(healthy.score).toBe(70); // 40 + 10 + 20
    expect(healthy.level).toBe("normal");
    expect(healthy.factors.some((factor) => factor.includes("发布频率偏低"))).toBe(true);
  });

  it("互动极低 → 互动维度无分（稳定性仍得分）", () => {
    const result = computeAccountHealth({
      hasCookie: true, cookieValid: true, published7d: 2, published30d: 10, avgEngagement: 5,
    });
    expect(result.score).toBe(70); // 40（Cookie）+ 30（稳定发布）+ 0（互动极低）
    expect(result.level).toBe("normal");
    expect(result.factors.some((factor) => factor.includes("互动极低"))).toBe(true);
  });

  it("等级标签映射完整", () => {
    expect(HEALTH_LEVEL_LABEL.healthy).toBe("健康");
    expect(HEALTH_LEVEL_LABEL.risk).toBe("风险");
  });
});
