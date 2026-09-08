/**
 * 审校引擎服务（AI Agent 平台 R-01~R-06）
 *
 * 双层检测：
 *   第一层（规则，快）：compliance_rules 规则库 + 内置默认规则，确定性匹配
 *   第二层（LLM，深）：语义审校 + 声明验证，输出结构化 JSON 风险点
 * 三道门禁（发布前串行）：
 *   ① claim 声明验证  ② originality 原创性检查（与本地笔记库 Jaccard 相似度）
 *   ③ compliance 合规检查（规则 + LLM）
 * 任一 error 级风险 → gateStatus=blocked，阻断发布（合规零发布）。
 *
 * 设计要点：
 * - 规则匹配、关键词提取、相似度计算均为纯函数，便于单测（见 src/lib/server/services/review-service.test.ts）
 * - LLM 层不配置模型时自动降级为仅规则层（不阻断规则的确定性保障）
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../core/db";
import { formatDateTime, shanghaiNow } from "../core/time";
import type { ModelConfigLike } from "./ai-service";
import { makeUsageLogger } from "./usage-service";
import { renderPrompt } from "../../../prompts/loader";

// ---------- 类型定义 ----------

export interface ReviewRuleLike {
  id?: number;
  ruleType: string;
  pattern: string;
  isRegex: boolean;
  riskLevel: string;
  enabled?: boolean;
}

export interface ReviewFindingLike {
  gate: string; // claim/originality/compliance
  riskType: string; // absolute_claim/medical_claim/fake_data/sensitive_word/inducement/copyright/duplicate/other
  riskLevel: string; // warning/error
  snippet: string;
  suggestion: string;
  fixed?: boolean;
  fixAction?: string;
  fixedText?: string;
}

/** LLM 审校输出（结构化 JSON） */
interface LlmReviewPayload {
  findings?: Array<{
    gate?: string;
    riskType?: string;
    riskLevel?: string;
    snippet?: string;
    suggestion?: string;
  }>;
}

/** 文本模型客户端接口（与 ai-service 解耦，路由层注入） */
export interface TextClientLike {
  complete(options: {
    modelConfig: ModelConfigLike;
    apiKey: string;
    systemPrompt: string;
    userPrompt: string;
    temperature?: number;
    onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void; // S-06 用量采集
  }): Promise<string>;
}

// ---------- 内置默认规则库（未配置规则时兜底，保证开箱可用）----------

export const DEFAULT_RULES: ReviewRuleLike[] = [
  // 绝对化用语（广告法敏感，warning）
  { ruleType: "absolute_claim", pattern: "最显瘦|最好用|最强|最便宜|最有效|第一品牌|全网第一|全国第一|唯一|绝对|100%|百分百|零风险|绝无", isRegex: false, riskLevel: "warning" },
  // 功效宣称（医疗/减肥功效，error）
  { ruleType: "medical_claim", pattern: "治疗|治愈|根治|药到病除|抗癌|防癌|降血糖|降血压|减肥|燃脂|瘦身|美白祛斑|祛痘|丰胸|增高|壮阳|排毒|抗衰老|修复受损|医美级", isRegex: false, riskLevel: "error" },
  // 敏感词（政治/色情/暴力类示例，实际敏感词库由运营在规则管理中维护）
  { ruleType: "sensitive_word", pattern: "代购违禁品|假货|走私|赌博|裸聊", isRegex: false, riskLevel: "error" },
  // 诱导行为
  { ruleType: "inducement", pattern: "点赞|关注我|转发|评论区扣|私信我|加微信|加VX|扫码领|抽奖|送福利", isRegex: false, riskLevel: "warning" },
  // 无来源数据引用（仅提示补来源，warning）
  { ruleType: "fake_data_pattern", pattern: "数据显示|研究表明|调查显示|专家指出|实验证明|研究表明", isRegex: false, riskLevel: "warning" },
];

// ---------- 规则匹配（纯函数，可单测）----------

/** 单条规则匹配文本：正则模式走 RegExp，关键词模式按 | 拆分逐个 includes */
export function matchRule(rule: ReviewRuleLike, text: string): string[] {
  if (!rule.pattern || !text) return [];
  if (rule.isRegex) {
    try {
      const regex = new RegExp(rule.pattern, "i");
      return regex.test(text) ? [rule.pattern] : [];
    } catch {
      return [];
    }
  }
  return rule.pattern
    .split("|")
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0 && text.includes(keyword));
}

/** 规则层检测：返回风险点数组（gate 固定 compliance，riskType 取规则类型） */
export function checkRulesText(rules: ReviewRuleLike[], title: string, body: string): ReviewFindingLike[] {
  const text = `${title}\n${body}`;
  const findings: ReviewFindingLike[] = [];
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    const hits = matchRule(rule, text);
    for (const hit of hits) {
      findings.push({
        gate: "compliance",
        riskType: rule.ruleType,
        riskLevel: rule.riskLevel,
        snippet: hit,
        suggestion: riskSuggestion(rule.ruleType, hit),
      });
    }
  }
  return findings;
}

/** 各类风险的修复建议（规则层确定性输出） */
export function riskSuggestion(riskType: string, snippet: string): string {
  switch (riskType) {
    case "absolute_claim":
      return `绝对化用语「${snippet}」建议收窄断言，如改为「很显瘦/亲测有效」等非绝对表述`;
    case "medical_claim":
      return `功效宣称「${snippet}」涉嫌医疗/功效违规，需删除或改为个人体验描述，并加「仅为个人体验分享」声明`;
    case "sensitive_word":
      return `命中敏感词「${snippet}」，需删除该表述`;
    case "inducement":
      return `诱导行为「${snippet}」建议删除或弱化，避免平台判定为诱导互动`;
    case "fake_data_pattern":
      return `数据引用「${snippet}」需补充可靠来源，或删除无来源数据`;
    default:
      return `命中「${snippet}」，请人工复核`;
  }
}

// ---------- 原创性检查（纯函数 + DB）----------

/** 提取文本 2-gram 关键词集合（CJK 中文按双字切分，英文按词） */
export function keywordBigrams(text: string): Set<string> {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const bigrams = new Set<string>();
  const segments = cleaned.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const segment of segments) {
    const chars = Array.from(segment);
    if (/^[一-鿿]+$/.test(segment)) {
      // 纯中文：双字组合（含首尾单字，增强召回）
      if (chars.length === 1) bigrams.add(segment);
      for (let i = 0; i < chars.length - 1; i++) bigrams.add(chars[i] + chars[i + 1]);
    } else {
      bigrams.add(segment.toLowerCase());
    }
  }
  return bigrams;
}

/** Jaccard 相似度（两个集合交并比，0~1） */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of smaller) {
    if (larger.has(item)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

/** 原创性检查阈值：≥0.5 判定高度相似（error），0.3~0.5 警告（warning） */
export const ORIGINALITY_HARD_THRESHOLD = 0.5;
export const ORIGINALITY_SOFT_THRESHOLD = 0.3;

/** 与本地笔记库比对（取用户最近 200 条笔记标题，Jaccard 判定相似度） */
export async function checkOriginality(
  userId: number,
  title: string,
  body: string,
  excludeNoteId?: number | null,
): Promise<ReviewFindingLike[]> {
  if (!title.trim()) return [];
  const source = keywordBigrams(`${title} ${body.slice(0, 120)}`);
  if (!source.size) return [];
  const notes = await prisma.note.findMany({
    where: { userId, ...(excludeNoteId ? { NOT: { id: excludeNoteId } } : {}) },
    select: { id: true, title: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const findings: ReviewFindingLike[] = [];
  for (const note of notes) {
    if (!note.title.trim()) continue;
    const similarity = jaccardSimilarity(source, keywordBigrams(note.title));
    if (similarity >= ORIGINALITY_SOFT_THRESHOLD) {
      findings.push({
        gate: "originality",
        riskType: "duplicate",
        riskLevel: similarity >= ORIGINALITY_HARD_THRESHOLD ? "error" : "warning",
        snippet: note.title.slice(0, 50),
        suggestion:
          similarity >= ORIGINALITY_HARD_THRESHOLD
            ? `与内容库笔记「${note.title.slice(0, 30)}」高度相似（相似度 ${Math.round(similarity * 100)}%），需大幅改写避免重复`
            : `与内容库笔记「${note.title.slice(0, 30)}」相似度较高（${Math.round(similarity * 100)}%），建议调整标题表达`,
      });
      break; // 只报最高相似度的一条
    }
  }
  return findings;
}

// ---------- LLM 语义审校（第二层 + 声明验证）----------

/** 从 LLM 回复中提取 JSON（容忍 markdown 代码块与前后缀噪声） */
export function extractJsonPayload(content: string): LlmReviewPayload | null {
  let text = content.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    try {
      const payload = JSON.parse(text.slice(braceStart, braceEnd + 1)) as LlmReviewPayload;
      return payload && Array.isArray(payload.findings) ? payload : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** 解析 LLM 审校输出为风险点数组（gate 归一化） */
export function normalizeLlmFindings(payload: LlmReviewPayload | null): ReviewFindingLike[] {
  if (!payload) return [];
  const findings: ReviewFindingLike[] = [];
  for (const item of payload.findings ?? []) {
    if (!item.snippet && !item.suggestion) continue;
    const gate = item.gate === "claim" ? "claim" : "compliance";
    findings.push({
      gate,
      riskType: item.riskType ?? "other",
      riskLevel: item.riskLevel === "error" ? "error" : "warning",
      snippet: String(item.snippet ?? "").slice(0, 200),
      suggestion: String(item.suggestion ?? "").slice(0, 500),
    });
  }
  return findings;
}

/** LLM 语义审校 + 声明验证（第二层），无模型时返回空数组 */
export async function llmReview(options: {
  userId: number;
  title: string;
  body: string;
  modelConfig: ModelConfigLike;
  apiKey: string;
  textClient: TextClientLike;
}): Promise<ReviewFindingLike[]> {
  const { userId, title, body, modelConfig, apiKey, textClient } = options;
  let content: string;
  try {
    content = await textClient.complete({
      modelConfig,
      apiKey,
      systemPrompt: renderPrompt("review.md", "llm-review"),
      userPrompt: `标题：${title}\n\n正文：\n${body}`,
      temperature: 0.2,
      onUsage: makeUsageLogger(userId, modelConfig.modelName, "text"), // S-06 用量采集
    });
  } catch (error) {
    // LLM 层失败不阻断规则层的确定性结论
    console.warn(`[review] LLM 审校失败，降级为仅规则层: ${(error as Error).message}`);
    return [];
  }
  return normalizeLlmFindings(extractJsonPayload(content));
}

// ---------- 状态计算 ----------

/** 汇总风险点计算审校状态与门禁状态（error 级 → blocked/rejected） */
export function computeReviewStatus(findings: ReviewFindingLike[]): { status: string; gateStatus: string } {
  const hasError = findings.some((finding) => finding.riskLevel === "error");
  const hasWarning = findings.some((finding) => finding.riskLevel === "warning");
  if (hasError) return { status: "rejected", gateStatus: "blocked" };
  if (hasWarning) return { status: "warning", gateStatus: "warning" };
  return { status: "passed", gateStatus: "passed" };
}

// ---------- 审校任务创建与修复 ----------

/** 加载用户启用的规则（内置默认规则 + 用户自定义规则） */
export async function loadRules(userId: number): Promise<ReviewRuleLike[]> {
  const custom = await prisma.complianceRule.findMany({
    where: { userId, enabled: true },
    orderBy: { id: "asc" },
  });
  return [...DEFAULT_RULES, ...custom.map((rule) => ({ ...rule, pattern: rule.pattern, isRegex: rule.isRegex }))];
}

export interface CreateReviewOptions {
  userId: number;
  sourceDraftId?: number | null;
  sourceNoteId?: number | null;
  title: string;
  body: string;
  textClient?: TextClientLike | null;
  modelConfig?: ModelConfigLike | null;
  apiKey?: string | null;
}

/** 执行完整审校（双层检测 + 三道门禁），返回风险点数组（不落库，供创建与复检共用） */
export async function runReview(options: CreateReviewOptions): Promise<ReviewFindingLike[]> {
  const { userId, title, body, sourceNoteId } = options;
  const rules = await loadRules(userId);
  const findings: ReviewFindingLike[] = [
    ...checkRulesText(rules, title, body), // 第一层：规则
    ...(await checkOriginality(userId, title, body, sourceNoteId)), // 第二道门禁：原创性
  ];
  if (options.textClient && options.modelConfig && options.apiKey) {
    findings.push(...(await llmReview({ userId, title, body, modelConfig: options.modelConfig, apiKey: options.apiKey, textClient: options.textClient }))); // 第二层：LLM
  }
  return dedupeFindings(findings);
}

/** 去重：同 gate+riskType+riskLevel+snippet 只保留一条（规则库与 LLM 可能重复命中） */
export function dedupeFindings(findings: ReviewFindingLike[]): ReviewFindingLike[] {
  const seen = new Set<string>();
  const result: ReviewFindingLike[] = [];
  for (const finding of findings) {
    const key = `${finding.gate}|${finding.riskType}|${finding.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(finding);
  }
  return result;
}

/** 创建审校任务：双层检测 + 三道门禁，结果落库，并同步发布任务门禁状态 */
export async function createReviewJob(options: CreateReviewOptions) {
  const { userId, sourceDraftId, sourceNoteId, title, body } = options;
  const findings = await runReview(options);
  const { status, gateStatus } = computeReviewStatus(findings);
  const job = await prisma.reviewJob.create({
    data: {
      userId,
      sourceDraftId: sourceDraftId ?? null,
      sourceNoteId: sourceNoteId ?? null,
      title,
      body,
      status,
      gateStatus,
      riskCount: findings.length,
      createdAt: shanghaiNow(),
      updatedAt: shanghaiNow(),
    },
  });
  await replaceFindings(job.id, findings);
  if (sourceDraftId) await syncGateToPublishJobs(sourceDraftId, gateStatus);
  // 返回落库后的风险点（含 id，供前端展示与修复操作）
  const persisted = await prisma.reviewFinding.findMany({ where: { reviewJobId: job.id }, orderBy: { id: "asc" } });
  return { job, findings: persisted };
}

/** 重建审校任务的风险点集合（复检时清空旧数据） */
async function replaceFindings(jobId: number, findings: ReviewFindingLike[]): Promise<void> {
  await prisma.reviewFinding.deleteMany({ where: { reviewJobId: jobId } });
  if (findings.length) {
    await prisma.reviewFinding.createMany({
      data: findings.map((finding) => ({
        reviewJobId: jobId,
        gate: finding.gate,
        riskType: finding.riskType,
        riskLevel: finding.riskLevel,
        snippet: finding.snippet,
        suggestion: finding.suggestion,
      })),
    });
  }
}

/** 将门禁结果同步到同一草稿下的待发布任务（发布前自动被拦截） */
export async function syncGateToPublishJobs(sourceDraftId: number, gateStatus: string): Promise<void> {
  await prisma.publishJob.updateMany({
    where: { sourceDraftId, status: { in: ["pending", "pending_approval"] } },
    data: { gateStatus },
  });
}

// ---------- R-05 梯度修复 ----------

/** 梯度修复动作定义（按风险类型选择起点） */
const FIX_ACTIONS = [
  {
    key: "disclose",
    label: "披露（添加免责声明）",
    prompt: (snippet: string) =>
      `请将原文中涉及「${snippet}」的表述改写为包含明确免责声明的个人体验分享（如「仅为个人使用体验分享，效果因人而异」），保留原文口语风格，只输出改写后的完整句子。`,
  },
  {
    key: "evidence",
    label: "证据（补充数据来源）",
    prompt: (snippet: string) =>
      `原文中「${snippet}」涉及数据/功效宣称，请改写为补充来源说明的表述（如「据××检测报告」），若无法补充则删除该数据，只输出改写后的完整句子。`,
  },
  {
    key: "narrow",
    label: "收窄断言（弱化绝对化表述）",
    prompt: (snippet: string) =>
      `原文中「${snippet}」为绝对化/夸大表述，请收窄为客观、非绝对的说法（如把「最」改为「很」，把「100%有效」改为「我个人觉得有效」），只输出改写后的完整句子。`,
  },
  {
    key: "rewrite",
    label: "最小改写（替换风险表述）",
    prompt: (snippet: string) =>
      `原文中「${snippet}」存在合规风险，请在保留原意的同时最小化改写这句话以消除风险，只输出改写后的完整句子。`,
  },
];

/** 判断某条规则是否仍命中文本（修复验证） */
function ruleStillHits(rule: ReviewRuleLike, text: string): boolean {
  return matchRule(rule, text).length > 0;
}

/** 对单条风险点执行梯度修复：按梯度依次尝试，直到对应规则不再命中 */
async function fixOneFinding(options: {
  userId: number;
  finding: ReviewFindingLike;
  rule: ReviewRuleLike | null;
  title: string;
  body: string;
  textClient: TextClientLike;
  modelConfig: ModelConfigLike;
  apiKey: string;
}): Promise<{ fixed: boolean; action: string; fixedText: string; newTitle: string; newBody: string }> {
  const { userId, finding, rule, textClient, modelConfig, apiKey } = options;
  let title = options.title;
  let body = options.body;
  // 规则型风险：梯度按 disclose → evidence → narrow → rewrite 顺序，命中即停
  const orderedActions = rule ? FIX_ACTIONS : FIX_ACTIONS.slice(2); // LLM 型风险从收窄开始
  for (const action of orderedActions) {
    try {
      const fixedText = await textClient.complete({
        modelConfig,
        apiKey,
        systemPrompt: renderPrompt("review.md", "rewrite"),
        userPrompt: action.prompt(finding.snippet),
        temperature: 0.3,
        onUsage: makeUsageLogger(userId, modelConfig.modelName, "text"), // S-06 用量采集
      });
      const cleaned = fixedText.trim().replace(/^["'「「]|["'」」]$/g, "");
      if (!cleaned || cleaned.length > 2000) continue;
      // 应用到原文（原文包含片段则替换片段，否则替换整句所在行）
      const applied = applyFixText(title, body, finding.snippet, cleaned);
      title = applied.title;
      body = applied.body;
      if (rule) {
        // 规则型：验证规则不再命中
        if (!ruleStillHits(rule, `${title}\n${body}`)) {
          return { fixed: true, action: action.key, fixedText: cleaned, newTitle: title, newBody: body };
        }
      } else {
        // LLM 型：改写完成即视为已修复（最终复检兜底）
        return { fixed: true, action: action.key, fixedText: cleaned, newTitle: title, newBody: body };
      }
    } catch (error) {
      console.warn(`[review] 修复动作 ${action.key} 失败: ${(error as Error).message}`);
    }
  }
  return { fixed: false, action: "", fixedText: "", newTitle: title, newBody: body };
}

/** 将修复文本应用到标题/正文（优先替换片段，否则替换所在行） */
export function applyFixText(title: string, body: string, snippet: string, fixedText: string): { title: string; body: string } {
  if (title.includes(snippet)) return { title: title.replace(snippet, fixedText), body };
  if (body.includes(snippet)) return { title, body: body.replace(snippet, fixedText) };
  // 片段未精确命中（LLM 转述），替换含片段关键词的行
  const keyword = snippet.slice(0, 4);
  if (keyword && body.includes(keyword)) {
    const lines = body.split("\n");
    const nextLines = lines.map((line) => (line.includes(keyword) ? line.replace(line, fixedText) : line));
    return { title, body: nextLines.join("\n") };
  }
  return { title, body };
}

/** 自动修复：逐条梯度修复 → 全部完成后重新审校 → 更新任务状态 */
export async function autoFixJob(options: {
  jobId: number;
  textClient: TextClientLike;
  modelConfig: ModelConfigLike;
  apiKey: string;
}) {
  const { jobId, textClient, modelConfig, apiKey } = options;
  const job = await prisma.reviewJob.findUnique({
    where: { id: jobId },
    include: { findings: { orderBy: { id: "asc" } } },
  });
  if (!job) throw new Error("Review job not found");

  let title = job.title;
  let body = job.body;
  const rules = await loadRules(job.userId);

  for (const finding of job.findings) {
    if (finding.fixed) continue;
    const rule = rules.find((item) => item.ruleType === finding.riskType) ?? null;
    const result = await fixOneFinding({
      userId: job.userId,
      finding: { gate: finding.gate, riskType: finding.riskType, riskLevel: finding.riskLevel, snippet: finding.snippet, suggestion: finding.suggestion },
      rule,
      title,
      body,
      textClient,
      modelConfig,
      apiKey,
    });
    title = result.newTitle;
    body = result.newBody;
    await prisma.reviewFinding.update({
      where: { id: finding.id },
      data: { fixed: result.fixed, fixAction: result.action, fixedText: result.fixedText },
    });
  }

  // 复检：对修复后内容重新执行完整审校
  const findings = await runReview({
    userId: job.userId,
    sourceDraftId: job.sourceDraftId,
    sourceNoteId: job.sourceNoteId,
    title,
    body,
    textClient,
    modelConfig,
    apiKey,
  });
  const { status, gateStatus } = computeReviewStatus(findings);
  const updated = await prisma.reviewJob.update({
    where: { id: job.id },
    data: { title, body, status, gateStatus, riskCount: findings.length, updatedAt: shanghaiNow() },
  });
  await replaceFindings(job.id, findings);
  if (job.sourceDraftId) await syncGateToPublishJobs(job.sourceDraftId, gateStatus);
  const persisted = await prisma.reviewFinding.findMany({ where: { reviewJobId: job.id }, orderBy: { id: "asc" } });
  return { job: updated, findings: persisted };
}

// ---------- 序列化 ----------

export function serializeReviewFinding(finding: {
  id: number;
  gate: string;
  riskType: string;
  riskLevel: string;
  snippet: string;
  suggestion: string;
  fixed: boolean;
  fixAction: string;
  fixedText: string;
}): Record<string, unknown> {
  return {
    id: finding.id,
    gate: finding.gate,
    risk_type: finding.riskType,
    risk_level: finding.riskLevel,
    snippet: finding.snippet,
    suggestion: finding.suggestion,
    fixed: finding.fixed,
    fix_action: finding.fixAction,
    fixed_text: finding.fixedText,
  };
}

export function serializeReviewJob(job: {
  id: number;
  sourceDraftId: number | null;
  sourceNoteId: number | null;
  title: string;
  body: string;
  status: string;
  gateStatus: string;
  riskCount: number;
  createdAt: Date;
  updatedAt: Date;
}, findings: unknown[] = []): Record<string, unknown> {
  return {
    id: job.id,
    source_draft_id: job.sourceDraftId,
    source_note_id: job.sourceNoteId,
    title: job.title,
    body: job.body,
    status: job.status,
    gate_status: job.gateStatus,
    risk_count: job.riskCount,
    findings: findings as Record<string, unknown>[],
    created_at: formatDateTime(job.createdAt),
    updated_at: formatDateTime(job.updatedAt),
  };
}

/** Prisma 审校任务查询结果类型（含 findings） */
export type ReviewJobWithFindings = Prisma.ReviewJobGetPayload<{ include: { findings: true } }>;
