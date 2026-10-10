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
import { listExplosionReports } from "../services/exploration-service";
import { getNoteDetail, listNoteComments, searchNotes } from "../services/note-service";
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
  /** 标题字段名（数组 = 多产出按索引对应；字符串 = 单产出取该值）；缺省或取不到时回退「技能名 #id」 */
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
      const length = summarizeCount(details.length);
      // 0 字 = 模型返回空内容、原文未改动（executeSkill 里已拦截，绝不覆盖正文）—— 必须带出 reason
      if (length === 0) {
        const reason = typeof details.reason === "string" && details.reason ? `（${details.reason}）` : "";
        return `未改动草稿 #${draftId}${title}${reason}`;
      }
      return `已改写草稿 #${draftId}${title}（${length} 字）`;
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
      // 摘要永不空行：非数组一律按「无产出」处理（summarizeCount 会把数字字符串转成数字，不能用来判数组）
      const titles = Array.isArray(details.titles) ? details.titles : [];
      if (titles.length > 0) {
        const first = String(titles[0] ?? "");
        return `生成 ${titles.length} 个标题${first ? `：《${first}》` : ""}`;
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
      // 同 content_titles：非数组按无产出处理（直接 .slice 会在非数组上抛错 → 摘要变空行）
      const tags = Array.isArray(details.tags) ? details.tags : [];
      if (tags.length > 0) {
        const preview = tags.slice(0, 3).map((tag) => `#${String(tag)}`).join(" ");
        return `生成 ${tags.length} 个标签：${preview}`;
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
    // 实证：buildKbContext 只读；仅在知识库无行时创建一条空知识库（幂等、replay 安全，无用户可见数据变更）
    riskLevel: "read",
    summarize: (details) => {
      const length = summarizeCount(details.length);
      // 契约同 hot_refresh：reason 只在 0 字时带出（有产出不带）
      if (length > 0) return `读取知识库上下文（${length} 字）`;
      const reason = typeof details.reason === "string" && details.reason ? `，${details.reason}` : "";
      return `读取知识库上下文（0 字${reason}）`;
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
      if (total > 0) {
        // 命中数大于实际返回条数时标出截断（模型只见得到返回的那批）
        const count = summarizeCount(details.count);
        const truncated = count > 0 && total > count ? `（返回 ${count} 条）` : "";
        return `检索到 ${total} 篇笔记${truncated}`;
      }
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
      // Prisma 会把有限浮点 id 静默截断（12.7 → 12）—— write 级工具不能选错草稿
      if (!Number.isInteger(draftId) || draftId < 1) throw new Error("draft_id 必须是正整数");
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
      // Prisma 会把有限浮点 id 静默截断（12.7 → 12）—— read 级也不该读错草稿
      if (!Number.isInteger(draftId) || draftId < 1) throw new Error("draft_id 必须是正整数");
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
    case "library_search_notes": {
      const keyword = typeof params.keyword === "string" ? params.keyword.trim() : "";
      const limit = Math.max(1, Math.min(Number(params.limit) || 10, 20));
      // null 视同未传（Number(null) 是 0，会把「没传」误当成「查 id=0」）
      const rawTagId = params.tag_id === undefined || params.tag_id === null ? undefined : Number(params.tag_id);
      if (rawTagId !== undefined && (!Number.isInteger(rawTagId) || rawTagId < 1)) {
        throw new Error("tag_id 必须是正整数");
      }
      // limit 下推到服务层：先切片再序列化，避免为 10 条结果序列化整个内容库
      const result = await searchNotes(userId, { keyword: keyword || undefined, tagId: rawTagId, limit });
      if (result.outcome === "tag_not_found") throw new Error(`标签 ${rawTagId} 不存在或不属于当前用户`);
      // 只回模型需要的字段：完整序列化里的 raw_json 体积大且对模型无用
      const items = result.items.map((item) => ({
        id: item.id,
        title: item.title,
        author_name: item.author_name,
        platform: item.platform,
        created_at: item.created_at,
        content_excerpt: String(item.content ?? "").slice(0, 120),
      }));
      if (items.length === 0) {
        // 空结果的 reason 必须带出来（工具卡默认只显示摘要一行，见 handoff §二.6）；
        // 三种「0 条」的原因必须分开，否则会给出错误结论（质量审查 Issue 1）
        const reason = keyword
          ? `没有匹配「${keyword}」的笔记`
          : rawTagId !== undefined
            ? `标签 ${rawTagId} 下还没有笔记`
            : "内容库还没有笔记";
        return { total: 0, count: 0, items, reason };
      }
      return { total: result.total, count: items.length, items };
    }
    case "library_note_detail": {
      const noteId = Number(params.note_id);
      if (!noteId) throw new Error("缺少笔记（note_id）参数");
      // 同 draft_id：Prisma 会把有限浮点静默截断（3.7 → 3），不能读错笔记
      if (!Number.isInteger(noteId) || noteId < 1) throw new Error("note_id 必须是正整数");
      const commentLimit = Math.max(1, Math.min(Number(params.comment_limit) || 20, 200));
      const detail = await getNoteDetail(userId, noteId);
      if (!detail) throw new Error(`笔记 ${noteId} 不存在`);
      const comments = await listNoteComments(userId, noteId);
      if (comments.outcome === "not_found") throw new Error(`笔记 ${noteId} 不存在`);
      const content = String(detail.content ?? "");
      return {
        note_id: detail.id,
        note_title: detail.title,
        author_name: detail.author_name,
        platform: detail.platform,
        created_at: detail.created_at,
        tags: detail.tags,
        content: content.slice(0, 2000),
        content_truncated: content.length > 2000,
        comment_total: comments.items.length,
        comments: comments.items.slice(0, commentLimit).map((comment) => ({
          user_name: comment.user_name,
          content: String(comment.content ?? "").slice(0, 200),
          like_count: comment.like_count,
        })),
      };
    }
    case "content_titles": {
      if (!modelConfig || !apiKey) throw new Error("未配置文本模型，无法生成标题");
      const title = String(params.title ?? "").trim();
      if (!title) throw new Error("缺少标题（title）参数");
      const count = Math.max(1, Math.min(Number(params.count) || 5, 10));
      const titles = await textClient.generateTitles({
        modelConfig,
        apiKey,
        onUsage: makeUsageLogger(userId, modelConfig.modelName),
        title,
        body: typeof params.body === "string" ? params.body : "",
        count,
      });
      // 空结果带 reason（工具卡摘要会显示「生成 0 个标题（模型未返回可用标题）」）
      if (titles.length === 0) return { titles, count: 0, reason: "模型未返回可用标题" };
      return { titles, count: titles.length };
    }
    case "content_tags": {
      if (!modelConfig || !apiKey) throw new Error("未配置文本模型，无法生成标签");
      const title = String(params.title ?? "").trim();
      if (!title) throw new Error("缺少标题（title）参数");
      const count = Math.max(1, Math.min(Number(params.count) || 8, 20));
      const tags = await textClient.generateTags({
        modelConfig,
        apiKey,
        onUsage: makeUsageLogger(userId, modelConfig.modelName),
        title,
        body: typeof params.body === "string" ? params.body : "",
        count,
      });
      if (tags.length === 0) return { tags, count: 0, reason: "模型未返回可用标签" };
      return { tags, count: tags.length };
    }
    case "content_rewrite": {
      if (!modelConfig || !apiKey) throw new Error("未配置文本模型，无法改写草稿");
      const draftId = Number(params.draft_id);
      if (!draftId) throw new Error("缺少草稿（draft_id）参数");
      // Prisma 会把有限浮点 id 静默截断（12.7 → 12，实测）—— 唯一破坏性工具绝不能改错草稿
      if (!Number.isInteger(draftId) || draftId < 1) throw new Error("draft_id 必须是正整数");
      const draft = await prisma.aiDraft.findFirst({ where: { id: draftId, userId } });
      if (!draft) throw new Error(`草稿 ${draftId} 不存在`);
      // 强度只认三档，非法值回退 medium（与路由侧 zod 枚举同口径；Pi 边界另有枚举校验，此回退防的是工作流等非 Pi 调用方）
      const intensity = params.intensity === "light" || params.intensity === "deep" ? params.intensity : "medium";
      const body = await textClient.rewriteNote({
        modelConfig,
        apiKey,
        onUsage: makeUsageLogger(userId, modelConfig.modelName),
        title: draft.title,
        body: draft.body,
        instruction: typeof params.instruction === "string" ? params.instruction : "",
        intensity,
      });
      // 顺序很重要：先拿到改写结果再覆盖，失败时草稿保持原样（无撤销，不能让失败把正文清空）
      // 空内容同理：模型可能返回空串/纯空白，绝不能用它覆盖用户正文（唯一破坏性工具）
      if (!body.trim()) {
        return { draft_id: draft.id, title: draft.title, length: 0, reason: "模型返回空内容，原文未改动" };
      }
      const updated = await prisma.aiDraft.update({ where: { id: draft.id }, data: { body } });
      return { draft_id: updated.id, title: updated.title, length: body.length };
    }
    case "analytics_reports": {
      const limit = Math.max(1, Math.min(Number(params.limit) || 5, 20));
      const reports = await listExplosionReports(userId, limit);
      if (reports.length === 0) {
        return { reports, count: 0, reason: "还没有拆解报告，可先在「策划工作台 → 爆款拆解」生成" };
      }
      return { reports, count: reports.length };
    }
    case "kb_get": {
      // buildKbContext 只在所有字段为空时返回空串（每个 section 都带非空白标签前缀），
      // 因此 !context 恰好等价于「未配置」
      const context = await buildKbContext(userId);
      if (!context) {
        return { context: "", length: 0, reason: "知识库尚未配置，可先在「设置 → 账号知识库」填写账号定位与口吻" };
      }
      return { context, length: context.length };
    }
    default: {
      // 目录里已登记的 skillKey 不该落到这里（说明缺执行分支）：注册表种子会让它静默走 LLM 兜底产出假结果
      if (findSkillDefinition(skillKey)) {
        throw new Error(`技能 ${skillKey} 已登记在目录却缺少执行分支（内部错误，请检查 skill-catalog）`);
      }
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
