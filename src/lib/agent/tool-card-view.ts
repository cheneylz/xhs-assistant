/**
 * 工具卡的展示派生（纯函数，D25：可被 vitest 覆盖的视图逻辑）
 *
 * 放在 lib/agent/ 下与 agent-state.ts 并列：本文件不含 React / 服务端依赖，客户端可安全 import。
 * 抽出来的理由：状态映射的兜底分支在编译期抓不到（Record<string, …>），截断/序列化有多处边界，
 * 而「4 种状态可辨识」是 §7.2 第 3 条的验收项 —— 需要自动化守卫（Task 8 质量审查建议）。
 */
import type { AgentToolCard } from "./agent-state";

/**
 * 详情区展示上限（首屏的 result 已由服务端按**紧凑 JSON** 截到 4000 字符；
 * 这里的 4000 是**pretty-print 后**的字符数 —— 两者口径不同，不要「顺手统一」）。
 */
export const DETAIL_TEXT_LIMIT = 4000;

export interface ToolStatusView {
  color: string;
  label: string;
}

/** 状态 → 展示：4 种状态都必须可辨识（§7.2 第 3 条）；新增状态要在这里补一行 */
const STATUS_VIEW: Record<string, ToolStatusView> = {
  running: { color: "processing", label: "运行中" },
  succeeded: { color: "success", label: "成功" },
  failed: { color: "error", label: "失败" },
  blocked: { color: "warning", label: "被阻断" },
};

export function statusViewFor(status: string): ToolStatusView {
  return STATUS_VIEW[status] ?? { color: "default", label: status || "未知" };
}

/** 耗时（毫秒）→ 「1.2s」；非数字返回 null（不显示）—— 不用 `!== null` 判，防 undefined 漏进来变成「NaNs」 */
export function formatToolDuration(durationMs: number | null | undefined): string | null {
  return typeof durationMs === "number" ? `${(durationMs / 1000).toFixed(1)}s` : null;
}

/** 截断到上限；截断点落在代理对中间时退一格，避免渲染出 U+FFFD */
export function cutForDisplay(text: string, limit: number = DETAIL_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…（已省略）`;
}

/** 任意产出 → 展示文本 */
export function stringifyForDisplay(value: Record<string, unknown> | null): string {
  if (!value) return "（无）";
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    // 理论上到不了（值都来自 JSON.parse）；兜一手是因为页面没有 error boundary，
    // 一次序列化异常会让整个工作台白屏
    return "（无法序列化）";
  }
  return cutForDisplay(text);
}

/**
 * 结果的展示文本。
 * 服务端截断时 result 是 `{ truncated_text: <紧凑 JSON 的前 4000 字符> }` ——
 * 直接展示那串文本：再 stringify 一次会多一层转义、并暴露内部字段名
 * （Task 8 质量审查发现的实际渲染问题）。
 */
export function resultTextForDisplay(tool: AgentToolCard): string {
  if (tool.resultTruncated && typeof tool.result?.truncated_text === "string") {
    return tool.result.truncated_text;
  }
  return stringifyForDisplay(tool.result);
}
