import { describe, expect, it } from "vitest";
import { SSE_ACTIVE_INTERVAL_MS, SSE_IDLE_INTERVAL_MS, nextPollInterval } from "./polling";

describe("nextPollInterval（SSE 轮询降速）", () => {
  it("有未结束的 Run 时快查", () => {
    expect(nextPollInterval(true)).toBe(SSE_ACTIVE_INTERVAL_MS);
  });

  it("全部 Run 已结束时降速（页面挂着不能空转）", () => {
    expect(nextPollInterval(false)).toBe(SSE_IDLE_INTERVAL_MS);
  });

  it("两个间隔必须相差 10 倍以上，否则降速没有意义", () => {
    expect(SSE_IDLE_INTERVAL_MS).toBeGreaterThanOrEqual(SSE_ACTIVE_INTERVAL_MS * 10);
  });
});
