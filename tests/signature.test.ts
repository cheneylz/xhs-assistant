/**
 * 签名 SDK 一致性测试
 * - murmur3 / xy-direction / base36 与 Python 版输出逐值比对（测试向量 2026-08-21 生成）
 * - b1 生成走直接 require（消除子进程），门禁与 Python 版一致
 */
import { describe, expect, it } from "vitest";
import { generateB1 } from "../src/lib/server/xhs/core/runtime";
import { murmurHash3_32, generateXyDirection } from "../src/lib/server/xhs/pc/params";
import { intToBase36BigInt } from "../src/lib/server/xhs/pc/params";
import { generateSearchId, generateSearchRequestId, generateSearchSessionId } from "../src/lib/server/xhs/pc/params";
import { generateA1, generateWebId, transCookies, crc32 } from "../src/lib/server/xhs/core/util";
import { PcDeviceProfile, parseCookieKv, cookieHeader, initialPcCookies } from "../src/lib/server/xhs/pc/state";
import { XHSPcAuth } from "../src/lib/server/xhs/pc/auth";
import { XHSCreatorAuth } from "../src/lib/server/xhs/creator/auth";

describe("murmurHash3_32（与 Python 版逐值一致）", () => {
  it("标准向量", () => {
    expect(murmurHash3_32("hello")).toBe(613153351);
    expect(murmurHash3_32("test-123", 151488)).toBe(3889079808);
    expect(murmurHash3_32("")).toBe(0);
  });

  it("xy-direction 派生", () => {
    expect(generateXyDirection("5f3a2e1b9c")).toBe(44);
    expect(generateXyDirection("")).toBe(0);
  });
});

describe("search_id / base36（与 Python 版格式一致）", () => {
  it("base36 转换", () => {
    expect(intToBase36BigInt(1234567890123456n)).toBe("c5m8nq6itc");
    expect(intToBase36BigInt(0n)).toBe("0");
  });

  it("search_id 格式：base36（含 timestamp<<64）", () => {
    const id = generateSearchId();
    expect(id).toMatch(/^[0-9a-z]+$/);
    expect(id.length).toBeGreaterThan(20);
  });

  it("search_request_id 格式：<random>-<timestamp>", () => {
    expect(generateSearchRequestId()).toMatch(/^\d+-\d{13}$/);
  });

  it("search_session_id 为 UUIDv4", () => {
    expect(generateSearchSessionId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("a1 / webId / cookies 工具", () => {
  it("a1 为 52 位且含 crc32 尾", () => {
    const a1 = generateA1();
    expect(a1.length).toBe(52);
    expect(a1.slice(-10)).toMatch(/^\d+$/);
  });

  it("webId = md5(a1)", () => {
    expect(generateWebId("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
  });

  it("transCookies 解析", () => {
    const parsed = transCookies("a1=xyz; webId=abc");
    expect(parsed).toEqual({ a1: "xyz", webId: "abc" });
  });

  it("crc32 与 binascii.crc32 一致", () => {
    // binascii.crc32(b"hello") = 0x3610a686
    expect(crc32(Buffer.from("hello", "utf-8"))).toBe(0x3610a686);
  });
});

describe("b1 生成（直接 require，门禁一致）", () => {
  it("b1 长度 >= 500 且为 4 的倍数", () => {
    const b1 = generateB1({ now: Date.now() });
    expect(b1.length).toBeGreaterThanOrEqual(500);
    expect(b1.length % 4).toBe(0);
  });

  it("相同输入产出确定性结果", () => {
    const options = { now: 1787270000000, x39: 3, x50: "5b120b904d5e2b4e04b26c191e520157b88b28bcda9abf9d9a7eb9a1e90d6e1d", secCanvas: "test" };
    const first = generateB1(options);
    const second = generateB1(options);
    expect(first).toBe(second);
  });
});

describe("PcDeviceProfile 状态机", () => {
  it("cookie 解析保持键序", () => {
    const cookies = parseCookieKv("b=2; a=1; c=3");
    expect(Object.keys(cookies)).toEqual(["b", "a", "c"]);
  });

  it("initial_pc_cookies 字段与顺序", () => {
    const result = initialPcCookies("a1value", "webidvalue", { abRequestId: "req-123", timestampMs: 1787270000000 });
    expect(result.abRequestId).toBe("req-123");
    expect(result.a1).toBe("a1value");
    expect(result.webId).toBe("webidvalue");
    expect(result.ets).toBe("1787270000000");
    expect(Object.keys(result)).toEqual(["abRequestId", "ets", "webBuild", "xsecappid", "loadts", "a1", "webId"]);
  });

  it("documentCookie 隐藏 HttpOnly 令牌", () => {
    const profile = new PcDeviceProfile({
      cookies: { a1: "x", web_session: "secret", gid: "g", abRequestId: "r", ets: "123" },
    });
    const doc = profile.documentCookie;
    expect(doc).not.toContain("web_session");
    expect(doc).toContain("a1=x");
    expect(doc).toContain("gid=g");
  });

  it("MNS 档位解析：指纹就绪 → 0301；安全域 → 0201；其余 → 0101", () => {
    const profile = new PcDeviceProfile({ cookies: { a1: "x", gid: "g" } });
    expect(profile.resolveMnsTier("/api/sns/web/v1/feed")).toBe("0301");
    const cold = new PcDeviceProfile({ cookies: { a1: "x" } });
    expect(cold.resolveMnsTier("/api/sec/v1/foo")).toBe("0201");
    expect(cold.resolveMnsTier("/api/sns/web/v1/search")).toBe("0101");
  });

  it("next_sign_context 推进 seq 且含必需字段", () => {
    const profile = new PcDeviceProfile({ cookies: { a1: "x", loadts: "1000" } });
    const context = profile.nextSignContext("/api/sns/web/v1/feed", { timestampMs: 5000 });
    expect(context.tier).toBe("0101");
    expect(context.seq).toBe(1);
    expect(context.loadts).toBe(1000);
    expect(Array.isArray(context.envFpTail)).toBe(true);
    expect((context.envFpTail as number[]).length).toBe(14);
    expect(typeof context.now).toBe("number");
    expect(typeof context.version).toBe("number");
    const second = profile.nextSignContext("/api/sns/web/v1/feed", { timestampMs: 5000 });
    expect(second.seq).toBe(2);
  });

  it("dsl_pair 格式 dsllt;_dsl 且 15 分钟刷新", () => {
    const profile = new PcDeviceProfile({ cookies: { a1: "x", loadts: "1000" } });
    expect(profile.dslPair("1787000000000", { timestampMs: 5000 })).toBe("1000;1787000000000");
    // dsllt 过期后刷新
    const later = profile.dslPair("1787000000000", { timestampMs: 1000 + 16 * 60 * 1000 });
    expect(later.startsWith(`${1000 + 16 * 60 * 1000};`)).toBe(true);
  });

  it("snapshot 序列化字段与 Python 版一致", () => {
    const profile = new PcDeviceProfile({ cookies: { a1: "x", loadts: "1000", gid: "g" } });
    const state = profile.stateSnapshot();
    expect(state.loadts).toBe(1000);
    expect(state.fingerprintReady).toBe(true);
    expect(typeof state.XHS_TAB_DEVICE_ID).toBe("string");
    expect(state.xsecappid).toBe("xhs-pc-web");
  });

  it("cookie_header 序列化", () => {
    expect(cookieHeader({ a: "1", b: "2" })).toBe("a=1; b=2");
  });
});

describe("XHSAuth 子类构造（回归：platformConfig 未设置导致 bindPlatform 抛错）", () => {
  it("XHSPcAuth.fromCookie 可正常构造", () => {
    const auth = XHSPcAuth.fromCookie("a1=test123; web_session=sess123; gid=g");
    expect(auth.platform).toBe("pc");
    expect(auth.origin("api")).toBe("https://edith.xiaohongshu.com");
  });

  it("XHSCreatorAuth.fromCookie 可正常构造", () => {
    const auth = XHSCreatorAuth.fromCookie("a1=test123; customer-sso-sid=sid123");
    expect(auth.platform).toBe("creator");
    expect(auth.origin("api")).toBe("https://creator.xiaohongshu.com");
  });
});
