/**
 * 工具入参 schema（TypeBox）
 *
 * Pi Agent 用 TypeBox 做工具入参校验（AgentTool.parameters: TSchema）。
 * SKILL_CATALOG 里的 paramsSchema 是展示用的裸 JSON Schema，约束过松：
 * 无 required、无上下限，缺失必填参数也能通过校验，直接拿来当校验边界会静默放行非法入参。
 * 因此在此用 TypeBox 重建为带约束的入参 schema，作为唯一的校验边界。
 *
 * 【本文件不含 Pi 依赖】—— typebox 是独立校验库（Pi 依赖的也是同一个 typebox 包）。
 */
import { Type, type TSchema } from "typebox";
import { SKILL_CATALOG } from "./skill-catalog";

/** skillKey → TypeBox 入参 schema */
export const TOOL_SCHEMAS: Record<string, TSchema> = {
  "hot_refresh": Type.Object({}, { description: "热点采集无需参数" }),

  "topic_generate": Type.Object({
    count: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 20,
        default: 5,
        description: "生成选题数量，默认 5，最多 20",
      }),
    ),
  }),

  "content_note_pack": Type.Object({
    topic: Type.String({ minLength: 1, description: "选题标题，必填" }),
  }),

  "review_submit": Type.Object({
    draft_id: Type.Integer({ minimum: 1, description: "待审校的草稿 ID，必填" }),
  }),

  "script_generate": Type.Object({
    draft_id: Type.Integer({ minimum: 1, description: "生成视频脚本的草稿 ID，必填" }),
  }),

  "schedule_recommend": Type.Object({
    platform_account_id: Type.Integer({ minimum: 1, description: "发布账号 ID，必填" }),
  }),

  "content_rewrite": Type.Object({
    draft_id: Type.Integer({ minimum: 1, description: "待改写的草稿 ID，必填" }),
    instruction: Type.Optional(Type.String({ description: "额外改写要求，如「更口语化、加 emoji」" })),
    intensity: Type.Optional(
      Type.Union([Type.Literal("light"), Type.Literal("medium"), Type.Literal("deep")], {
        description: "改写强度，默认 medium",
      }),
    ),
  }),

  "content_titles": Type.Object({
    title: Type.String({ minLength: 1, description: "原标题，必填" }),
    body: Type.Optional(Type.String({ description: "正文内容，越完整生成的标题越贴合" })),
    count: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 10, default: 5, description: "标题数量，默认 5，最多 10" }),
    ),
  }),

  "content_tags": Type.Object({
    title: Type.String({ minLength: 1, description: "标题，必填" }),
    body: Type.Optional(Type.String({ description: "正文内容" })),
    count: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 20, default: 8, description: "标签数量，默认 8，最多 20" }),
    ),
  }),

  "analytics_reports": Type.Object({
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 20, default: 5, description: "读取最近几份拆解报告，默认 5，最多 20" }),
    ),
  }),

  "kb_get": Type.Object({}, { description: "知识库读取无需参数" }),

  "library_search_notes": Type.Object({
    keyword: Type.Optional(Type.String({ description: "关键词，匹配标题/正文/作者/笔记 ID" })),
    tag_id: Type.Optional(Type.Integer({ minimum: 1, description: "按标签 ID 过滤" })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 20, default: 10, description: "返回条数，默认 10，最多 20" }),
    ),
  }),

  "library_note_detail": Type.Object({
    note_id: Type.Integer({ minimum: 1, description: "笔记 ID（内容库主键，不是小红书 note_id），必填" }),
    comment_limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 200, default: 20, description: "最多返回多少条评论，默认 20" }),
    ),
  }),
};

/** 启动时断言：SKILL_CATALOG 与 TOOL_SCHEMAS 必须一一对应，避免漏配 */
export function assertSchemasComplete(): void {
  for (const item of SKILL_CATALOG) {
    if (!TOOL_SCHEMAS[item.skillKey]) {
      throw new Error(`技能 ${item.skillKey} 缺少 TypeBox schema，请在 tool-schemas.ts 中补齐`);
    }
  }
  const catalogKeys = new Set(SKILL_CATALOG.map((item) => item.skillKey));
  for (const key of Object.keys(TOOL_SCHEMAS)) {
    if (!catalogKeys.has(key)) {
      throw new Error(`TOOL_SCHEMAS 中的 ${key} 不在 SKILL_CATALOG 里，请检查拼写`);
    }
  }
}

/** 取指定技能的 schema，缺失时抛错 */
export function getToolSchema(skillKey: string): TSchema {
  const schema = TOOL_SCHEMAS[skillKey];
  if (!schema) throw new Error(`技能 ${skillKey} 缺少 TypeBox schema`);
  return schema;
}

/**
 * 供应商对工具名的硬约束：OpenAI 兼容接口的 `tools[].function.name` 只接受
 * `^[a-zA-Z0-9_-]+$`（Anthropic 的工具名也是同一字符集）。
 *
 * 这是端到端验收实测撞到的：skillKey 原本用点号做命名空间（如 `topic.generate`），
 * 发给模型时被 provider 直接 400 拒绝 —— "Invalid 'tools[0].function.name':
 * string does not match pattern"。且失败发生在**请求阶段**，表现为模型返回
 * stopReason="error"，日志里看着像「模型请求失败」，很难一眼看出真因是工具名非法。
 * 因此在组装工具前提前断言，把运行时的 400 变成启动时可定位的报错。
 */
export const PROVIDER_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * 断言工具名可安全发给供应商。
 * 不传参数时校验整个 SKILL_CATALOG（启动路径）；也可传入名称列表做单点校验。
 */
export function assertToolNamesProviderSafe(names: string[] = SKILL_CATALOG.map((item) => item.skillKey)): void {
  for (const name of names) {
    if (!PROVIDER_TOOL_NAME_PATTERN.test(name)) {
      throw new Error(
        `工具名「${name}」不符合供应商要求：仅允许字母、数字、下划线与连字符（${PROVIDER_TOOL_NAME_PATTERN}）。` +
          `带点号等字符的名称会被模型接口以 400 拒绝。`,
      );
    }
  }
}
