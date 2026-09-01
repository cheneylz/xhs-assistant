/**
 * 导入 Cookie 创建账号（对应原版 backend/app/api/accounts.py 的 import_cookie）
 */
import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { serializeAccount, upsertPlatformAccountFromLogin, enrichUserInfoWithXhsSelfProfile } from "@/lib/server/services/account-service";
import { cookieHeaderFromText } from "@/lib/server/services/account-service";
import { transCookies } from "@/lib/server/xhs/core/util";
import { NextResponse } from "next/server";
import { z } from "zod";

const CookieImportSchema = z.object({
  platform: z.literal("xhs"),
  sub_type: z.enum(["pc", "creator"]),
  cookie_string: z.string().min(3),
  sync_creator: z.boolean().default(false),
});

/** POST /api/accounts/import-cookie 导入 Cookie 创建账号 */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, CookieImportSchema);

  // 1) 校验 Cookie 并取用户信息
  let userInfo: Record<string, unknown>;
  try {
    if (payload.sub_type === "creator") {
      const { XhsCreatorLoginAdapter } = await import("@/lib/server/xhs/adapters/creator-login-adapter");
      userInfo = await new XhsCreatorLoginAdapter().getUserInfo(transCookies(payload.cookie_string));
    } else {
      const { XhsPcLoginAdapter } = await import("@/lib/server/xhs/adapters/pc-login-adapter");
      userInfo = await new XhsPcLoginAdapter().getUserInfo(transCookies(payload.cookie_string));
    }
  } catch {
    throw new ApiError(400, "Cookie is invalid or expired");
  }

  // 2) PC 账号附加自我 profile 富化（失败静默）
  if (payload.sub_type === "pc") {
    try {
      const { XhsPcApiAdapter } = await import("@/lib/server/xhs/adapters/pc-api-adapter");
      const selfProfile = await new XhsPcApiAdapter(cookieHeaderFromText(payload.cookie_string)).getSelfInfo();
      userInfo = enrichUserInfoWithXhsSelfProfile(userInfo, selfProfile);
    } catch {
      // 富化失败不阻塞
    }
  }

  // 3) upsert 账号
  const { account, action } = await upsertPlatformAccountFromLogin({
    userId: user.id,
    platform: payload.platform,
    subType: payload.sub_type,
    userInfo,
    cookiesText: payload.cookie_string,
  });

  // 4) PC 且 sync_creator：联动创建 creator 账号（失败静默，响应不含该结果）
  if (payload.sub_type === "pc" && payload.sync_creator) {
    try {
      const { XhsCreatorLoginAdapter } = await import("@/lib/server/xhs/adapters/creator-login-adapter");
      const creatorAdapter = new XhsCreatorLoginAdapter();
      const creatorResult = await creatorAdapter.exchangeFromUserCookies(transCookies(payload.cookie_string));
      const creatorUserInfo = await creatorAdapter.getUserInfo(creatorResult.cookies as Record<string, unknown>);
      await upsertPlatformAccountFromLogin({
        userId: user.id,
        platform: "xhs",
        subType: "creator",
        userInfo: creatorUserInfo,
        cookiesText: JSON.stringify(creatorResult.cookies),
      });
    } catch {
      // 联动失败静默
    }
  }

  return NextResponse.json(serializeAccount(account as never, action));
});
