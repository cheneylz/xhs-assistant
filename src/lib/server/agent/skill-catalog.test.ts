/**
 * 技能目录单元测试
 * 覆盖：目录完整性、元数据字段、riskLevel 合法性
 */
import { describe, expect, it } from "vitest";
import { SKILL_CATALOG, findSkillDefinition } from "./skill-catalog";

const VALID_RISK_LEVELS = ["read", "write", "publish"];

describe("SKILL_CATALOG（技能目录）", () => {
  it("包含全部 6 个预置技能", () => {
    const keys = SKILL_CATALOG.map((item) => item.skillKey).sort();
    expect(keys).toEqual([
      "content.notePack",
      "hot.refresh",
      "review.submit",
      "schedule.recommend",
      "script.generate",
      "topic.generate",
    ]);
  });

  it("每个技能都有合法的 riskLevel", () => {
    for (const item of SKILL_CATALOG) {
      expect(VALID_RISK_LEVELS, `技能 ${item.skillKey} 的 riskLevel`).toContain(item.riskLevel);
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
    expect(findSkillDefinition("topic.generate")?.name).toBe("选题生成");
    expect(findSkillDefinition("not.exist")).toBeUndefined();
  });

  it("6 个技能全部为 read 或 write，不含 publish（首期不开放发布）", () => {
    for (const item of SKILL_CATALOG) {
      expect(item.riskLevel, `技能 ${item.skillKey} 不应为 publish`).not.toBe("publish");
    }
  });
});
