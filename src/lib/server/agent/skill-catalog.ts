/**
 * Agent 技能目录与执行器
 *
 * 从 workflow-service.ts 抽出，供「工作流编排」与「Agent 循环」共用。
 * 【本文件不含 Pi 依赖】—— 可被 Next.js 侧安全 import。
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../core/db";
import { extractJsonObject } from "../core/json-extract";
import { shanghaiNow } from "../core/time";
import type { ModelConfigLike, OpenAICompatibleTextClient } from "../services/ai-service";
import { buildKbContext } from "../services/knowledge-base-service";
import { createReviewJob } from "../services/review-service";
import { generateSuggestions } from "../services/suggestion-service";
import { collectHotTopicsForUser } from "../services/hot-topic-service";
import { makeUsageLogger } from "../services/usage-service";

/** 工件类型：驱动 Agent 工作台的右栏工件面板渲染 */
export type ArtifactKind = "draft" | "topic" | "image" | "review" | "report" | "script";

/** 产出物声明：把工具返回值映射为工件面板条目 */
export interface ArtifactSpec {
  kind: ArtifactKind;
  /** 产出物 id 所在字段名；该字段是数组时表示一次产出多个工件 */
  idField: string;
  /** 标题字段名（数组产出按索引对应；单产出取首项） */
  titleField?: string;
  /** 跳转链接前缀，拼接 id 得到 href */
  hrefPrefix: string;
}

/** 运行时枚举：护栏分级的单一真相源 */
export const SKILL_RISK_LEVELS = ["read", "write", "publish"] as const;

/** 技能护栏分级：read 直接执行 / write 直接执行但产出待验收 / publish 需人工确认 */
export type SkillRiskLevel = (typeof SKILL_RISK_LEVELS)[number];

// ---------- 技能目录（S-03 技能注册表种子数据）----------
// 技能采用标准 Agent SKILL 格式：元数据（name/description）+ instructions（Markdown 指令正文），
// 预置技能以代码映射执行，人工维护的 instructions 用于展示与 LLM 驱动执行。

export interface SkillDefinition {
  skillKey: string;
  name: string;
  description: string;
  paramsSchema: Record<string, unknown>;
  /** SKILL.md 风格指令正文（Markdown，含 frontmatter） */
  instructions: string;
  /** 护栏分级：read 直接执行 / write 产出待验收 / publish 需人工确认 */
  riskLevel: SkillRiskLevel;
  /** 产出物声明，驱动工件面板 */
  artifact?: ArtifactSpec;
}

export const SKILL_CATALOG: SkillDefinition[] = [
  {
    skillKey: "hot.refresh",
    name: "热点采集",
    description: "采集全站热点榜单（30 分钟任务的手动版）",
    paramsSchema: { type: "object", properties: {} },
    instructions: `---
name: 热点采集
description: 采集全站热点榜单，计算热度分并生成 TOP50 快照
---

# 热点采集

调用 PC 搜索接口采集种子关键词的全站热点，按热度分排序生成 TOP50 榜单快照。

## 参数

无参数。

## 输出

返回本次采集收录的话题数量（collected）。`,
    // 注意：热点采集会写库（hotTopic.createMany + deleteMany 清上一批），故为 write 而非 read
    riskLevel: "write",
  },
  {
    skillKey: "topic.generate",
    name: "选题生成",
    description: "基于知识库+热点+爆款结构生成选题列表",
    paramsSchema: { type: "object", properties: { count: { type: "number", default: 5 } } },
    instructions: `---
name: 选题生成
description: 基于账号知识库、实时热点与爆款拆解结构，生成可直接落地的选题列表
---

# 选题生成

结合账号知识库（定位/口吻/经验结论）、当前热点 TOP10 与最新爆款拆解结构，生成小红书选题。

## 参数

- count：生成数量（默认 5，最多 20）

## 输出

返回选题 ID 列表（suggestion_ids）、标题列表（titles）与生成数量（count）。`,
    riskLevel: "write",
    // 多产出：suggestion_ids 与 titles 都是数组，按索引对应
    artifact: {
      kind: "topic",
      idField: "suggestion_ids",
      titleField: "titles",
      hrefPrefix: "/platforms/xhs/planner?id=",
    },
  },
  {
    skillKey: "content.notePack",
    name: "文案包生成",
    description: "生成标题/正文/标签/CTA 完整文案包并保存草稿",
    paramsSchema: { type: "object", properties: { topic: { type: "string" } } },
    instructions: `---
name: 文案包生成
description: 围绕选题生成标题备选、正文、话题标签与行动引导的完整文案包，并保存为草稿
---

# 文案包生成

围绕给定选题，参考账号知识库生成 3-5 个标题备选、300-800 字正文、话题标签与行动引导，落库为草稿。

## 参数

- topic：选题标题（必填）

## 输出

返回草稿 ID（draft_id）、标题备选（titles）与标签（tags）。`,
    riskLevel: "write",
    artifact: {
      kind: "draft",
      idField: "draft_id",
      titleField: "titles",
      hrefPrefix: "/platforms/xhs/drafts?id=",
    },
  },
  {
    skillKey: "review.submit",
    name: "内容审校",
    description: "双层检测 + 三道门禁审校",
    paramsSchema: { type: "object", properties: { draft_id: { type: "number" } } },
    instructions: `---
name: 内容审校
description: 对草稿执行合规规则检测与三道门禁审校
---

# 内容审校

对指定草稿执行双层检测（关键词/规则 + LLM 审校）与三道门禁（广告法/违禁词/敏感内容），生成审校工单。

## 参数

- draft_id：草稿 ID（必填）

## 输出

返回审校工单 ID（review_id）、门禁状态（gate_status）与状态（status）。`,
    riskLevel: "write",
    artifact: {
      kind: "review",
      idField: "review_id",
      hrefPrefix: "/platforms/xhs/review?id=",
    },
  },
  {
    skillKey: "script.generate",
    name: "视频脚本生成",
    description: "基于草稿文案生成短视频脚本",
    paramsSchema: { type: "object", properties: { draft_id: { type: "number" } } },
    instructions: `---
name: 视频脚本生成
description: 将图文草稿转化为 30-60 秒口播分镜脚本
---

# 视频脚本生成

基于草稿文案生成短视频分镜脚本：开场钩子（前 3 秒）→ 内容展开（分镜列表）→ 结尾引导。

## 参数

- draft_id：草稿 ID（必填）

## 输出

返回分镜脚本文本（script）。`,
    // generateVideoScript 无任何 prisma 调用（只读草稿 + 调 LLM），故为 read 而非 write
    riskLevel: "read",
  },
  {
    skillKey: "schedule.recommend",
    name: "智能排期",
    description: "基于历史数据推荐发布时间",
    paramsSchema: { type: "object", properties: { platform_account_id: { type: "number" } } },
    instructions: `---
name: 智能排期
description: 基于历史发布数据与平台活跃规律，推荐未来 3 天最佳发布时间
---

# 智能排期

基于账号历史发布数据与平台活跃规律，推荐未来 3 天的最佳发布时间槽位。

## 参数

- platform_account_id：发布账号 ID（必填）

## 输出

返回推荐时间槽位（slots）与推荐理由（reason）。`,
    // recommendSchedules 仅 findFirst/findMany，无写入，故为 read
    riskLevel: "read",
  },
];

/** 按 skillKey 查找技能定义 */
export function findSkillDefinition(skillKey: string): SkillDefinition | undefined {
  return SKILL_CATALOG.find((item) => item.skillKey === skillKey);
}

// ---------- 技能执行器 ----------

export interface SkillContext {
  userId: number;
  textClient: OpenAICompatibleTextClient;
  modelConfig: ModelConfigLike | null;
  apiKey: string;
}

/** 执行单个技能（映射到现有服务函数） */
export async function executeSkill(skillKey: string, params: Record<string, unknown>, context: SkillContext): Promise<Record<string, unknown>> {
  const { userId, textClient, modelConfig, apiKey } = context;
  switch (skillKey) {
    case "hot.refresh": {
      const account = await prisma.platformAccount.findFirst({ where: { userId, platform: "xhs", subType: "pc" }, orderBy: { id: "asc" } });
      if (!account) throw new Error("未绑定 PC 账号，无法刷新热点");
      const cookieVersion = await prisma.accountCookieVersion.findFirst({
        where: { platformAccountId: account.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      if (!cookieVersion) throw new Error("PC 账号无有效 Cookie");
      const { XhsPcApiAdapter } = await import("@/lib/server/xhs/adapters/pc-api-adapter");
      const result = await collectHotTopicsForUser({
        userId,
        adapterFactory: (cookies) => new XhsPcApiAdapter(cookies),
      });
      return { collected: result.collected };
    }
    case "topic.generate": {
      if (!modelConfig || !apiKey) throw new Error("未配置文本模型，无法生成选题");
      const count = Math.max(1, Math.min(Number(params.count) || 5, 20));
      const { items } = await generateSuggestions({
        userId,
        count,
        textClient,
        modelConfig,
        apiKey,
      });
      return {
        suggestion_ids: items.map((item) => Number(item.id)),
        titles: items.map((item) => String(item.title)),
        count: items.length,
      };
    }
    case "content.notePack": {
      if (!modelConfig || !apiKey) throw new Error("未配置文本模型，无法生成文案包");
      const topic = String(params.topic ?? "").trim();
      if (!topic) throw new Error("缺少选题（topic）参数");
      const kbContext = await buildKbContext(userId);
      const pack = await textClient.generateNotePack({ modelConfig, apiKey, topic, kbContext, onUsage: makeUsageLogger(userId, modelConfig.modelName) });
      const draft = await prisma.aiDraft.create({
        data: {
          userId,
          platform: "xhs",
          title: pack.titles[0] ?? topic,
          body: pack.body || "",
          tags: pack.tags.length ? (pack.tags as Prisma.InputJsonValue) : undefined,
          createdAt: shanghaiNow(),
        },
      });
      return { draft_id: draft.id, titles: pack.titles, tags: pack.tags };
    }
    case "review.submit": {
      const draftId = Number(params.draft_id);
      if (!draftId) throw new Error("缺少草稿（draft_id）参数");
      const draft = await prisma.aiDraft.findFirst({ where: { id: draftId, userId } });
      if (!draft) throw new Error("草稿不存在");
      const { job } = await createReviewJob({
        userId,
        sourceDraftId: draft.id,
        title: draft.title,
        body: draft.body,
        textClient: modelConfig && apiKey ? textClient : null,
        modelConfig: modelConfig ?? null,
        apiKey: apiKey ?? null,
      });
      return { review_id: job.id, gate_status: job.gateStatus, status: job.status };
    }
    case "script.generate": {
      if (!modelConfig || !apiKey) throw new Error("未配置文本模型，无法生成脚本");
      const draftId = Number(params.draft_id);
      if (!draftId) throw new Error("缺少草稿（draft_id）参数");
      const draft = await prisma.aiDraft.findFirst({ where: { id: draftId, userId } });
      if (!draft) throw new Error("草稿不存在");
      const script = await textClient.generateVideoScript({
        modelConfig,
        apiKey,
        onUsage: makeUsageLogger(userId, modelConfig.modelName),
        title: draft.title,
        body: draft.body,
      });
      return { script };
    }
    case "schedule.recommend": {
      const accountId = Number(params.platform_account_id);
      if (!accountId) throw new Error("缺少发布账号（platform_account_id）参数");
      const { recommendSchedules } = await import("../services/schedule-service");
      const result = await recommendSchedules({ userId, platformAccountId: accountId, days: 3 });
      return { slots: result.slots, reason: result.reason };
    }
    default: {
      // 自定义技能：以注册表维护的 instructions（SKILL.md 风格）作为 system prompt，由 LLM 驱动执行
      if (!modelConfig || !apiKey) throw new Error("未配置文本模型，无法执行自定义技能");
      const custom = await prisma.skillRegistry.findFirst({ where: { userId, skillKey, enabled: true } });
      if (!custom || !custom.instructions.trim()) throw new Error(`未知技能: ${skillKey}`);
      const outputText = await textClient.complete({
        modelConfig,
        apiKey,
        systemPrompt: custom.instructions,
        userPrompt: `请执行该技能。技能参数（JSON）：${JSON.stringify(params)}\n只输出 JSON 结果。`,
        temperature: 0.3,
        onUsage: makeUsageLogger(userId, modelConfig.modelName), // S-06 用量采集
      });
      const payload = extractJsonObject<Record<string, unknown>>(outputText);
      return payload ?? { result: outputText };
    }
  }
}
