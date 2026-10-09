/**
 * Agent 会话服务单元测试
 * 覆盖：默认值、状态判定等纯逻辑（DB 交互部分由 Task 12 端到端覆盖）
 */
import { describe, expect, it } from "vitest";
import { buildRunDefaults, isRunTerminal, deriveConversationTitle } from "./agent-service";

describe("buildRunDefaults（Run 默认值）", () => {
  it("返回默认护栏阈值", () => {
    const defaults = buildRunDefaults();
    expect(defaults.maxSteps).toBeGreaterThan(0);
    expect(defaults.tokenBudget).toBeGreaterThan(0);
    expect(defaults.status).toBe("pending");
    expect(defaults.stepCount).toBe(0);
    expect(defaults.tokensUsed).toBe(0);
  });

  it("环境变量可覆盖默认值", () => {
    const defaults = buildRunDefaults({ AGENT_MAX_STEPS: "30", AGENT_TOKEN_BUDGET: "50000" });
    expect(defaults.maxSteps).toBe(30);
    expect(defaults.tokenBudget).toBe(50000);
  });

  it("非法环境变量回退到默认值", () => {
    const defaults = buildRunDefaults({ AGENT_MAX_STEPS: "abc" });
    expect(defaults.maxSteps).toBe(20);
  });
});

describe("isRunTerminal（终态判定）", () => {
  it("succeeded / failed / cancelled 是终态", () => {
    expect(isRunTerminal("succeeded")).toBe(true);
    expect(isRunTerminal("failed")).toBe(true);
    expect(isRunTerminal("cancelled")).toBe(true);
  });

  it("pending / running 不是终态", () => {
    expect(isRunTerminal("pending")).toBe(false);
    expect(isRunTerminal("running")).toBe(false);
  });
});

describe("deriveConversationTitle（会话标题）", () => {
  it("取首条用户消息前 20 字", () => {
    expect(deriveConversationTitle("帮我生成三篇露营主题的小红书笔记")).toBe("帮我生成三篇露营主题的小红书笔记");
  });

  it("超长标题截断并加省略号", () => {
    const long = "帮我生成三篇露营主题的小红书笔记，要求口语化、有信息密度、带话题标签";
    const title = deriveConversationTitle(long);
    expect(title.length).toBeLessThanOrEqual(21);
    expect(title.endsWith("…")).toBe(true);
  });

  it("空输入返回默认标题", () => {
    expect(deriveConversationTitle("")).toBe("新任务");
    expect(deriveConversationTitle("   ")).toBe("新任务");
  });

  it("标题按码点截断，emoji 不会被切成半个字符", () => {
    const title = deriveConversationTitle("🎉".repeat(30));
    expect([...title]).toHaveLength(21);
    expect(title.endsWith("…")).toBe(true);
  });
});
