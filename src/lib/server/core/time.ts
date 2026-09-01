/**
 * 时间工具（对应原版 backend/app/core/time.py）
 *
 * 全局约定：数据库存储「上海时区 naive datetime」。
 * 实现方式：shanghaiNow() 生成的 Date，其 UTC 字段值（getUTCHours 等）即上海墙钟时间，
 * 序列化与解析均不做时区换算，仅做格式化。
 */

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 当前上海墙钟时间（naive 语义） */
export function shanghaiNow(): Date {
  return new Date(Date.now() + SHANGHAI_OFFSET_MS);
}

/** 上海时间下的日期字符串 YYYY-MM-DD */
export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = toDate(d);
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/** 上海时间下的日期时间字符串 YYYY-MM-DDTHH:mm:ss（与原版 Pydantic 序列化格式一致） */
export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = toDate(d);
  return `${formatDate(date)}T${[
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0"),
  ].join(":")}`;
}

/** 上海时间下的时分字符串 HH:mm */
export function formatTime(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = toDate(d);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function toDate(d: Date | string): Date {
  return typeof d === "string" ? new Date(d) : d;
}

/**
 * 解析「naive 上海时间」字符串为 Date（naive 语义，不做时区换算）。
 * 支持 "2026-08-21T09:00" / "2026-08-21T09:00:00" / "2026-08-21 09:00" 等格式。
 * 解析失败返回 null。
 */
export function parseNaiveDateTime(value: string): Date | null {
  if (!value) return null;
  let normalized = value.trim().replace(" ", "T");
  // 补足秒与毫秒
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) normalized += ":00";
  if (!normalized.endsWith("Z")) normalized += "Z";
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}
