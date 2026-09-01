/**
 * 安全模块（对应原版 backend/app/core/security.py，逐字节兼容）
 *  - 密码哈希：pbkdf2_sha256$iterations$salt$hash（兼容旧库已有哈希）
 *  - JWT：手写 HS256（header.payload.signature，base64url 无填充）
 *  - Fernet 加密：标准 Fernet 格式（AES-128-CBC + HMAC-SHA256），
 *    与 Python cryptography.fernet 互操作，用于解密旧库中的 Cookie / API Key
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { getConfig } from "./config";
import { ApiError } from "./http-error";

export const ACCESS_TOKEN_EXPIRE_MINUTES = 15;
export const REFRESH_TOKEN_EXPIRE_DAYS = 7;
export const PASSWORD_ITERATIONS = 260_000;

// ---------------- 密码哈希 ----------------

/**
 * 生成密码哈希，格式：pbkdf2_sha256$260000$salt$hash
 * 与原版 Python hashlib.pbkdf2_hmac 输出一致
 */
export function hashPassword(password: string): string {
  const salt = base64UrlEncode(randomBytes(16));
  const digest = pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, "sha256");
  const passwordHash = base64UrlEncode(digest);
  return `pbkdf2_sha256$${PASSWORD_ITERATIONS}$${salt}$${passwordHash}`;
}

/** 校验密码；兼容旧格式（pbkdf2_sha256$... 与 legacy sha256 十六进制） */
export function verifyPassword(password: string, passwordHash: string): boolean {
  if (passwordHash.startsWith("pbkdf2_sha256$")) {
    const [, iterations, salt, expectedHash] = passwordHash.split("$", 4);
    const digest = pbkdf2Sync(password, salt, Number.parseInt(iterations, 10), 32, "sha256");
    const actualHash = base64UrlEncode(digest);
    return constantTimeEquals(actualHash, expectedHash);
  }
  // 旧版 sha256 hex 哈希
  const legacyHash = createHash("sha256").update(password, "utf-8").digest("hex");
  return constantTimeEquals(legacyHash, passwordHash);
}

/** 401 认证失败错误（对应原版 credentials_exception） */
function invalidTokenError(): ApiError {
  return new ApiError(401, "Invalid authentication token", { "WWW-Authenticate": "Bearer" });
}

// ---------------- JWT ----------------

function base64UrlEncode(value: Buffer): string {
  return value.toString("base64url").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Buffer {
  // 兼容带/不带 "=" 填充两种输入（Python base64.urlsafe_b64encode 带填充）
  return Buffer.from(value.replace(/=+$/, ""), "base64url");
}

function signToken(payload: Record<string, unknown>): string {
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput = [
    base64UrlEncode(Buffer.from(JSON.stringify(header))),
    base64UrlEncode(Buffer.from(JSON.stringify(payload))),
  ].join(".");
  const signature = createHmac("sha256", getConfig().secretKey).update(signingInput).digest();
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function createToken(userId: number, expiresSeconds: number, tokenType: string): string {
  const expiresAt = Math.floor(Date.now() / 1000) + expiresSeconds;
  return signToken({ user_id: userId, token_type: tokenType, exp: expiresAt });
}

/** 生成 access token（15 分钟） */
export function createAccessToken(userId: number): string {
  return createToken(userId, ACCESS_TOKEN_EXPIRE_MINUTES * 60, "access");
}

/** 生成 refresh token（7 天） */
export function createRefreshToken(userId: number): string {
  return createToken(userId, REFRESH_TOKEN_EXPIRE_DAYS * 24 * 3600, "refresh");
}

/** 校验 token 签名与有效期，返回 payload；失败抛 ApiError(401) */
export function decodeToken(token: string): Record<string, unknown> {
  const [headerValue, payloadValue, signatureValue] = token.split(".");
  if (!headerValue || !payloadValue || !signatureValue) {
    throw invalidTokenError();
  }
  const signingInput = `${headerValue}.${payloadValue}`;
  const expectedSignature = createHmac("sha256", getConfig().secretKey).update(signingInput).digest();
  const actualSignature = base64UrlDecode(signatureValue);
  if (!constantTimeEquals(actualSignature, expectedSignature)) {
    throw invalidTokenError();
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(base64UrlDecode(payloadValue).toString("utf-8")) as Record<string, unknown>;
  } catch {
    throw invalidTokenError();
  }
  const expiresAt = payload.exp;
  if (typeof expiresAt !== "number" || expiresAt < Math.floor(Date.now() / 1000)) {
    throw invalidTokenError();
  }
  if (typeof payload.user_id !== "number") {
    throw invalidTokenError();
  }
  return payload;
}

// ---------------- Fernet ----------------

/** 从 secret 派生 Fernet 密钥（与原版 _derive_fernet_key 一致：base64(sha256(secret))） */
function deriveFernetKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf-8").digest();
}

function getFernetKey(): Buffer {
  const config = getConfig();
  if (config.fernetKey) {
    return Buffer.from(config.fernetKey, "base64");
  }
  return deriveFernetKey(config.secretKey);
}

/**
 * Fernet 加密（标准 Fernet v0 格式，与 Python cryptography.fernet 互操作）
 * token = b64url(0x80 || timestamp(8) || iv(16) || ciphertext || hmac(32))
 */
export function encryptText(value: string): string {
  const key = getFernetKey();
  // 注意：cryptography >= 45（本环境 50.0.0）为签名=前半、加密=后半。
  // 旧库数据即为该布局加密（已用旧库真实 Cookie/API Key 验证），必须保持一致
  const signingKey = key.subarray(0, 16);
  const encryptionKey = key.subarray(16, 32);
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
  const iv = randomBytes(16);
  // node:crypto 的 AES-CBC 默认自动 PKCS7 填充（加解密两侧一致）
  const cipher = createCipheriv("aes-128-cbc", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(value, "utf-8")), cipher.final()]);
  const body = Buffer.concat([Buffer.from([0x80]), timestamp, iv, ciphertext]);
  const hmac = createHmac("sha256", signingKey).update(body).digest();
  return base64UrlEncode(Buffer.concat([body, hmac]));
}

/** Fernet 解密；失败（密钥不匹配/数据损坏）抛错误 */
export function decryptText(value: string): string {
  const key = getFernetKey();
  const signingKey = key.subarray(0, 16);
  const encryptionKey = key.subarray(16, 32);
  const token = base64UrlDecode(value);
  if (token.length < 57) throw new Error("Fernet token too short");
  if (token[0] !== 0x80) throw new Error("Invalid Fernet version");
  const body = token.subarray(0, -32);
  const hmac = token.subarray(-32);
  const expectedHmac = createHmac("sha256", signingKey).update(body).digest();
  if (!constantTimeEquals(hmac, expectedHmac)) throw new Error("Fernet token signature mismatch");
  const iv = token.subarray(9, 25);
  const ciphertext = token.subarray(25, -32);
  // node:crypto 自动去除 PKCS7 填充
  const decipher = createDecipheriv("aes-128-cbc", encryptionKey, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
}

// ---------------- 工具 ----------------

function constantTimeEquals(a: Buffer | string, b: Buffer | string): boolean {
  const bufA = typeof a === "string" ? Buffer.from(a) : a;
  const bufB = typeof b === "string" ? Buffer.from(b) : b;
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

export { randomUUID };
