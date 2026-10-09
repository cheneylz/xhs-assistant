/**
 * 技能目录单元测试
 * 覆盖：目录完整性、元数据字段、riskLevel 合法性
 */
import { describe, expect, it } from "vitest";
import { SKILL_CATALOG, SKILL_RISK_LEVELS, findSkillDefinition } from "./skill-catalog";

describe("SKILL_CATALOG（技能目录）", () => {
  it("包含全部 6 个预置技能", () => {
    const keys = SKILL_CATALOG.map((item) => item.skillKey).sort();
    expect(keys).toEqual([
      "content_note_pack",
      "hot_refresh",
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

  it("6 个技能全部为 read 或 write，不含 publish（首期不开放发布）", () => {
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
  });

  it("声明 artifact 的技能，其 idField 必须真能在产出里找到（防字段名写错）", () => {
    // 抽取的协议字段名与 executeSkill 的 return 语句一一对应
    const expectedIdFields: Record<string, string> = {
      "topic_generate": "suggestion_ids",
      "content_note_pack": "draft_id",
      "review_submit": "review_id",
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
});
