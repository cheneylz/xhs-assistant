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
  /**
   * 工具卡摘要：把产出浓缩成一行给用户「一眼看懂」（D21）。
   * **必填** —— 选 D21 的既定成本就是每个工具都要写一份（P1 设计稿 §6.5）。
   * 服务端算好写进 agent_tool_calls.summary，前端不 import 本文件。
   */
  summarize: (details: Record<string, unknown>) => string;
}

/**
 * 摘要里安全读取「条数」：数组取长度，其余尝试转数字，失败归零。
 * details 的类型是 unknown（工具返回值），不能直接当 number 用。
 */
export function summarizeCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export const SKILL_CATALOG: SkillDefinition[] = [
  {
    skillKey: "hot_refresh",
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
    summarize: (details) => {
      const collected = summarizeCount(details.collected);
      if (collected > 0) return `收录 ${collected} 条热点`;
      // 0 条时把原因带出来：否则用户无法区分「没配关键词组」与「采集失败」（验收发现）
      const reason = typeof details.reason === "string" && details.reason ? `（${details.reason}）` : "";
      return `收录 ${collected} 条热点${reason}`;
    },
  },
  {
    skillKey: "topic_generate",
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
    summarize: (details) => `生成 ${summarizeCount(details.suggestion_ids)} 个选题`,
  },
  {
    skillKey: "content_note_pack",
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
    summarize: (details) => {
      const titles = Array.isArray(details.titles) ? details.titles : [];
      const first = titles.length ? `：《${String(titles[0])}》` : "";
      return `已保存草稿 #${summarizeCount(details.draft_id)}${first}`;
    },
  },
  {
    skillKey: "review_submit",
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
    summarize: (details) =>
      `审校工单 #${summarizeCount(details.review_id)}，门禁 ${String(details.gate_status || "未知")}`,
  },
  {
    skillKey: "script_generate",
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
    summarize: (details) => `生成脚本 ${String(details.script ?? "").length} 字`,
  },
  {
    skillKey: "schedule_recommend",
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
    summarize: (details) => `推荐 ${summarizeCount(details.slots)} 个发布时段`,
  },
  {
    skillKey: "content_rewrite",
    name: "去 AI 味改写",
    description: "改写指定草稿的正文，降低 AI 腔、增强小红书语感（直接覆盖原文，无撤销）",
    paramsSchema: {
      type: "object",
      properties: {
        draft_id: { type: "number" },
        instruction: { type: "string" },
        intensity: { type: "string", enum: ["light", "medium", "deep"] },
      },
      required: ["draft_id"],
    },
    instructions: `---
name: 去 AI 味改写
description: 对指定草稿正文做去 AI 味改写并直接覆盖原文
---

# 去 AI 味改写

调用文本模型对草稿正文做去 AI 味改写（降低书面腔、模板感与空洞排比），**结果直接覆盖草稿原文，没有撤销**。调用前必须先说明将要修改哪篇草稿。

## 参数

- draft_id：草稿 ID（必填）
- instruction：额外改写要求（可选）
- intensity：改写强度 light / medium / deep（可选，默认 medium）

## 输出

返回草稿 ID（draft_id）、标题（title）与改写后字数（length）。`,
    // 实证：api/ai/rewrite-note/route.ts:44 执行 aiDraft.update({ body: rewrittenBody }) —— 真的改用户草稿
    riskLevel: "write",
    artifact: {
      kind: "draft",
      idField: "draft_id",
      // 字符串 titleField：单产出取该字段本身（extractArtifacts 已支持，见 persist.ts）
      titleField: "title",
      hrefPrefix: "/platforms/xhs/drafts?id=",
    },
    summarize: (details) => {
      const draftId = summarizeCount(details.draft_id);
      const title = typeof details.title === "string" && details.title ? `：《${details.title}》` : "";
      return `已改写草稿 #${draftId}${title}（${summarizeCount(details.length)} 字）`;
    },
  },
  {
    skillKey: "content_titles",
    name: "标题生成",
    description: "为给定文案生成多个小红书标题备选（只返回数组，不落库）",
    paramsSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        count: { type: "number", default: 5 },
      },
      required: ["title"],
    },
    instructions: `---
name: 标题生成
description: 为给定文案生成多个小红书风格标题备选
---

# 标题生成

为给定标题与正文生成多个备选标题（口语化、有钩子）。**只返回数组，不落库** —— 结果可直接作为参数喂给 content_note_pack 等下游工具。

## 参数

- title：原标题（必填）
- body：正文内容（可选，越完整生成的标题越贴合）
- count：标题数量（可选，默认 5，最多 10）

## 输出

返回标题数组（titles）与数量（count）。`,
    // 实证：generateTitles 纯返回 string[]，无任何 prisma 产品数据写入
    riskLevel: "read",
    summarize: (details) => {
      const count = summarizeCount(details.titles);
      if (count > 0) {
        const first = String((details.titles as unknown[])[0] ?? "");
        return `生成 ${count} 个标题${first ? `：《${first}》` : ""}`;
      }
      const reason = typeof details.reason === "string" && details.reason ? `（${details.reason}）` : "";
      return `生成 0 个标题${reason}`;
    },
  },
  {
    skillKey: "content_tags",
    name: "标签生成",
    description: "为给定文案生成话题标签（只返回数组，不落库）",
    paramsSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        count: { type: "number", default: 8 },
      },
      required: ["title"],
    },
    instructions: `---
name: 标签生成
description: 为给定文案生成小红书话题标签
---

# 标签生成

为给定标题与正文生成话题标签。**只返回数组，不落库**。

## 参数

- title：标题（必填）
- body：正文内容（可选）
- count：标签数量（可选，默认 8，最多 20）

## 输出

返回标签数组（tags，不含 # 前缀）与数量（count）。`,
    // 实证：generateTags 纯返回 string[]，无任何 prisma 产品数据写入
    riskLevel: "read",
    summarize: (details) => {
      const count = summarizeCount(details.tags);
      if (count > 0) {
        const preview = (details.tags as unknown[]).slice(0, 3).map((tag) => `#${String(tag)}`).join(" ");
        return `生成 ${count} 个标签：${preview}`;
      }
      const reason = typeof details.reason === "string" && details.reason ? `（${details.reason}）` : "";
      return `生成 0 个标签${reason}`;
    },
  },
  {
    skillKey: "analytics_reports",
    name: "分析报告读取",
    description: "读取最近的爆款拆解报告（结构规律与样本笔记）",
    paramsSchema: { type: "object", properties: { limit: { type: "number", default: 5 } } },
    instructions: `---
name: 分析报告读取
description: 读取最近的爆款拆解报告，了解同赛道已验证的内容结构
---

# 分析报告读取

读取最近的爆款拆解报告（标题/封面/正文/互动结构规律 + 样本笔记），作为生成内容的参考。

## 参数

- limit：读取最近几份（可选，默认 5，最多 20）

## 输出

返回报告数组（reports，含结构规律与样本）与数量（count）。`,
    // 实证：listExplosionReports 仅 findMany，无写入
    riskLevel: "read",
    summarize: (details) => {
      const count = summarizeCount(details.reports);
      if (count > 0) return `读取 ${count} 份爆款拆解报告`;
      const reason = typeof details.reason === "string" && details.reason ? `（${details.reason}）` : "";
      return `读取 0 份爆款拆解报告${reason}`;
    },
  },
  {
    skillKey: "kb_get",
    name: "知识库读取",
    description: "读取账号知识库上下文（定位/口吻/可信主张/内容边界/经验）",
    paramsSchema: { type: "object", properties: {} },
    instructions: `---
name: 知识库读取
description: 读取账号知识库（定位、口吻风格、可信主张、内容边界、经验与风格样本）
---

# 知识库读取

读取账号知识库上下文，了解账号定位、口吻风格、可信主张、内容边界与已验证经验。

## 参数

无参数。

## 输出

返回知识库上下文本（context）与字数（length）。`,
    // 实证：buildKbContext 只读知识库与样本，无写入
    riskLevel: "read",
    summarize: (details) => {
      const length = summarizeCount(details.length);
      const reason = typeof details.reason === "string" && details.reason ? `，${details.reason}` : "";
      return `读取知识库上下文（${length} 字${reason}）`;
    },
  },
  {
    skillKey: "library_search_notes",
    name: "内容库检索",
    description: "按关键词/标签检索内容库里的笔记（标题、作者、时间与正文摘要）",
    paramsSchema: {
      type: "object",
      properties: {
        keyword: { type: "string" },
        tag_id: { type: "number" },
        limit: { type: "number", default: 10 },
      },
    },
    instructions: `---
name: 内容库检索
description: 按关键词或标签检索内容库里的笔记
---

# 内容库检索

按关键词（匹配标题/正文/作者/笔记 ID）或标签检索内容库，返回命中的笔记摘要。

## 参数

- keyword：关键词（可选；不传则取最近的笔记）
- tag_id：按标签 ID 过滤（可选）
- limit：返回条数（可选，默认 10，最多 20）

## 输出

返回命中总数（total）、返回条数（count）与笔记摘要数组（items：id/title/author_name/platform/created_at/content_excerpt）。`,
    // 实证：note-service 的 searchNotes 只 findMany，无写入
    riskLevel: "read",
    summarize: (details) => {
      const total = summarizeCount(details.total);
      if (total > 0) return `检索到 ${total} 篇笔记`;
      const reason = typeof details.reason === "string" && details.reason ? `（${details.reason}）` : "";
      return `检索到 0 篇笔记${reason}`;
    },
  },
  {
    skillKey: "library_note_detail",
    name: "笔记详情+评论",
    description: "读取一篇笔记的完整正文/标签与评论列表",
    paramsSchema: {
      type: "object",
      properties: {
        note_id: { type: "number" },
        comment_limit: { type: "number", default: 20 },
      },
      required: ["note_id"],
    },
    instructions: `---
name: 笔记详情+评论
description: 读取一篇内容库笔记的完整正文、标签与评论
---

# 笔记详情+评论

读取指定笔记的完整正文（超长截断到 2000 字）、标签与评论列表（超长单条截断到 200 字）。

## 参数

- note_id：笔记 ID（必填，内容库主键，不是小红书 note_id）
- comment_limit：最多返回多少条评论（可选，默认 20，最多 200）

## 输出

返回笔记信息（note_id/note_title/author_name/platform/created_at/tags/content/content_truncated）、评论总数（comment_total）与评论数组（comments：user_name/content/like_count）。`,
    // 实证：note-service 的 getNoteDetail / listNoteComments 只读，无写入
    riskLevel: "read",
    summarize: (details) => {
      const noteId = summarizeCount(details.note_id);
      const title = typeof details.note_title === "string" && details.note_title ? `《${details.note_title}》` : "";
      const total = summarizeCount(details.comment_total);
      return total > 0 ? `笔记 #${noteId}${title}，评论 ${total} 条` : `笔记 #${noteId}${title}，暂无评论`;
    },
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
    case "hot_refresh": {
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
      // reason 必须透传：它是「为什么 0 条」的唯一说明（无关键词组 / 无 Cookie / 采集无结果），
      // 丢了它工具卡就只剩一句「收录 0 条热点」（浏览器验收发现的 P0 可诊断性缺陷）
      return { collected: result.collected, snapshotTime: result.snapshotTime, reason: result.reason };
    }
    case "topic_generate": {
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
    case "content_note_pack": {
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
    case "review_submit": {
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
    case "script_generate": {
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
    case "schedule_recommend": {
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
