/**
 * 智能排期单元测试（纯函数）
 * 覆盖：时段聚合、高峰时段挑选（数量/间隔/占用约束）
 */
import { describe, expect, it } from "vitest";
import { aggregateHourScores, pickTopHours, parseSlotDate, DEFAULT_HOURS } from "./schedule-service";

describe("aggregateHourScores（按小时聚合平均互动）", () => {
  it("聚合平均并按互动量倒序", () => {
    const scores = aggregateHourScores([
      { hour: 10, engagement: 100 },
      { hour: 10, engagement: 200 },
      { hour: 20, engagement: 50 },
    ]);
    expect(scores).toEqual([
      { hour: 10, avgEngagement: 150, count: 2 },
      { hour: 20, avgEngagement: 50, count: 1 },
    ]);
  });

  it("非法小时（0-23 之外）被过滤", () => {
    const scores = aggregateHourScores([{ hour: 24, engagement: 100 }, { hour: 12, engagement: 100 }]);
    expect(scores).toHaveLength(1);
    expect(scores[0].hour).toBe(12);
  });

  it("空数据返回空数组", () => {
    expect(aggregateHourScores([])).toEqual([]);
  });
});

describe("pickTopHours（高峰时段挑选）", () => {
  const scores = [
    { hour: 20, avgEngagement: 300, count: 5 },
    { hour: 10, avgEngagement: 250, count: 4 },
    { hour: 12, avgEngagement: 200, count: 3 },
    { hour: 18, avgEngagement: 150, count: 2 },
  ];

  it("按互动量取 Top，默认最多 3 个", () => {
    const picked = pickTopHours(scores);
    expect(picked.map((item) => item.hour)).toEqual([20, 10, 12]);
  });

  it("count 上限为 3（单账号每日 ≤3 条）", () => {
    const picked = pickTopHours(scores, { count: 5 });
    expect(picked).toHaveLength(3);
  });

  it("间隔约束：相邻时段 ≥2 小时", () => {
    // 12 与 10 间隔 2h → 通过；期望 20, 10, 12 间隔均 ≥2
    const picked = pickTopHours([{ hour: 11, avgEngagement: 999, count: 1 }, ...scores]);
    const hours = picked.map((item) => item.hour);
    for (let i = 1; i < hours.length; i++) {
      expect(Math.abs(hours[i] - hours[i - 1])).toBeGreaterThanOrEqual(2);
    }
  });

  it("占用时段被跳过", () => {
    const picked = pickTopHours(scores, { occupiedHours: [20] });
    expect(picked.map((item) => item.hour)).toEqual([10, 12, 18]);
  });

  it("空数据时返回空", () => {
    expect(pickTopHours([])).toEqual([]);
  });

  it("默认活跃时段存在且合理", () => {
    expect(DEFAULT_HOURS).toContain(20);
    expect(DEFAULT_HOURS).toContain(10);
  });
});

describe("parseSlotDate（槽位解析，naive 约定）", () => {
  it("UTC 字段即指定墙钟时间", () => {
    const date = parseSlotDate("2026-09-02", 20);
    expect(date.getUTCFullYear()).toBe(2026);
    expect(date.getUTCMonth()).toBe(8); // 9 月
    expect(date.getUTCDate()).toBe(2);
    expect(date.getUTCHours()).toBe(20);
    expect(date.getUTCMinutes()).toBe(0);
  });
});
