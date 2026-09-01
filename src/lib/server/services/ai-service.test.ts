/**
 * AI 服务单元测试（纯函数）
 * 覆盖：文案包解析（JSON / markdown / 文本降级）、去AI味强度指令
 */
import { describe, expect, it } from "vitest";
import { parseNotePack, rewriteIntensityInstruction } from "./ai-service";

// ---------- 文案包解析 ----------

describe("parseNotePack（文案包解析，C-01）", () => {
  it("解析标准 JSON 输出", () => {
    const pack = parseNotePack(
      JSON.stringify({
        titles: ["标题1", "标题2", "标题3"],
        body: "这是正文内容，口语化表达。",
        tags: ["秋冬穿搭", "通勤OOTD"],
        cta: ["关注我获取更多"],
      }),
    );
    expect(pack.titles).toHaveLength(3);
    expect(pack.body).toContain("正文内容");
    expect(pack.tags).toContain("秋冬穿搭");
    expect(pack.cta).toHaveLength(1);
  });

  it("解析 markdown 代码块包裹的 JSON", () => {
    const pack = parseNotePack('```json\n{"titles":["A"],"body":"B","tags":["C"],"cta":[]}\n```');
    expect(pack.titles).toEqual(["A"]);
    expect(pack.body).toBe("B");
    expect(pack.tags).toEqual(["C"]);
  });

  it("标题与标签清洗序号前缀", () => {
    const pack = parseNotePack(
      JSON.stringify({
        titles: ["1. 标题一", "2、标题二", "③ 标题三"],
        body: "正文",
        tags: ["#秋冬穿搭", "通勤OOTD"],
        cta: [],
      }),
    );
    expect(pack.titles[0]).toBe("标题一");
    expect(pack.tags[0]).toBe("秋冬穿搭");
  });

  it("JSON 缺失正文时降级为文本解析", () => {
    const pack = parseNotePack(JSON.stringify({ titles: ["A"] }));
    expect(pack.body).toBe("");
  });

  it("降级解析文本格式（标题：/正文：/标签：/CTA：）", () => {
    const pack = parseNotePack(
      [
        "标题：秋冬通勤的 3 个显瘦技巧",
        "标题：显瘦10斤的穿搭公式",
        "正文：今天分享一个秋冬通勤的穿搭思路。",
        "第二段内容。",
        "标签：#秋冬穿搭，#通勤OOTD",
        "CTA：关注我看更多穿搭",
      ].join("\n"),
    );
    expect(pack.titles).toHaveLength(2);
    expect(pack.body).toContain("第二段内容");
    expect(pack.tags).toEqual(["秋冬穿搭", "通勤OOTD"]);
    expect(pack.cta[0]).toContain("关注我");
  });

  it("完全无结构输出返回空文案包", () => {
    const pack = parseNotePack("一段没有结构的普通文本");
    expect(pack.titles).toEqual([]);
    expect(pack.body).toBe("");
    expect(pack.tags).toEqual([]);
  });
});

// ---------- 去AI味强度 ----------

describe("rewriteIntensityInstruction（去AI味强度，C-02）", () => {
  it("轻度仅微调", () => {
    expect(rewriteIntensityInstruction("light")).toContain("轻度");
  });

  it("中度口语化改写", () => {
    expect(rewriteIntensityInstruction("medium")).toContain("口语化");
    expect(rewriteIntensityInstruction("medium")).toContain("模板化开头");
  });

  it("深度彻底重写", () => {
    const deep = rewriteIntensityInstruction("deep");
    expect(deep).toContain("彻底重写");
    expect(deep).toContain("第一人称");
  });

  it("默认值与中度一致", () => {
    expect(rewriteIntensityInstruction(undefined)).toContain("口语化");
  });
});
