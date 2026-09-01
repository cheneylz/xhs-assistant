/**
 * curl-impersonate 传输封装（对应原版 curl_cffi 的 TLS/HTTP2 指纹模拟）
 *
 * 设计说明（重构文档 §6 风险 1）：
 * - 优先使用 curl-impersonate 二进制（child_process 调用，chrome146 指纹 + 强制 header 顺序）
 * - 本机未安装二进制时降级为 Node 原生 fetch（签名与业务逻辑不受影响，
 *   但 TLS 指纹保真度需在真实环境用 curl-impersonate 验证 —— 见 PoC 清单）
 * - 二进制路径：环境变量 CURL_IMPERSONATE_BIN，或自动探测 PATH / 常见安装目录
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { getConfig } from "../core/config";

export interface ImpersonateRequestOptions {
  url: string;
  method?: string;
  /** 有序 headers（键名小写），顺序即发送顺序 */
  headers?: Record<string, string>;
  body?: Buffer | string | null;
  /** 指纹档位（curl-impersonate 二进制名，如 chrome116） */
  impersonate?: string;
  httpVersion?: string;
  timeoutMs?: number;
  /** 是否允许降级到 fetch */
  allowFallback?: boolean;
}

export interface ImpersonateResponse {
  status: number;
  /** 响应头（键名小写，保序） */
  headers: [string, string][];
  body: Buffer;
  url: string;
  /** 实际使用的后端：'curl-impersonate' | 'fetch' */
  backend: string;
}

const IMPERSONATE_BIN_CANDIDATES = [
  "curl_chrome146",
  "curl_chrome131",
  "curl_chrome124",
  "curl_chrome120",
  "curl_chrome116",
  "curl_impersonate",
];

let cachedBinary: string | null = null;
let binaryProbed = false;

/** 探测 curl-impersonate 二进制路径（缓存结果） */
export function findImpersonateBinary(): string | null {
  if (binaryProbed) return cachedBinary;
  const configured = getConfig().curlImpersonateBin;
  if (configured && existsSync(configured)) {
    cachedBinary = configured;
    binaryProbed = true;
    return cachedBinary;
  }
  // 环境 PATH 探测
  const pathDirs = (process.env.PATH ?? "").split(";").filter(Boolean);
  const extraDirs = ["bin", "vendor/bin", "./bin", "C:/tools"];
  const candidates = [
    ...pathDirs.flatMap((dir) => IMPERSONATE_BIN_CANDIDATES.map((name) => `${dir}/${name}${process.platform === "win32" ? ".exe" : ""}`)),
    ...extraDirs.flatMap((dir) => IMPERSONATE_BIN_CANDIDATES.map((name) => `${dir}/${name}${process.platform === "win32" ? ".exe" : ""}`)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedBinary = candidate;
      binaryProbed = true;
      return cachedBinary;
    }
  }
  cachedBinary = null;
  binaryProbed = true;
  return null;
}

/** 执行 curl-impersonate 请求；二进制不可用时抛错（由调用方决定是否降级） */
export function impersonateRequest(options: ImpersonateRequestOptions): Promise<ImpersonateResponse> {
  const binary = findImpersonateBinary();
  if (!binary) {
    if (options.allowFallback === false) {
      return Promise.reject(new Error("curl-impersonate binary not found"));
    }
    return fetchFallback(options);
  }
  const impersonate = options.impersonate ?? "chrome146";
  // 二进制名可能固定为 curl_chrome116，通过 --impersonate 参数切换档位（新版支持）
  const args: string[] = ["-sS", "--max-time", String(Math.ceil((options.timeoutMs ?? 30000) / 1000))];
  if (options.httpVersion === "v2tls" || options.httpVersion === "http2") {
    args.push("--http2");
  }
  args.push("-X", options.method ?? "GET");
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    args.push("-H", `${name}: ${value}`);
  }
  if (options.body !== null && options.body !== undefined) {
    args.push("--data-binary", "@-");
  }
  // 输出分隔标记 + JSON 元数据，便于解析
  args.push("-D", "-", "-w", "\n__META__%{json}", "-o", "-", options.url);

  return new Promise((resolve, reject) => {
    const proc = execFile(
      binary,
      [...args, "--impersonate", impersonate],
      { maxBuffer: 512 * 1024 * 1024, timeout: options.timeoutMs ?? 30000 },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          reject(new Error(`curl-impersonate failed: ${stderr.slice(0, 500)}`));
          return;
        }
        try {
          resolve(parseCurlOutput(stdout, options.url, "curl-impersonate"));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
    if (options.body !== null && options.body !== undefined) {
      proc.stdin?.write(options.body);
      proc.stdin?.end();
    }
  });
}

/** 解析 curl 输出（响应头 + 正文 + %{json} 元数据） */
function parseCurlOutput(stdout: string, url: string, backend: string): ImpersonateResponse {
  const metaMarker = "\n__META__";
  const markerIndex = stdout.lastIndexOf(metaMarker);
  const headersText = markerIndex >= 0 ? stdout.slice(0, markerIndex) : stdout;
  let body = markerIndex >= 0 ? stdout.slice(markerIndex + metaMarker.length) : "";
  // 分离响应头与正文（以空行分隔）
  let status = 200;
  const headerLines: string[] = [];
  const split = headersText.split("\r\n\r\n");
  const rawHeaders = split[0] ?? "";
  body = markerIndex >= 0 ? body : split.slice(1).join("\r\n\r\n");
  for (const line of rawHeaders.split("\r\n")) {
    if (!line) continue;
    if (/^HTTP\//.test(line)) {
      const match = line.match(/^HTTP\/\S+\s+(\d{3})/);
      if (match) status = Number.parseInt(match[1], 10);
      continue;
    }
    headerLines.push(line);
  }
  const headers = headerLines.map((line) => {
    const index = line.indexOf(":");
    return index < 0 ? [line.toLowerCase(), ""] : [line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()];
  }) as [string, string][];
  return { status, headers, body: Buffer.from(body, "utf-8"), url, backend };
}

/** 降级后端：Node 原生 fetch（保留 header 顺序尽力而为） */
async function fetchFallback(options: ImpersonateRequestOptions): Promise<ImpersonateResponse> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers.set(name, value);
  }
  const bodyInit = typeof options.body === "string" ? options.body : options.body ? new Uint8Array(options.body) : undefined;
  const response = await fetch(options.url, {
    method: options.method ?? "GET",
    headers,
    body: bodyInit,
    redirect: "follow",
    signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
  });
  const body = Buffer.from(await response.arrayBuffer());
  const headersList: [string, string][] = [];
  response.headers.forEach((value, name) => headersList.push([name, value]));
  return {
    status: response.status,
    headers: headersList,
    body,
    url: response.url,
    backend: "fetch",
  };
}
