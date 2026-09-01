/**
 * 签名 JS 运行时桥接（对应原版 xhs_core/runtime.py + xhs_pc/runtime.py）
 *
 * 与 Python 版的关键差异：不再通过 Node 子进程执行 JS，而是直接 require 原 JS 文件，
 * 消除 subprocess 开销。输出门禁逻辑与 Python 版逐条对齐（保证签名产物一致）。
 *
 * 唯一保留子进程的是 websectiga_cli.js —— 它执行服务端下发的 JSVMP 脚本（不可信代码），
 * 且该 CLI 在模块顶层读取 stdin，无法直接 require；子进程同时提供天然沙箱隔离。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

// JS 文件目录（本文件位于 src/lib/server/xhs/core/，js 在 ../js/）
const JS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "js");

/** PC x-rap-param 指纹模板（对应 rap_fingerprint_template.json） */
const rapTemplate = require("../js/pc/rap_fingerprint_template.json") as { bodyUnmaskedHex: string };

/** PC 档位门禁（对应 xhs_pc/runtime.py _TIER_GATE） */
const PC_TIER_GATE: Record<string, { prefix: string; length: number }> = {
  "0101": { prefix: "mns0101_", length: 205 },
  "0201": { prefix: "mns0201_", length: 208 },
  "0301": { prefix: "mns0301_", length: 200 },
};

/** Creator 档位门禁（对应 xhs_creator/runtime.py _TIER_GATE） */
const CREATOR_TIER_GATE: Record<string, { prefix: string; lengths: number[] }> = {
  "0201": { prefix: "mns0201_", lengths: [200] },
  "0101": { prefix: "mns0101_", lengths: [196, 197, 198] },
};

type TierGate = { prefix: string; length: number } | { prefix: string; lengths: number[] };

function resolveGate(tier: string, gate: "pc" | "creator"): TierGate | null {
  if (gate === "creator") return CREATOR_TIER_GATE[tier] ?? null;
  return PC_TIER_GATE[tier] ?? null;
}

const WEBSECTIGA_RE = /^[0-9a-f]{64}$/i;
const PC_PROFILE_DATA_RE = /^[0-9a-f]{10000,20000}$/i;
const CREATOR_PROFILE_DATA_RE = /^[0-9a-f]{5000,20000}$/i;

/** 生成 b1（直接调用 b1.js；门禁：长度 >= 500 且 4 的倍数） */
export function generateB1(options?: Record<string, unknown>): string {
  const b1Module = require("../js/core/b1.js");
  const result = b1Module.generateB1(options ?? {});
  const value = String(result.b1 ?? "");
  if (value.length < 500 || value.length % 4 !== 0) {
    throw new Error(`b1 length invalid: ${value.length}`);
  }
  return value;
}

export interface SignerInput {
  api: string;
  data?: unknown;
  cookie: string;
  a1: string;
  /** 空字符串为浏览器真实冷登录态；null 表示调用方未显式提供 */
  b1: string | null;
  dslPair: string;
  tier: string;
  [key: string]: unknown;
}

/** 执行签名核心并按档位门禁校验（对应 xhs_pc/runtime.py run_signer） */
export function runSigner(
  input: SignerInput,
  options: { gate: "pc" | "creator" } = { gate: "pc" },
): Record<string, unknown> | null {
  const { api, data, cookie, a1, b1, dslPair, tier } = input;
  if (!cookie || !cookie.includes("a1=")) return null;
  const gate = resolveGate(tier, options.gate);
  if (!gate) return null;

  const payload: Record<string, unknown> = {
    api,
    data: data ?? "",
    cookie,
    a1,
    b1: b1 === null ? "" : String(b1),
    dslPair,
    tier,
  };
  const signContextKeys = [
    "now", "version", "loadts", "seq", "envConst", "envFpTail", "webBuild",
    "signVersion", "appId", "platform", "secChUa", "deviceTag", "b1b1",
    "signCount", "dsProgram", "xt",
  ];
  for (const key of signContextKeys) {
    if (input[key] !== undefined) payload[key] = input[key];
  }

  const signModule = require("../js/core/sign.js");
  const result = signModule.signFull(payload);

  const x3 = String(result.x3 ?? "");
  if (options.gate === "creator") {
    const creatorGate = CREATOR_TIER_GATE[tier];
    if (!creatorGate) return null;
    if (!result.xs || !result.xs_common || !x3.startsWith(creatorGate.prefix) || !creatorGate.lengths.includes(x3.length)) {
      throw new Error(`Creator signer gate failed: tier=${tier}, prefix=${x3.slice(0, 12)}, len=${x3.length}`);
    }
    return result;
  }
  const pcGate = PC_TIER_GATE[tier];
  if (pcGate && result.xs && x3.startsWith(pcGate.prefix) && x3.length === pcGate.length) {
    return { ...result, len: x3.length, prefix: x3.slice(0, 12) };
  }
  return null;
}

/** 执行服务端 JSVMP 脚本生成 websectiga（子进程，对应 xhs_core/runtime.py generate_websectiga） */
export function generateWebsectiga(
  scriptingCode: string,
  profile?: Record<string, unknown> | null,
  options: { timeoutMs?: number; pageUrl?: string } = {},
): Promise<string> {
  const cliPath = join(JS_DIR, "core", "websectiga_cli.js");
  const code = String(scriptingCode ?? "");
  if (code.length < 1000) {
    return Promise.reject(new Error("scripting code is empty or truncated"));
  }
  const values = { ...(profile ?? {}) };
  const payload = JSON.stringify({
    code,
    userAgent: String(values.userAgent ?? ""),
    platform: String(values.platform ?? "Win32"),
    pageUrl: String(values.pageUrl ?? options.pageUrl ?? "https://www.xiaohongshu.com/explore?channel_id=homefeed_recommend"),
    timeoutMs: Math.max(1000, Math.floor((options.timeoutMs ?? 20000) * 0.75)),
  });

  return new Promise((resolve, reject) => {
    const proc = spawn("node", [cliPath], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: dirname(cliPath),
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("websectiga runtime timed out"));
    }, options.timeoutMs ?? 20000);
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`websectiga runtime failed to start: ${err.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`websectiga runtime failed: ${(stderr || stdout).trim().slice(0, 500)}`));
        return;
      }
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const result = JSON.parse(trimmed);
          const token = String(result.websectiga ?? "");
          if (WEBSECTIGA_RE.test(token)) {
            resolve(token);
            return;
          }
        } catch {
          // 继续找下一行合法 JSON
        }
      }
      reject(new Error(`websectiga runtime output invalid: ${stdout.trim().slice(0, 300)}`));
    });
    proc.stdin.write(payload);
    proc.stdin.end();
  });
}

export interface ProfileDataOptions {
  fields?: Record<string, unknown>;
  timestampMs?: number;
  ets?: number;
  documentCookie?: string;
  timeOrigin?: number;
  i12Seed?: number;
  telemetryFi?: number;
}

/** PC profileData 纯计算（直接调用 profile.js；门禁 sdkVersion=4.3.7） */
export function generatePcProfileData(options: ProfileDataOptions): string {
  const profileModule = require("../js/pc/profile.js");
  const payload: Record<string, unknown> = { fields: { ...(options.fields ?? {}) } };
  if (options.timestampMs !== undefined) payload.timestampMs = options.timestampMs;
  if (options.ets !== undefined) payload.ets = options.ets;
  if (options.documentCookie !== undefined) payload.documentCookie = options.documentCookie;
  if (options.timeOrigin !== undefined) payload.timeOrigin = options.timeOrigin;
  if (options.i12Seed !== undefined) payload.i12Seed = options.i12Seed;
  if (options.telemetryFi !== undefined) payload.telemetryFi = options.telemetryFi;

  const value = String(profileModule.generateProfileData(payload) ?? "");
  if (!PC_PROFILE_DATA_RE.test(value)) {
    throw new Error(`profileData runtime output invalid: length=${value.length}`);
  }
  return value;
}

/** Creator profileData 纯计算（门禁 sdkVersion=4.3.6，对应 xhs_creator/runtime.py） */
export function generateCreatorProfileData(options: Record<string, unknown>): string {
  const profileModule = require("../js/creator/profile.js");
  const value = String(profileModule.generateProfileData(options) ?? "");
  if (!CREATOR_PROFILE_DATA_RE.test(value)) {
    throw new Error(`Creator profileData output gate failed: length=${value.length}`);
  }
  return value;
}

/** Creator urlSing（md5 时间戳签名，直接调用 xhs_creator_sign.js） */
export function creatorUrlSing(value: string, timestampMs?: number): string {
  const module = require("../js/creator/xhs_creator_sign.js");
  return String(module.urlSing(value, timestampMs));
}

/** x-rap-param 纯计算（直接调用 rap.js buildRapPure；门禁：ByQ 前缀） */
export function generateXRapParam(
  api: string,
  data: unknown,
  fingerprintHex: string,
): string {
  const rapModule = require("../js/pc/rap.js");
  const body = typeof data === "string" ? data : JSON.stringify(data ?? {});
  // 未显式传指纹时使用内置 PC 模板（对应原版 rap_cli.js 的 TPL_PATH 默认行为）
  const fingerprint = Buffer.from(fingerprintHex || rapTemplate.bodyUnmaskedHex, "hex");
  if (!fingerprint.length) throw new Error("rap gen failed: fingerprint is empty");
  const rap = String(rapModule.buildRapPure({ api, data: body, fingerprint }) ?? "");
  if (!rap.startsWith("ByQ")) throw new Error("JS x-rap-param 生成失败");
  return rap;
}

export { JS_DIR };
