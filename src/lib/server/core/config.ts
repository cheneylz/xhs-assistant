/**
 * 配置系统（对应原版 backend/app/core/config.py）
 * 全部由环境变量 / .env 提供，密钥不入库
 */

export interface AppConfig {
  appName: string;
  environment: string;
  databaseUrl: string;
  secretKey: string;
  fernetKey: string;
  schedulerIntervalSeconds: number;
  cookieHealthCheckHours: number;
  /** 本地存储根目录（media / exports / downloads 的父目录） */
  storageDir: string;
  /** curl-impersonate 可执行文件路径，为空则自动探测 */
  curlImpersonateBin: string;
}

function envStr(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value === "" ? fallback : value;
}

function envInt(key: string, fallback: number): number {
  const value = process.env[key];
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

let cached: AppConfig | null = null;

/**
 * 获取全局配置（惰性加载 + 缓存，对应原版 lru_cache）
 */
export function getConfig(): AppConfig {
  if (cached) return cached;
  cached = {
    appName: "xhs-assistant",
    environment: envStr("NODE_ENV", "development"),
    databaseUrl: envStr("DATABASE_URL", "postgresql://postgres:change_me@localhost:5432/xhs_crawer"),
    secretKey: envStr("SECRET_KEY", "dev-only-change-me"),
    fernetKey: envStr("FERNET_KEY", ""),
    schedulerIntervalSeconds: envInt("SCHEDULER_INTERVAL_SECONDS", 60),
    cookieHealthCheckHours: envInt("COOKIE_HEALTH_CHECK_HOURS", 2),
    storageDir: envStr("STORAGE_DIR", "./storage"),
    curlImpersonateBin: envStr("CURL_IMPERSONATE_BIN", ""),
  };
  return cached;
}

/** 存储目录子路径 */
export function storagePath(...parts: string[]): string {
  const base = getConfig().storageDir;
  const segments = [base, ...parts].filter(Boolean);
  return segments.join("/");
}

/** 重置配置缓存（测试用：修改环境变量后重新加载） */
export function resetConfig(): void {
  cached = null;
}
