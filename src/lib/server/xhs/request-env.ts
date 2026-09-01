/**
 * XHS 请求环境（对应原版 backend/app/adapters/xhs/request_env.py）
 * SDK 调用期间清除可能损坏的本地代理环境变量（串行保护）
 */
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

let proxyLock: Promise<void> = Promise.resolve();

/** 运行 XHS SDK 调用而不继承本地（可能损坏的）代理配置 */
export async function withDirectXhsRequestEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previous = proxyLock;
  let release!: () => void;
  proxyLock = new Promise<void>((resolve) => (release = resolve));
  await previous;

  const original: Record<string, string | undefined> = {};
  for (const key of PROXY_ENV_KEYS) {
    original[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of PROXY_ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    release();
  }
}

/** 同步版本（curl-impersonate 子进程场景，当前未使用） */
export function withDirectXhsRequestEnvSync(fn: () => void): void {
  const original: Record<string, string | undefined> = {};
  for (const key of PROXY_ENV_KEYS) {
    original[key] = process.env[key];
    delete process.env[key];
  }
  try {
    fn();
  } finally {
    for (const key of PROXY_ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}
