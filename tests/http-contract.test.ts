/**
 * HTTP 传输契约测试（orderedWireHeaders）
 * 回归锁定：2026-08-21 修复 accept-encoding 键名 bug（曾用驼峰键导致 missing+unexpected 双报错）
 * 2026-08-24 回归锁定：Creator CAS/security 契约表不含 trace 头，登录请求须显式关闭
 * includeTraceHeaders（x-b3-traceid / x-xray-traceid 只出现在 redcaptcha / login-user-info / 业务签名请求）
 */
import { describe, expect, it } from "vitest";
import { orderedWireHeaders } from "../src/lib/server/xhs/core/http";
import { PC_NAVIGATION_HEADER_ORDER } from "../src/lib/server/xhs/pc/params";
import {
  CREATOR_CAS_POST_NO_RATE_HEADER_ORDER,
  CREATOR_SIGNED_POST_HEADER_ORDER,
} from "../src/lib/server/xhs/creator/params";

describe("orderedWireHeaders（wire 头契约）", () => {
  it("自动注入 accept-encoding（连字符键名）且无意外键", () => {
    const headers = orderedWireHeaders(
      {
        "user-agent": "test-ua",
        "sec-ch-ua": '"Chromium";v="150"',
      },
      {
        order: ["user-agent", "accept-encoding", "sec-ch-ua", "cookie"],
        cookies: { a1: "x" },
      },
    );
    expect(headers["accept-encoding"]).toBe("gzip, deflate, br, zstd");
    expect(headers).not.toHaveProperty("acceptEncoding");
    expect(headers.cookie).toBe("a1=x");
  });

  it("显式传入的 accept-encoding 不被覆盖", () => {
    const headers = orderedWireHeaders(
      { "accept-encoding": "gzip" },
      { order: ["accept-encoding"], acceptEncoding: "br" },
    );
    expect(headers["accept-encoding"]).toBe("gzip");
  });

  it("PC 导航头契约：完整校验通过（对应登录 QR 生成路径）", () => {
    // 原版 build_pc_navigation_headers 调用：optional=("cookie",)
    const headers = orderedWireHeaders(
      {
        "upgrade-insecure-requests": "1",
        "user-agent": "Mozilla/5.0",
        "sec-ch-ua": '"Chromium";v="150"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        accept: "*/*",
        "accept-language": "zh-CN",
        priority: "u=0, i",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
      },
      {
        order: PC_NAVIGATION_HEADER_ORDER,
        cookies: { a1: "x" },
        optional: ["cookie"],
      },
    );
    expect(headers["accept-encoding"]).toBe("gzip, deflate, br, zstd");
    // 契约校验通过（无异常抛出）且输出键均为契约内键
    expect(Object.keys(headers).every((key) => PC_NAVIGATION_HEADER_ORDER.includes(key))).toBe(true);
  });

  it("authority 伪头被剔除", () => {
    const headers = orderedWireHeaders(
      { authority: "edith.xiaohongshu.com", "user-agent": "ua" },
      { order: ["user-agent", "accept-encoding"] },
    );
    expect(headers).not.toHaveProperty("authority");
  });

  it("Creator CAS 契约：trace 头为意外键时报错（对应 QR 码生成 bug）", () => {
    // 修复前 generateQrcode 走 _signed 未关 trace，x-b3-traceid / x-xray-traceid
    // 进入 cas-post-no-rate 契约表导致 wire header contract drifted
    const call = () =>
      orderedWireHeaders(
        {
          authorization: "",
          referer: "https://creator.xiaohongshu.com/",
          "x-t": "x",
          "x-s-common": "s",
          "x-b3-traceid": "b3",
          "x-xray-traceid": "ray",
          "user-agent": "ua",
          accept: "application/json, text/plain, */*",
          "content-type": "application/json",
          "x-s": "sig",
          "accept-encoding": "gzip, deflate, br, zstd",
          "accept-language": "zh-CN",
          origin: "https://creator.xiaohongshu.com",
          priority: "u=1, i",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
        },
        { order: CREATOR_CAS_POST_NO_RATE_HEADER_ORDER, cookies: { a1: "1" } },
      );
    expect(call).toThrow(/unexpected=\[x-b3-traceid,x-xray-traceid\]/);
  });

  it("Creator CAS 契约：关闭 trace 头后校验通过", () => {
    const headers = orderedWireHeaders(
      {
        authorization: "",
        referer: "https://creator.xiaohongshu.com/",
        "x-t": "x",
        "x-s-common": "s",
        "user-agent": "ua",
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        "x-s": "sig",
        "accept-encoding": "gzip, deflate, br, zstd",
        "accept-language": "zh-CN",
        origin: "https://creator.xiaohongshu.com",
        priority: "u=1, i",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      { order: CREATOR_CAS_POST_NO_RATE_HEADER_ORDER, cookies: { a1: "1" } },
    );
    expect(Object.keys(headers).every((key) => CREATOR_CAS_POST_NO_RATE_HEADER_ORDER.includes(key))).toBe(true);
  });

  it("Creator 业务签名契约：trace 头在契约内，可通过", () => {
    const headers = orderedWireHeaders(
      {
        authorization: "",
        referer: "https://creator.xiaohongshu.com/",
        "x-xray-traceid": "ray",
        "x-t": "x",
        "x-b3-traceid": "b3",
        "x-s-common": "s",
        "user-agent": "ua",
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        "x-s": "sig",
        "accept-encoding": "gzip, deflate, br, zstd",
        "accept-language": "zh-CN",
        origin: "https://creator.xiaohongshu.com",
        priority: "u=1, i",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
      },
      { order: CREATOR_SIGNED_POST_HEADER_ORDER, cookies: { a1: "1" } },
    );
    expect(headers["x-b3-traceid"]).toBe("b3");
  });
});
