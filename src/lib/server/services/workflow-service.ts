/**
 * 工作流编排服务（AI Agent 平台 S-04 / S-03）
 *
 * 设计：Agent = 有序 Skill 步骤列表；每个 Skill 映射到现有服务函数（工具注册表）。
 * 步骤输出以 JSON 存入对应子任务 payload，并可按 {stepId.字段} 引用注入后续步骤参数。
 * 任务状态复用 tasks 表（父任务 workflow_run + 子任务 step），前端可轮询。
 *
 * 预置工作流（Phase 3 代码固化，可视化编排后续扩展）：
 *   standard_production 标准内容生产流：选题 → 文案 → 审校
 *   hot_trend 热点追更流：热点刷新 → 选题 → 文案 → 审校
 *   batch_production 批量生产流：批量选题 → 文案 → 审校（首个选题）
 */
import type { Prisma, Task } from "@prisma/client";
import { prisma } from "../core/db";
import { decryptText } from "../core/security";
import { formatDateTime, shanghaiNow } from "../core/time";
import { OpenAICompatibleTextClient } from "./ai-service";
import { getTextModelForUser } from "./scheduler-service";
import type { ModelConfigLike } from "./ai-service";
import { SKILL_CATALOG, executeSkill, type SkillContext } from "../agent/skill-catalog";

// 技能目录与执行器已抽取至 agent/skill-catalog（无 Pi 依赖），此处再导出以保持原有引用路径可用
export { SKILL_CATALOG, findSkillDefinition, type SkillDefinition } from "../agent/skill-catalog";

/** 确保用户技能注册表已初始化（幂等写入种子数据，并为存量记录补齐指令正文） */
export async function ensureUserSkills(userId: number): Promise<number> {
  await prisma.skillRegistry.createMany({
    data: SKILL_CATALOG.map((skill) => ({
      userId,
      skillKey: skill.skillKey,
      name: skill.name,
      description: skill.description,
      paramsSchema: skill.paramsSchema as Prisma.InputJsonValue,
      instructions: skill.instructions,
      createdAt: shanghaiNow(),
    })),
    skipDuplicates: true,
  });
  // 存量记录（instructions 为空）补齐预置指令正文
  await prisma.$transaction(
    SKILL_CATALOG.map((skill) =>
      prisma.skillRegistry.updateMany({
        where: { userId, skillKey: skill.skillKey, instructions: "" },
        data: { instructions: skill.instructions },
      }),
    ),
  );
  return prisma.skillRegistry.count({ where: { userId } });
}

/** 技能序列化（含指令正文） */
export function serializeSkill(skill: {
  id: number;
  skillKey: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: skill.id,
    skill_key: skill.skillKey,
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    enabled: skill.enabled,
    created_at: formatDateTime(skill.createdAt),
  };
}

/** 创建自定义技能（skillKey 用户级唯一） */
export async function createUserSkill(options: {
  userId: number;
  skillKey: string;
  name: string;
  description: string;
  instructions: string;
}): Promise<Record<string, unknown>> {
  const { userId, skillKey, name, description, instructions } = options;
  const normalizedKey = skillKey.trim();
  if (!normalizedKey) throw new Error("技能标识（skill_key）不能为空");
  const existed = await prisma.skillRegistry.findFirst({ where: { userId, skillKey: normalizedKey } });
  if (existed) throw new Error(`技能标识 ${normalizedKey} 已存在`);
  const skill = await prisma.skillRegistry.create({
    data: {
      userId,
      skillKey: normalizedKey,
      name: name.trim() || normalizedKey,
      description: description.trim(),
      paramsSchema: { type: "object", properties: {} },
      instructions,
      createdAt: shanghaiNow(),
    },
  });
  return serializeSkill(skill);
}

/** 更新技能（名称/描述/指令正文/启停，仅限本人） */
export async function updateUserSkill(
  userId: number,
  skillId: number,
  patch: { name?: string; description?: string; instructions?: string; enabled?: boolean },
): Promise<Record<string, unknown>> {
  const skill = await prisma.skillRegistry.findFirst({ where: { id: skillId, userId } });
  if (!skill) throw new Error("技能不存在");
  const updated = await prisma.skillRegistry.update({
    where: { id: skillId },
    data: {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
      ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    },
  });
  return serializeSkill(updated);
}

/** 删除技能（仅限本人） */
export async function deleteUserSkill(userId: number, skillId: number): Promise<void> {
  const skill = await prisma.skillRegistry.findFirst({ where: { id: skillId, userId } });
  if (!skill) throw new Error("技能不存在");
  await prisma.skillRegistry.delete({ where: { id: skillId } });
}

// ---------- 工作流定义（预置） ----------

export interface WorkflowStepDef {
  id: string; // 步骤 ID（如 "s1"），输出可被后续步骤以 {s1.字段} 引用
  skillKey: string;
  name: string;
  params: Record<string, unknown>; // 静态参数 + {s1.字段} 占位符
}

export interface WorkflowDefinition {
  workflowKey: string;
  name: string;
  description: string;
  steps: WorkflowStepDef[];
}

export const PREBUILT_WORKFLOWS: WorkflowDefinition[] = [
  {
    workflowKey: "standard_production",
    name: "标准内容生产流",
    description: "选题 → 文案 → 审校：一条内容的完整生产链路",
    steps: [
      { id: "s1", skillKey: "topic.generate", name: "生成选题", params: { count: 5 } },
      { id: "s2", skillKey: "content.notePack", name: "生成文案包", params: { topic: "{s1.titles.0}" } },
      { id: "s3", skillKey: "review.submit", name: "内容审校", params: { draft_id: "{s2.draft_id}" } },
    ],
  },
  {
    workflowKey: "hot_trend",
    name: "热点追更流",
    description: "热点刷新 → 选题 → 文案 → 审校：快速追热点",
    steps: [
      { id: "s1", skillKey: "hot.refresh", name: "刷新热点", params: {} },
      { id: "s2", skillKey: "topic.generate", name: "生成选题", params: { count: 5 } },
      { id: "s3", skillKey: "content.notePack", name: "生成文案包", params: { topic: "{s2.titles.0}" } },
      { id: "s4", skillKey: "review.submit", name: "内容审校", params: { draft_id: "{s3.draft_id}" } },
    ],
  },
  {
    workflowKey: "batch_production",
    name: "批量生产流",
    description: "批量选题 → 首个选题文案 → 审校（批量扩展后续）",
    steps: [
      { id: "s1", skillKey: "topic.generate", name: "批量生成选题", params: { count: 10 } },
      { id: "s2", skillKey: "content.notePack", name: "生成文案包", params: { topic: "{s1.titles.0}" } },
      { id: "s3", skillKey: "review.submit", name: "内容审校", params: { draft_id: "{s2.draft_id}" } },
    ],
  },
];

/** 解析参数中的 {stepId.字段} 占位符（支持 a.b.c 路径） */
export function resolveStepParams(params: Record<string, unknown>, outputs: Map<string, Record<string, unknown>>): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      resolved[key] = value.replace(/\{(\w+)\.([\w.]+)\}/g, (_match, stepId: string, path: string) => {
        const output = outputs.get(stepId);
        if (!output) return _match;
        const parts = path.split(".");
        let current: unknown = output;
        for (const part of parts) {
          if (current && typeof current === "object") {
            current = (current as Record<string, unknown>)[part];
          } else {
            return _match;
          }
        }
        return current !== undefined ? String(current) : _match;
      });
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

// ---------- 技能执行器 ----------

export interface StepOutput {
  skillKey: string;
  status: string; // completed/failed
  output: Record<string, unknown>;
  error?: string;
}

// ---------- 工作流执行 ----------

export interface WorkflowRunResult {
  workflowKey: string;
  steps: StepOutput[];
  status: string;
}

/** 执行预置工作流：按步骤依次执行，输出落子任务 payload */
export async function runWorkflow(options: { userId: number; workflowKey: string; extraParams?: Record<string, unknown> }): Promise<WorkflowRunResult> {
  const { userId, workflowKey, extraParams = {} } = options;
  const definition = PREBUILT_WORKFLOWS.find((workflow) => workflow.workflowKey === workflowKey);
  if (!definition) throw new Error(`未知工作流: ${workflowKey}`);

  await ensureUserSkills(userId);
  const [modelConfig, apiKey] = await getTextModelForUser(userId);
  const context: SkillContext = {
    userId,
    textClient: new OpenAICompatibleTextClient(),
    modelConfig: modelConfig ? (modelConfig as unknown as ModelConfigLike) : null,
    apiKey,
  };

  const parentTask = await prisma.task.create({
    data: {
      userId,
      platform: "xhs",
      taskType: "workflow_run",
      status: "running",
      progress: 0,
      payload: { workflow_key: workflowKey, workflow_name: definition.name } as Prisma.InputJsonValue,
      createdAt: shanghaiNow(),
    },
  });

  const outputs = new Map<string, Record<string, unknown>>();
  const steps: StepOutput[] = [];
  let failed = false;

  for (let index = 0; index < definition.steps.length; index++) {
    const step = definition.steps[index];
    const stepTask = await prisma.task.create({
      data: {
        userId,
        platform: "xhs",
        taskType: `workflow_step:${step.skillKey}`,
        status: "running",
        progress: 10,
        payload: { workflow_run_id: parentTask.id, step_id: step.id } as Prisma.InputJsonValue,
        parentTaskId: parentTask.id,
        createdAt: shanghaiNow(),
      },
    });
    try {
      const mergedParams = { ...resolveStepParams(step.params, outputs), ...(index === 0 ? extraParams : {}) };
      const output = await executeSkill(step.skillKey, mergedParams, context);
      outputs.set(step.id, output);
      steps.push({ skillKey: step.skillKey, status: "completed", output });
      await prisma.task.update({
        where: { id: stepTask.id },
        data: { status: "completed", progress: 100, payload: { ...(stepTask.payload as Record<string, unknown>), output } as Prisma.InputJsonValue },
      });
    } catch (error) {
      failed = true;
      const message = (error as Error).message;
      steps.push({ skillKey: step.skillKey, status: "failed", output: {}, error: message });
      await prisma.task.update({
        where: { id: stepTask.id },
        data: { status: "failed", progress: 100, payload: { ...(stepTask.payload as Record<string, unknown>), error: message } as Prisma.InputJsonValue },
      });
      break; // 任一步失败即终止
    }
    await prisma.task.update({
      where: { id: parentTask.id },
      data: { progress: Math.round(((index + 1) / definition.steps.length) * 100) },
    });
  }

  await prisma.task.update({
    where: { id: parentTask.id },
    data: {
      status: failed ? "failed" : "completed",
      progress: 100,
      payload: { workflow_key: workflowKey, workflow_name: definition.name, step_count: steps.length, failed } as Prisma.InputJsonValue,
    },
  });

  return { workflowKey, steps, status: failed ? "failed" : "completed" };
}

/** 序列化预置工作流（含技能步骤说明） */
export function serializeWorkflow(workflow: WorkflowDefinition): Record<string, unknown> {
  return {
    workflow_key: workflow.workflowKey,
    name: workflow.name,
    description: workflow.description,
    steps: workflow.steps.map((step) => ({
      id: step.id,
      skill_key: step.skillKey,
      name: step.name,
      params: step.params,
    })),
  };
}

export function serializeTaskRun(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    task_type: task.taskType,
    status: task.status,
    progress: task.progress,
    payload: (task.payload ?? {}) as Record<string, unknown>,
    created_at: formatDateTime(task.createdAt),
    started_at: task.startedAt ? formatDateTime(task.startedAt) : null,
    finished_at: task.finishedAt ? formatDateTime(task.finishedAt) : null,
  };
}

/** 用户最近的工作流执行记录（父任务 + 子步骤） */
export async function listWorkflowRuns(userId: number, limit = 10): Promise<Array<Record<string, unknown>>> {
  const parents = await prisma.task.findMany({
    where: { userId, taskType: "workflow_run" },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 50),
  });
  const results: Array<Record<string, unknown>> = [];
  for (const parent of parents) {
    const children = await prisma.task.findMany({
      where: { parentTaskId: parent.id },
      orderBy: { id: "asc" },
    });
    results.push({
      ...serializeTaskRun(parent),
      steps: children.map((child) => ({
        task_type: child.taskType,
        status: child.status,
        output: ((child.payload ?? {}) as Record<string, unknown>).output ?? null,
        error: ((child.payload ?? {}) as Record<string, unknown>).error ?? null,
      })),
    });
  }
  return results;
}
