/**
 * 登录会话共享工具（对应原版 login_sessions.py 的辅助函数）
 */
import { prisma } from "@/lib/server/core/db";
import { encryptText } from "@/lib/server/core/security";
import { serializeAccount, upsertPlatformAccountFromLogin } from "@/lib/server/services/account-service";
import { enrichUserInfoWithXhsSelfProfile, cookieHeaderFromText } from "@/lib/server/services/account-service";

/** 紧凑 JSON 序列化（对应 _dump_json） */
export function dumpJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

/** 解析 JSON（对应 _load_json） */
export function loadJson(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 临时状态序列化（对应 _dump_temp_state） */
export function dumpTempState(cookies: Record<string, unknown>, syncCreator = false): string {
  if (syncCreator) return dumpJson({ cookies, sync_creator: true });
  return dumpJson(cookies);
}

/** 临时状态解析（对应 _load_temp_state） */
export function loadTempState(value: string | null | undefined): [Record<string, unknown>, boolean] {
  const payload = loadJson(value);
  const cookies = payload.cookies;
  if (cookies && typeof cookies === "object" && !Array.isArray(cookies)) {
    return [cookies as Record<string, unknown>, Boolean(payload.sync_creator)];
  }
  if (Object.keys(payload).length) return [payload, false];
  return [{}, false];
}

/** 手机号打码（对应 _mask_phone） */
export function maskPhone(phone: string): string {
  if (phone.length <= 7) return `${phone.slice(0, 2)}****`;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

/** PC 登录联动创建 Creator 账号（对应 _sync_creator_account_from_pc_login） */
export async function syncCreatorAccountFromPcLogin(options: {
  userId: number;
  pcCookies: Record<string, unknown>;
  creatorAdapter: { exchangeFromUserCookies: (cookies: Record<string, unknown>) => Promise<Record<string, unknown>>; getUserInfo: (cookies: Record<string, unknown>) => Promise<Record<string, unknown>> };
}): Promise<Record<string, unknown> | null> {
  try {
    const creatorResult = await options.creatorAdapter.exchangeFromUserCookies(options.pcCookies);
    const creatorUserInfo = await options.creatorAdapter.getUserInfo(creatorResult.cookies as Record<string, unknown>);
    const { account, action } = await upsertPlatformAccountFromLogin({
      userId: options.userId,
      platform: "xhs",
      subType: "creator",
      userInfo: creatorUserInfo,
      cookiesText: dumpJson(creatorResult.cookies as Record<string, unknown>),
    });
    return serializeAccount(account as never, action);
  } catch {
    return null;
  }
}

/** 登录成功后创建账号（对应 _create_account_from_login，PC 侧附加自我 profile 富化） */
export async function createAccountFromLogin(options: {
  userId: number;
  subType: string;
  userInfo: Record<string, unknown>;
  cookies: Record<string, unknown>;
}): Promise<{ account: unknown; action: string }> {
  const cookiesText = dumpJson(options.cookies);
  let userInfo = options.userInfo;
  if (options.subType === "pc") {
    try {
      const { XhsPcApiAdapter } = await import("@/lib/server/xhs/adapters/pc-api-adapter");
      const selfProfile = await new XhsPcApiAdapter(cookieHeaderFromText(cookiesText)).getSelfInfo();
      userInfo = enrichUserInfoWithXhsSelfProfile(userInfo, selfProfile);
    } catch {
      // 自我 profile 富化失败不阻塞
    }
  }
  return upsertPlatformAccountFromLogin({
    userId: options.userId,
    platform: "xhs",
    subType: options.subType,
    userInfo,
    cookiesText,
  });
}

export { prisma, encryptText };
