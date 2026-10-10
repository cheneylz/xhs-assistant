/**
 * 技能目录单元测试
 * 覆盖：目录完整性、元数据字段、riskLevel 合法性
 */
import { describe, expect, it } from "vitest";
import { SKILL_CATALOG, SKILL_RISK_LEVELS, findSkillDefinition, summarizeCount } from "./skill-catalog";

describe("SKILL_CATALOG（技能目录）", () => {
  it("包含全部 13 个预置技能", () => {
    const keys = SKILL_CATALOG.map((item) => item.skillKey).sort();
    expect(keys).toEqual([
      "analytics_reports",
      "content_note_pack",
      "content_rewrite",
      "content_tags",
      "content_titles",
      "hot_refresh",
      "kb_get",
      "library_note_detail",
      "library_search_notes",
      "review_submit",
      "schedule_recommend",
      "script_generate",
      "topic_generate",
    ]);
  });

  it("每个技能都有合法的 riskLevel", () => {
    for (const item of SKILL_CATALOG) {
      expect(SKILL_RISK_LEVELS, `技能 ${item.skillKey} 的 riskLevel`).toContain(item.riskLevel);
    }
  });

  it("每个技能都有非空 name / description / instructions / paramsSchema", () => {
    for (const item of SKILL_CATALOG) {
      expect(item.name.length, `${item.skillKey}.name`).toBeGreaterThan(0);
      expect(item.description.length, `${item.skillKey}.description`).toBeGreaterThan(0);
      expect(item.instructions.length, `${item.skillKey}.instructions`).toBeGreaterThan(0);
      expect(typeof item.paramsSchema, `${item.skillKey}.paramsSchema`).toBe("object");
    }
  });

  it("skillKey 全局唯一", () => {
    const keys = SKILL_CATALOG.map((item) => item.skillKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("findSkillDefinition 能按 skillKey 查到，未知 key 返回 undefined", () => {
    expect(findSkillDefinition("topic_generate")?.name).toBe("选题生成");
    expect(findSkillDefinition("not_exist")).toBeUndefined();
  });

  it("13 个技能全部为 read 或 write，不含 publish（首期不开放发布）", () => {
    for (const item of SKILL_CATALOG) {
      expect(item.riskLevel, `技能 ${item.skillKey} 不应为 publish`).not.toBe("publish");
    }
  });

  it("热点采集与文案类工具为 write，脚本与排期为 read（按函数体是否写库核定）", () => {
    const byKey = new Map(SKILL_CATALOG.map((item) => [item.skillKey, item]));
    expect(byKey.get("hot_refresh")?.riskLevel).toBe("write");
    expect(byKey.get("topic_generate")?.riskLevel).toBe("write");
    expect(byKey.get("content_note_pack")?.riskLevel).toBe("write");
    expect(byKey.get("review_submit")?.riskLevel).toBe("write");
    expect(byKey.get("script_generate")?.riskLevel).toBe("read");
    expect(byKey.get("schedule_recommend")?.riskLevel).toBe("read");
    // C 块 7 个新工具（risk 读函数体核过，不凭名字推断）
    expect(byKey.get("content_rewrite")?.riskLevel).toBe("write"); // aiDraft.update({ body }) 真的改草稿
    expect(byKey.get("content_titles")?.riskLevel).toBe("read"); // generateTitles 纯返回 string[]
    expect(byKey.get("content_tags")?.riskLevel).toBe("read"); // generateTags 纯返回 string[]
    expect(byKey.get("analytics_reports")?.riskLevel).toBe("read"); // listExplosionReports 只 findMany
    expect(byKey.get("kb_get")?.riskLevel).toBe("read"); // buildKbContext 只读知识库
    expect(byKey.get("library_search_notes")?.riskLevel).toBe("read"); // note-service 只 findMany
    expect(byKey.get("library_note_detail")?.riskLevel).toBe("read"); // 同上
  });

  it("声明 artifact 的技能，其 idField 必须真能在产出里找到（防字段名写错）", () => {
    // 抽取的协议字段名与 executeSkill 的 return 语句一一对应
    const expectedIdFields: Record<string, string> = {
      "topic_generate": "suggestion_ids",
      "content_note_pack": "draft_id",
      "review_submit": "review_id",
      "content_rewrite": "draft_id",
    };
    for (const [skillKey, idField] of Object.entries(expectedIdFields)) {
      const spec = findSkillDefinition(skillKey)?.artifact;
      expect(spec, `${skillKey} 应声明 artifact`).toBeDefined();
      expect(spec?.idField, `${skillKey}.artifact.idField`).toBe(idField);
    }
  });

  it("无产出的技能不声明 artifact，且 script_generate 因返回纯文本而无 id 可映射", () => {
    expect(findSkillDefinition("hot_refresh")?.artifact).toBeUndefined();
    expect(findSkillDefinition("schedule_recommend")?.artifact).toBeUndefined();
    expect(findSkillDefinition("script_generate")?.artifact).toBeUndefined();
  });

  it("C 块 6 个只读工具不声明 artifact（产出只在对话里，不落库、不跳转）", () => {
    for (const skillKey of [
      "content_titles",
      "content_tags",
      "analytics_reports",
      "kb_get",
      "library_search_notes",
      "library_note_detail",
    ]) {
      expect(findSkillDefinition(skillKey)?.artifact, `${skillKey} 不应声明 artifact`).toBeUndefined();
    }
  });

  it("每个技能都有 summarize，且对正常产出返回非空摘要", () => {
    for (const item of SKILL_CATALOG) {
      expect(typeof item.summarize, `${item.skillKey}.summarize`).toBe("function");
    }
    const samples: Record<string, Record<string, unknown>> = {
      hot_refresh: { collected: 3 },
      topic_generate: { suggestion_ids: [1] },
      content_note_pack: { draft_id: 1, titles: ["t"] },
      review_submit: { review_id: 1, gate_status: "passed" },
      script_generate: { script: "脚本" },
      schedule_recommend: { slots: [{}] },
      content_rewrite: { draft_id: 12, title: "露营装备清单", length: 356 },
      content_titles: { titles: ["标题A"] },
      content_tags: { tags: ["露营"] },
      analytics_reports: { reports: [{}] },
      kb_get: { context: "账号定位", length: 4 },
      library_search_notes: { total: 2, items: [] },
      library_note_detail: { note_id: 5, note_title: "露营装备清单", comment_total: 3 },
    };
    for (const item of SKILL_CATALOG) {
      const summary = item.summarize(samples[item.skillKey] ?? {});
      expect(summary.length, `${item.skillKey} 的摘要不能为空`).toBeGreaterThan(0);
    }
  });

  it("summarizeCount 的强制转换表（C 块 7 个新工具都要复用它）", () => {
    expect(summarizeCount([1, 2, 3])).toBe(3);
    expect(summarizeCount(7)).toBe(7);
    expect(summarizeCount("12")).toBe(12);
    expect(summarizeCount(undefined)).toBe(0);
    expect(summarizeCount(null)).toBe(0);
    expect(summarizeCount("")).toBe(0);
    expect(summarizeCount("abc")).toBe(0);
    expect(summarizeCount({})).toBe(0);
    // Number(true) === 1：布尔不是「条数」，但工具不会返回布尔，这里只把现有行为钉住
    expect(summarizeCount(true)).toBe(1);
  });

  it("hot_refresh 的摘要：有产出给条数，0 条时带出原因", () => {
    const hotRefresh = SKILL_CATALOG.find((definition) => definition.skillKey === "hot_refresh");
    if (!hotRefresh) throw new Error("hot_refresh 不在目录里");
    expect(hotRefresh.summarize({ collected: 12 })).toBe("收录 12 条热点");
    expect(hotRefresh.summarize({ collected: 0 })).toBe("收录 0 条热点");
    expect(hotRefresh.summarize({ collected: 0, reason: "无种子关键词，请先配置关键词组" })).toBe(
      "收录 0 条热点（无种子关键词，请先配置关键词组）",
    );
    // 契约：reason 解释「为什么是 0」，有产出时不带出来
    expect(hotRefresh.summarize({ collected: 5, reason: "无种子关键词" })).toBe("收录 5 条热点");
  });

  it("content_rewrite 的摘要：草稿 ID + 标题 + 改写后字数", () => {
    const tool = findSkillDefinition("content_rewrite");
    if (!tool) throw new Error("content_rewrite 不在目录里");
    expect(tool.summarize({ draft_id: 12, title: "露营装备清单", length: 356 })).toBe(
      "已改写草稿 #12：《露营装备清单》（356 字）",
    );
    // 标题缺失时退化为「#id（字数）」，不能让摘要出现空括号
    expect(tool.summarize({ draft_id: 12, length: 356 })).toBe("已改写草稿 #12（356 字）");
  });

  it("content_titles / content_tags 的摘要：正常给条数与首项，空结果带出原因", () => {
    const titles = findSkillDefinition("content_titles");
    const tags = findSkillDefinition("content_tags");
    if (!titles || !tags) throw new Error("content_titles / content_tags 不在目录里");
    expect(titles.summarize({ titles: ["露营装备清单", "标题B"] })).toBe("生成 2 个标题：《露营装备清单》");
    expect(titles.summarize({ titles: [], reason: "模型未返回可用标题" })).toBe("生成 0 个标题（模型未返回可用标题）");
    // 标签预览最多 3 个，用空格分隔
    expect(tags.summarize({ tags: ["露营", "户外", "装备", "第四个"] })).toBe("生成 4 个标签：#露营 #户外 #装备");
    expect(tags.summarize({ tags: [], reason: "模型未返回可用标签" })).toBe("生成 0 个标签（模型未返回可用标签）");
  });

  it("analytics_reports / kb_get 的摘要：空结果带出原因（可诊断性要求）", () => {
    const reports = findSkillDefinition("analytics_reports");
    const kb = findSkillDefinition("kb_get");
    if (!reports || !kb) throw new Error("analytics_reports / kb_get 不在目录里");
    expect(reports.summarize({ count: 3, reports: [{}, {}, {}] })).toBe("读取 3 份爆款拆解报告");
    // 契约：reason 解释「为什么是 0」，有产出时不带出来
    expect(reports.summarize({ count: 0, reports: [], reason: "还没有爆款拆解报告，可先在「爆款拆解」页生成" })).toBe(
      "读取 0 份爆款拆解报告（还没有爆款拆解报告，可先在「爆款拆解」页生成）",
    );
    expect(kb.summarize({ context: "x".repeat(100), length: 100 })).toBe("读取知识库上下文（100 字）");
    expect(kb.summarize({ context: "", length: 0, reason: "知识库尚未配置，可先在「知识库」页填写账号定位与口吻" })).toBe(
      "读取知识库上下文（0 字，知识库尚未配置，可先在「知识库」页填写账号定位与口吻）",
    );
  });

  it("library_search_notes / library_note_detail 的摘要：带原因与评论数", () => {
    const search = findSkillDefinition("library_search_notes");
    const detail = findSkillDefinition("library_note_detail");
    if (!search || !detail) throw new Error("library_* 不在目录里");
    expect(search.summarize({ total: 3, count: 3, items: [] })).toBe("检索到 3 篇笔记");
    expect(search.summarize({ total: 0, count: 0, items: [], reason: "没有匹配「露营」的笔记" })).toBe(
      "检索到 0 篇笔记（没有匹配「露营」的笔记）",
    );
    expect(detail.summarize({ note_id: 5, note_title: "露营装备清单", comment_total: 8 })).toBe(
      "笔记 #5《露营装备清单》，评论 8 条",
    );
    expect(detail.summarize({ note_id: 5, note_title: "露营装备清单", comment_total: 0 })).toBe(
      "笔记 #5《露营装备清单》，暂无评论",
    );
  });

  it("摘要对畸形 details 不抛错、不产出空文案（D21：工具卡不能没有摘要行）", () => {
    const titles = findSkillDefinition("content_titles");
    const tags = findSkillDefinition("content_tags");
    const detail = findSkillDefinition("library_note_detail");
    if (!titles || !tags || !detail) throw new Error("工具不在目录里");
    // summarizeCount 会把数字字符串当数字：不能用它判「是不是数组」
    expect(titles.summarize({ titles: "3" })).toBe("生成 0 个标题");
    expect(tags.summarize({ tags: 5 })).toBe("生成 0 个标签");
    expect(detail.summarize({ note_id: 5, note_title: 123, comment_total: "x" })).toBe("笔记 #5，暂无评论");
  });

  it("content_rewrite 空产出（原文未改动）的摘要带出 reason", () => {
    const tool = findSkillDefinition("content_rewrite");
    if (!tool) throw new Error("content_rewrite 不在目录里");
    expect(
      tool.summarize({ draft_id: 12, title: "露营装备清单", length: 0, reason: "模型返回空内容，原文未改动" }),
    ).toBe("未改动草稿 #12：《露营装备清单》（模型返回空内容，原文未改动）");
  });

  it("library_search_notes 结果被截断时摘要标出实际返回条数", () => {
    const search = findSkillDefinition("library_search_notes");
    if (!search) throw new Error("library_search_notes 不在目录里");
    expect(search.summarize({ total: 30, count: 20, items: [] })).toBe("检索到 30 篇笔记（返回 20 条）");
  });

  it("kb_get 只在 0 字时带出 reason（有产出不带，与 hot_refresh 同契约）", () => {
    const kb = findSkillDefinition("kb_get");
    if (!kb) throw new Error("kb_get 不在目录里");
    expect(kb.summarize({ context: "x", length: 1, reason: "不该出现" })).toBe("读取知识库上下文（1 字）");
  });
});
