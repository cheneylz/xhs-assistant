/**
 * 账号服务（对应原版 backend/app/services/account_service.py）
 */
import { encryptText } from "../core/security";
import { shanghaiNow } from "../core/time";
import { prisma } from "../core/db";
import { transCookies } from "../xhs/core/util";
import type { Prisma } from "@prisma/client";

export function accountProfileFromUserInfo(userInfo: Record<string, unknown>): Record<string, unknown> {
  const profile = userInfo.profile;
  if (profile && typeof profile === "object" && !Array.isArray(profile)) {
    return profile as Record<string, unknown>;
  }
  return {};
}

/** 解析 Cookie 文本（JSON 或 header 字符串，对应 decode_cookie_text） */
export function decodeCookieText(value: string): Record<string, unknown> {
  const stripped = value.trim();
  if (!stripped) return {};
  if (stripped.startsWith("{")) {
    try {
      const parsed = JSON.parse(stripped);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // 回退为 header 解析
    }
  }
  return transCookies(stripped);
}

/** Cookie 文本 → header 字符串（对应 cookie_header_from_text） */
export function cookieHeaderFromText(value: string): string {
  const stripped = value.trim();
  if (!stripped) return "";
  if (!stripped.startsWith("{")) return stripped;
  const cookies = decodeCookieText(stripped);
  return Object.entries(cookies)
    .map(([key, cookieValue]) => `${key}=${cookieValue}`)
    .join("; ");
}

function firstPresent(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

/** 用 XHS 自身 profile 数据补充账号信息（对应 enrich_user_info_with_xhs_self_profile） */
export function enrichUserInfoWithXhsSelfProfile(
  userInfo: Record<string, unknown>,
  response: Record<string, unknown>,
): Record<string, unknown> {
  const data = response?.data && typeof response.data === "object" && !Array.isArray(response.data)
    ? (response.data as Record<string, unknown>)
    : {};
  const basicInfo = data.basic_info && typeof data.basic_info === "object" ? (data.basic_info as Record<string, unknown>) : {};

  const interactionCounts: Record<string, unknown> = {};
  if (Array.isArray(data.interactions)) {
    for (const item of data.interactions) {
      if (!item || typeof item !== "object") continue;
      const interactionType = (item as Record<string, unknown>).type;
      if (interactionType) {
        const interaction = item as Record<string, unknown>;
        interactionCounts[String(interactionType)] = firstPresent(interaction.i18n_count, interaction.count);
      }
    }
  }

  const existingProfile = accountProfileFromUserInfo(userInfo);
  const profile: Record<string, unknown> = {
    ...existingProfile,
    red_id: firstPresent(basicInfo.red_id, existingProfile.red_id, ""),
    description: firstPresent(basicInfo.desc, existingProfile.description, ""),
    ip_location: firstPresent(basicInfo.ip_location, existingProfile.ip_location, ""),
    gender: firstPresent(basicInfo.gender, existingProfile.gender),
    followers: firstPresent(interactionCounts.fans, existingProfile.followers),
    following: firstPresent(interactionCounts.follows, existingProfile.following),
    likes: firstPresent(interactionCounts.interaction, existingProfile.likes),
    raw: response,
  };
  return {
    ...userInfo,
    nickname: firstPresent(basicInfo.nickname, userInfo.nickname, ""),
    avatar_url: firstPresent(basicInfo.images, basicInfo.imageb, userInfo.avatar_url, ""),
    profile,
  };
}

/** 序列化账号（对应 serialize_account） */
export function serializeAccount(
  account: {
    id: number;
    platform: string;
    subType: string | null;
    externalUserId: string | null;
    nickname: string;
    avatarUrl: string;
    status: string;
    statusMessage: string;
    profileJson: string;
    createdAt: Date;
    updatedAt: Date | null;
  },
  action?: string | null,
): Record<string, unknown> {
  let profile: unknown = {};
  try {
    const parsed = JSON.parse(account.profileJson || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) profile = parsed;
  } catch {
    profile = {};
  }
  const payload: Record<string, unknown> = {
    id: account.id,
    platform: account.platform,
    sub_type: account.subType,
    external_user_id: account.externalUserId,
    nickname: account.nickname,
    avatar_url: account.avatarUrl,
    status: account.status,
    status_message: account.statusMessage,
    profile,
    created_at: account.createdAt.toISOString(),
    updated_at: (account.updatedAt ?? account.createdAt).toISOString(),
  };
  if (action) payload.action = action;
  return payload;
}

/** 登录成功后 upsert 平台账号（对应 upsert_platform_account_from_login） */
export async function upsertPlatformAccountFromLogin(options: {
  userId: number;
  platform: string;
  subType: string;
  userInfo: Record<string, unknown>;
  cookiesText: string;
}): Promise<{ account: unknown; action: string }> {
  const { userId, platform, subType, userInfo, cookiesText } = options;
  const externalUserId = String(userInfo.external_user_id ?? "") || "";
  let account = null;
  if (externalUserId) {
    account = await prisma.platformAccount.findFirst({
      where: { userId, platform, subType, externalUserId },
    });
  }
  const action = account ? "updated" : "created";
  const now = shanghaiNow();
  if (!account) {
    account = await prisma.platformAccount.create({
      data: {
        userId,
        platform,
        subType,
        externalUserId,
        createdAt: now,
        updatedAt: now,
      },
    });
  }
  const data: Prisma.PlatformAccountUpdateInput = {
    nickname: String(userInfo.nickname ?? "") || account.nickname || "",
    avatarUrl: String(userInfo.avatar_url ?? "") || account.avatarUrl || "",
    externalUserId: externalUserId || account.externalUserId || "",
    status: "active",
    statusMessage: "",
    profileJson: JSON.stringify(accountProfileFromUserInfo(userInfo)),
    updatedAt: now,
  };
  account = await prisma.platformAccount.update({ where: { id: account.id }, data });
  await prisma.accountCookieVersion.create({
    data: {
      platformAccountId: account.id,
      encryptedCookies: encryptText(cookiesText),
      createdAt: now,
    },
  });
  return { account, action };
}
