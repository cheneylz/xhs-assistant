/**
 * 审校引擎单元测试（纯函数，不依赖数据库）
 * 覆盖：规则匹配、双层检测、原创性相似度、状态计算、JSON 解析、梯度修复文本应用
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULES,
  applyFixText,
  checkRulesText,
  computeReviewStatus,
  dedupeFindings,
  extractJsonPayload,
  jaccardSimilarity,
  keywordBigrams,
  matchRule,
  normalizeLlmFindings,
  riskSuggestion,
} from "./review-service";

// ---------- 规则匹配 ----------

describe("matchRule（规则匹配）", () => {
  it("关键词规则按 | 分隔逐个命中", () => {
    const rule = { ruleType: "absolute_claim", pattern: "最显瘦|最好用|唯一", isRegex: false, riskLevel: "warning" };
    expect(matchRule(rule, "这款最显瘦")).toEqual(["最显瘦"]);
    expect(matchRule(rule, "真的很显瘦")).toEqual([]); // 非精确关键词不命中
  });

  it("正则规则走 RegExp", () => {
    const rule = { ruleType: "sensitive_word", pattern: "^违规|违禁品", isRegex: true, riskLevel: "error" };
    expect(matchRule(rule, "违规内容")).toEqual(["^违规|违禁品"]);
    expect(matchRule(rule, "正常内容")).toEqual([]);
  });

  it("非法正则不抛异常", () => {
    const rule = { ruleType: "sensitive_word", pattern: "([", isRegex: true, riskLevel: "error" };
    expect(matchRule(rule, "任意文本")).toEqual([]);
  });

  it("空文本不匹配", () => {
    expect(matchRule(DEFAULT_RULES[0], "")).toEqual([]);
  });
});

describe("checkRulesText（规则层检测）", () => {
  it("命中绝对化用语与功效宣称", () => {
    const findings = checkRulesText(DEFAULT_RULES, "最好用的防晒", "这款产品能彻底治愈晒斑，100%有效");
    const riskTypes = findings.map((f) => f.riskType);
    expect(riskTypes).toContain("absolute_claim");
    expect(riskTypes).toContain("medical_claim");
    const medical = findings.find((f) => f.riskType === "medical_claim");
    expect(medical?.riskLevel).toBe("error");
  });

  it("禁用规则不参与匹配", () => {
    const rules = [{ ruleType: "absolute_claim", pattern: "最显瘦", isRegex: false, riskLevel: "warning", enabled: false }];
    expect(checkRulesText(rules, "最显瘦的穿搭", "")).toEqual([]);
  });

  it("riskSuggestion 按类型给出修复建议", () => {
    expect(riskSuggestion("absolute_claim", "最显瘦")).toContain("收窄断言");
    expect(riskSuggestion("medical_claim", "治愈")).toContain("个人体验");
    expect(riskSuggestion("unknown_type", "x")).toContain("人工复核");
  });
});

// ---------- 原创性检查 ----------

describe("keywordBigrams / jaccardSimilarity（相似度）", () => {
  it("中文按双字切分", () => {
    const bigrams = keywordBigrams("秋冬穿搭");
    expect(bigrams.has("秋冬")).toBe(true);
    expect(bigrams.has("冬穿")).toBe(true);
    expect(bigrams.has("穿搭")).toBe(true);
  });

  it("完全相同的文本相似度为 1", () => {
    const a = keywordBigrams("秋冬通勤穿搭的 3 个显瘦技巧");
    expect(jaccardSimilarity(a, keywordBigrams("秋冬通勤穿搭的 3 个显瘦技巧"))).toBe(1);
  });

  it("完全不同文本相似度为 0", () => {
    expect(jaccardSimilarity(keywordBigrams("苹果"), keywordBigrams("汽车保养"))).toBe(0);
  });

  it("相似文本处于软阈值区间（0.3~0.5）", () => {
    const base = keywordBigrams("秋冬通勤穿搭显瘦技巧大公开");
    const similar = keywordBigrams("秋冬穿搭显瘦技巧合集");
    const score = jaccardSimilarity(base, similar);
    expect(score).toBeGreaterThanOrEqual(0.3);
    expect(score).toBeLessThan(0.5);
  });

  it("空集合相似度为 0", () => {
    expect(jaccardSimilarity(new Set(), keywordBigrams("任意内容"))).toBe(0);
  });
});

// ---------- 状态计算 ----------

describe("computeReviewStatus（审校状态与门禁状态）", () => {
  it("存在 error 级风险 → rejected/blocked", () => {
    const { status, gateStatus } = computeReviewStatus([{ gate: "compliance", riskType: "medical_claim", riskLevel: "error", snippet: "治愈", suggestion: "" }]);
    expect(status).toBe("rejected");
    expect(gateStatus).toBe("blocked");
  });

  it("仅 warning 级风险 → warning/warning", () => {
    const { status, gateStatus } = computeReviewStatus([{ gate: "compliance", riskType: "absolute_claim", riskLevel: "warning", snippet: "最显瘦", suggestion: "" }]);
    expect(status).toBe("warning");
    expect(gateStatus).toBe("warning");
  });

  it("无风险 → passed/passed", () => {
    const { status, gateStatus } = computeReviewStatus([]);
    expect(status).toBe("passed");
    expect(gateStatus).toBe("passed");
  });
});

describe("dedupeFindings（风险点去重）", () => {
  it("同 gate+riskType+snippet 只保留一条", () => {
    const findings = [
      { gate: "compliance", riskType: "absolute_claim", riskLevel: "warning", snippet: "最显瘦", suggestion: "a" },
      { gate: "compliance", riskType: "absolute_claim", riskLevel: "warning", snippet: "最显瘦", suggestion: "b" },
      { gate: "claim", riskType: "fake_data", riskLevel: "warning", snippet: "数据", suggestion: "c" },
    ];
    expect(dedupeFindings(findings)).toHaveLength(2);
  });
});

// ---------- LLM 输出解析 ----------

describe("extractJsonPayload / normalizeLlmFindings（LLM 结构化输出）", () => {
  it("解析纯 JSON", () => {
    const payload = extractJsonPayload('{"findings":[{"gate":"compliance","riskType":"inducement","riskLevel":"warning","snippet":"点赞","suggestion":"删除"}]}');
    expect(payload?.findings).toHaveLength(1);
  });

  it("解析 markdown 代码块包裹的 JSON", () => {
    const payload = extractJsonPayload("```json\n{\"findings\":[]}\n```");
    expect(payload?.findings).toEqual([]);
  });

  it("容忍前后缀噪声", () => {
    const payload = extractJsonPayload("好的，审校结果如下：{\"findings\":[]} 以上是全部风险。");
    expect(payload).not.toBeNull();
  });

  it("非 JSON 返回 null", () => {
    expect(extractJsonPayload("这不是 JSON")).toBeNull();
  });

  it("normalizeLlmFindings 归一化 gate 与 riskLevel", () => {
    const findings = normalizeLlmFindings({
      findings: [
        { gate: "claim", riskType: "fake_data", riskLevel: "error", snippet: "数据显示", suggestion: "补来源" },
        { gate: "compliance", riskType: "other", riskLevel: "info", snippet: "x", suggestion: "y" },
      ],
    });
    expect(findings[0].gate).toBe("claim");
    expect(findings[0].riskLevel).toBe("error");
    expect(findings[1].riskLevel).toBe("warning"); // 未知等级降级为 warning
  });

  it("缺少 snippet 与 suggestion 的条目被过滤", () => {
    expect(normalizeLlmFindings({ findings: [{ gate: "claim" }] })).toEqual([]);
  });
});

// ---------- 梯度修复文本应用 ----------

describe("applyFixText（修复文本应用）", () => {
  it("命中正文片段时精确替换", () => {
    const result = applyFixText("标题", "这件衣服最显瘦，很好穿", "最显瘦", "很显瘦");
    expect(result.body).toBe("这件衣服很显瘦，很好穿");
    expect(result.title).toBe("标题");
  });

  it("命中标题片段时替换标题", () => {
    const result = applyFixText("最显瘦的穿搭", "正文内容", "最显瘦", "很显瘦");
    expect(result.title).toBe("很显瘦的穿搭");
  });

  it("片段未精确命中时按首 4 字定位所在行", () => {
    const result = applyFixText("标题", "第一行内容\n这款产品100%有效是真的\n第三行", "产品100%有效", "产品比较有效");
    expect(result.body).toContain("产品比较有效");
    expect(result.body).not.toContain("100%有效");
  });

  it("完全未命中时原样返回", () => {
    const result = applyFixText("标题", "没有任何相关内容", "完全不存在的片段", "替换");
    expect(result).toEqual({ title: "标题", body: "没有任何相关内容" });
  });
});
