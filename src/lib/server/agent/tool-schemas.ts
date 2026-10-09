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
  "hot.refresh": Type.Object({}, { description: "热点采集无需参数" }),

  "topic.generate": Type.Object({
    count: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 20,
        default: 5,
        description: "生成选题数量，默认 5，最多 20",
      }),
    ),
  }),

  "content.notePack": Type.Object({
    topic: Type.String({ minLength: 1, description: "选题标题，必填" }),
  }),

  "review.submit": Type.Object({
    draft_id: Type.Integer({ minimum: 1, description: "待审校的草稿 ID，必填" }),
  }),

  "script.generate": Type.Object({
    draft_id: Type.Integer({ minimum: 1, description: "生成视频脚本的草稿 ID，必填" }),
  }),

  "schedule.recommend": Type.Object({
    platform_account_id: Type.Integer({ minimum: 1, description: "发布账号 ID，必填" }),
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
