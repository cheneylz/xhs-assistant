/**
 * 工具注册表单元测试
 * 覆盖：AgentTool 形状、replay 策略、execute 委托给 executeSkill
 *
 * executeSkill 默认被 mock：真实实现要连库/联网（hot_refresh 还会打小红书接口），
 * 依赖环境数据会让断言时灵时不灵。仅「错误透传」用例用 vi.importActual 取回真实实现。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// 只替换 executeSkill，保留真实 SKILL_CATALOG / findSkillDefinition 等其余导出
const executeSkillMock = vi.hoisted(() => vi.fn());

vi.mock("./skill-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./skill-catalog")>();
  return { ...actual, executeSkill: executeSkillMock };
});

import { buildAgentTools } from "./tool-registry.mts";
import type { SkillContext } from "./skill-catalog";

const context: SkillContext = {
  userId: 1,
  textClient: {} as never,
  modelConfig: null,
  apiKey: "",
};

beforeEach(() => {
  executeSkillMock.mockReset();
});

describe("buildAgentTools（技能 → AgentTool）", () => {
  it("为 SKILL_CATALOG 每个技能生成一个工具", () => {
    const tools = buildAgentTools(context);
    expect(tools).toHaveLength(6);
  });

  it("工具的 name 等于 skillKey，label 等于技能名", () => {
    const tools = buildAgentTools(context);
    const topicTool = tools.find((tool) => tool.name === "topic_generate");
    expect(topicTool).toBeDefined();
    expect(topicTool?.label).toBe("选题生成");
  });

  it("每个工具都有 description / parameters / execute", () => {
    for (const tool of buildAgentTools(context)) {
      expect(tool.description.length, `${tool.name}.description`).toBeGreaterThan(0);
      expect(tool.parameters, `${tool.name}.parameters`).toBeDefined();
      expect(typeof tool.execute, `${tool.name}.execute`).toBe("function");
    }
  });

  it("read 级工具 replay 为 safe，write 级为 never", () => {
    const tools = buildAgentTools(context);
    // 目录里只有 script_generate / schedule_recommend 两个 read 级技能
    expect(tools.find((tool) => tool.name === "script_generate")?.replay).toBe("safe");
    expect(tools.find((tool) => tool.name === "schedule_recommend")?.replay).toBe("safe");
    expect(tools.find((tool) => tool.name === "hot_refresh")?.replay).toBe("never");
    expect(tools.find((tool) => tool.name === "content_note_pack")?.replay).toBe("never");
    expect(tools.filter((tool) => tool.replay === "safe")).toHaveLength(2);
  });

  it("execute 返回结构化结果，content 为可读文本", async () => {
    executeSkillMock.mockResolvedValue({ draft_id: 128, titles: ["标题A"] });
    const tools = buildAgentTools(context);
    const notePackTool = tools.find((tool) => tool.name === "content_note_pack");

    const result = await notePackTool!.execute("call-1", { topic: "露营" });

    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ draft_id: 128, titles: ["标题A"] }) }]);
    expect(result.details).toEqual({ draft_id: 128, titles: ["标题A"] });
  });

  it("超长产出只截断 content 文本，details 保留完整产出", async () => {
    const huge = { blob: "x".repeat(30_000) };
    executeSkillMock.mockResolvedValue(huge);
    const tools = buildAgentTools(context);

    const result = await tools.find((tool) => tool.name === "hot_refresh")!.execute("call-1", {});

    // details 是 Task 8 extractArtifacts 的数据源，必须完整不能截断
    expect(result.details).toEqual(huge);
    const text = (result.content[0] as { text: string }).text;
    expect(text.length).toBeLessThan(30_000);
    expect(text.endsWith("…（结果过长已截断，完整内容见工件面板）")).toBe(true);
  });

  it("execute 把 skillKey / params / context 原样透传给 executeSkill", async () => {
    executeSkillMock.mockResolvedValue({ collected: 30 });
    const tools = buildAgentTools(context);
    const hotTool = tools.find((tool) => tool.name === "hot_refresh");

    await hotTool!.execute("call-1", {});

    expect(executeSkillMock).toHaveBeenCalledWith("hot_refresh", {}, context);
  });

  it("execute 的失败透出给 Agent 循环（真实 executeSkill）", async () => {
    const actual = await vi.importActual<typeof import("./skill-catalog")>("./skill-catalog");
    executeSkillMock.mockImplementation(actual.executeSkill);
    const tools = buildAgentTools(context);

    // 未配置文本模型 —— 真实 executeSkill 在触达数据库之前就抛错，不依赖环境数据
    await expect(tools.find((tool) => tool.name === "content_note_pack")!.execute("call-1", { topic: "露营" })).rejects.toThrow(
      "未配置文本模型，无法生成文案包",
    );
  });
});
