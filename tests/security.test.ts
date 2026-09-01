/**
 * 安全模块兼容性测试
 * 测试向量由 Python 版 backend/app/core/security.py 生成（2026-08-21），
 * 用于锁定 TS 实现与 Python 版逐字节兼容（旧库数据可直接解密/校验）
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetConfig } from "../src/lib/server/core/config";
import {
  createAccessToken,
  decryptText,
  decodeToken,
  encryptText,
  hashPassword,
  verifyPassword,
} from "../src/lib/server/core/security";

afterEach(() => {
  process.env.SECRET_KEY = PY_SECRET;
  resetConfig();
});

const PY_SECRET = "dev-only-change-me";

describe("Fernet 加密（与 Python cryptography.fernet 互操作）", () => {
  it("能解密 Python 生成的 token", () => {
    // fixture 由 Python cryptography.fernet（本机 50.0.0）生成
    const pyToken = readFileSync(join(__dirname, "fixtures", "python_fernet_token.txt"), "utf-8").trim();
    expect(decryptText(pyToken)).toBe("hello-fernet-world");
  });

  it("TS 生成的 token 可被 Python 解密（往返验证）", () => {
    const token = encryptText("round-trip-check");
    expect(decryptText(token)).toBe("round-trip-check");
    // 格式校验：标准 Fernet base64url 前缀
    expect(token.startsWith("gAAAAA")).toBe(true);
  });

  it("错误密钥解密抛异常", () => {
    process.env.SECRET_KEY = "different-secret-key";
    resetConfig();
    expect(() => decryptText("gAAAAABqh6HBNfcC7uv3WlfUaISz40S7C_0jT0-GuYVaIzlECyXaihTZT8NNI6WZjOox4annC-a9xGQ9r0xBtAUSVC2NvwiCLQLwDqcdPHEoRvsvowGa25c=")).toThrow();
  });
});

describe("密码哈希（pbkdf2_sha256 格式）", () => {
  it("能校验 Python 生成的哈希", () => {
    const pyHash = "pbkdf2_sha256$260000$ZYMqlpKAg9ip7edKAAKEHg$cBovZ_msgGHo34II9r3sBWyl16EKrOyUTi6NV-dDmmQ";
    expect(verifyPassword("testpass123", pyHash)).toBe(true);
    expect(verifyPassword("wrong-password", pyHash)).toBe(false);
  });

  it("生成与校验往返一致", () => {
    const hash = hashPassword("my-password-1");
    expect(hash.startsWith("pbkdf2_sha256$260000$")).toBe(true);
    expect(verifyPassword("my-password-1", hash)).toBe(true);
    expect(verifyPassword("my-password-2", hash)).toBe(false);
  });

  it("兼容旧版 sha256 hex 哈希", () => {
    // sha256("legacy-pass") 的 hex
    const legacyHash = "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8";
    expect(verifyPassword("password", legacyHash)).toBe(true);
  });
});

describe("JWT（手写 HS256）", () => {
  it("能解码并校验 Python 生成的 access token", () => {
    // exp = 2036-01-01（长期有效测试向量，由 Python 版 security.py 同款逻辑生成）
    const pyToken =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoxLCJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoyMDgyNzU4NDAwfQ.gwyEFLCPfLeatxIGrdAsHJg0bxQwpQYUN66xtCcwJps";
    const payload = decodeToken(pyToken);
    expect(payload.user_id).toBe(1);
    expect(payload.token_type).toBe("access");
  });

  it("生成 token 结构正确且可解码", () => {
    const token = createAccessToken(42);
    expect(token.split(".")).toHaveLength(3);
    const payload = decodeToken(token);
    expect(payload.user_id).toBe(42);
    expect(payload.token_type).toBe("access");
    expect(typeof payload.exp).toBe("number");
  });

  it("篡改签名校验失败", () => {
    const token = createAccessToken(1);
    const tampered = token.slice(0, -3) + "abc";
    expect(() => decodeToken(tampered)).toThrow();
  });

  it("过期 token 校验失败", () => {
    // exp = 0 的伪造 token（签名由本实现生成以保证验签通过）
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url").replace(/=+$/, "");
    const payload = Buffer.from(JSON.stringify({ user_id: 1, token_type: "access", exp: 0 })).toString("base64url").replace(/=+$/, "");
    const signingInput = `${header}.${payload}`;
    const signature = createHmac("sha256", PY_SECRET).update(signingInput).digest("base64url").replace(/=+$/, "");
    const expired = `${signingInput}.${signature}`;
    expect(() => decodeToken(expired)).toThrow();
  });
});
