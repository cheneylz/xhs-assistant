/**
 * 通用工具（对应原版 common_util.py 的 generate_a1 / generate_web_id / trans_cookies）
 */
import { createHash } from "node:crypto";

const A1_CHARSET = "abcdefghijklmnopqrstuvwxyz1234567890";

/** 生成 a1（时间戳 hex + 30 位随机 + 尾部 + crc32，52 位） */
export function generateA1(): string {
  const tsHex = Math.floor(Date.now()).toString(16);
  let randomStr = "";
  for (let i = 0; i < 30; i++) {
    randomStr += A1_CHARSET[Math.floor(Math.random() * A1_CHARSET.length)];
  }
  const aPart = tsHex + randomStr + "5" + "0" + "000";
  const crc = crc32(Buffer.from(aPart, "utf-8"));
  return (aPart + crc).slice(0, 52);
}

/** 从 a1 派生 webId（md5 hex） */
export function generateWebId(a1: string): string {
  return createHash("md5").update(a1, "utf-8").digest("hex");
}

/** Cookie 字符串 → 键值对（对应 trans_cookies） */
export function transCookies(cookiesStr: string): Record<string, string> {
  const result: Record<string, string> = {};
  const parts = cookiesStr.split("; ");
  for (const part of parts) {
    const index = part.indexOf("=");
    if (index >= 0) result[part.slice(0, index)] = part.slice(index + 1);
  }
  return result;
}

/** CRC32（对应 binascii.crc32） */
export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
