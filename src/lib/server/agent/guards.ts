/**
 * Agent 护栏
 *
 * 1. 工具准入分级：read/write 放行，publish 阻断，未注册的工具 fail-closed 阻断
 * 2. 连续工具失败计数：达到阈值触发优雅停止
 *
 * 【本文件不含 Pi 依赖】—— 可被 Next.js 侧安全 import。
 */
import { findSkillDefinition } from "./skill-catalog";

export interface ToolGuardResult {
  allowed: boolean;
  /** 被阻断时给模型看的说明 */
  reason?: string;
}

/**
 * 判断某个工具是否允许执行。
 *
 * 采用 fail-closed：只有明确登记在技能目录里的 read/write 级工具才放行。
 * 理由：Agent 的工具清单完全由 SKILL_CATALOG 生成（buildAgentTools），
 * 模型看不到目录外的任何工具，因此出现未知名称必为模型幻觉。放行只会让
 * 它在更深一层炸出运行时异常，不如在此给出可读的阻断原因。
 */
export function checkToolAllowed(skillKey: string): ToolGuardResult {
  const definition = findSkillDefinition(skillKey);
  if (!definition) {
    return {
      allowed: false,
      reason: `工具「${skillKey}」未在技能目录中注册，不可调用。请只使用已提供的工具。`,
    };
  }
  if (definition.riskLevel === "publish") {
    return {
      allowed: false,
      reason: `工具「${definition.name}」属于发布类操作，需人工确认后才能执行，当前版本未开放。`,
    };
  }
  return { allowed: true };
}

export interface FailureRecord {
  /** 当前连续失败次数 */
  count: number;
  /** 是否已达到阈值 */
  exceeded: boolean;
}

export interface FailureTracker {
  record(succeeded: boolean): FailureRecord;
  readonly count: number;
}

/**
 * 连续失败计数器：成功一次即归零。
 *
 * 阈值下限为 1（在此钳制，而非依赖调用方）：阈值为 0 时 `count >= 0` 恒真，
 * 会把**成功**的调用也判为超限，导致第一次工具调用就中止循环。
 * 在函数内钳制可让这条保证不依赖每个调用方都记得钳制。
 */
export function createFailureTracker(maxFailures: number): FailureTracker {
  let count = 0;
  const threshold = Math.max(1, maxFailures);
  return {
    record(succeeded: boolean): FailureRecord {
      count = succeeded ? 0 : count + 1;
      return { count, exceeded: count >= threshold };
    },
    get count(): number {
      return count;
    },
  };
}
