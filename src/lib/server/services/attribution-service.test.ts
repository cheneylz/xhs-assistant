/**
 * 数据分析单元测试（纯函数）
 * 覆盖：归因结论解析
 */
import { describe, expect, it } from "vitest";
import { parseAttribution } from "./attribution-service";

describe("parseAttribution（归因结论解析）", () => {
  it("解析标准 JSON 结论", () => {
    const conclusions = parseAttribution(
      JSON.stringify({
        conclusions: [
          { dimension: "标题", finding: "标题带数字的点击率更高", evidence: "高表现组 4/5 含数字" },
          { dimension: "发布时间", finding: "20 点发布互动更好", evidence: "均值 300 vs 150" },
        ],
      }),
    );
    expect(conclusions).toHaveLength(2);
    expect(conclusions[0].dimension).toBe("标题");
    expect(conclusions[0].finding).toContain("数字");
  });

  it("空 finding 条目被过滤", () => {
    const conclusions = parseAttribution(
      JSON.stringify({ conclusions: [{ dimension: "标题", finding: "", evidence: "x" }, { finding: "有效结论" }] }),
    );
    expect(conclusions).toHaveLength(1);
    expect(conclusions[0].dimension).toBe("其他"); // 缺失维度默认「其他」
  });

  it("非 JSON 返回空数组", () => {
    expect(parseAttribution("没有结论")).toEqual([]);
  });
});
