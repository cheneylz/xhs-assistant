/**
 * 账号健康检查（对应原版 backend/app/api/accounts.py 的 check_account）
 * URL 路径 /api/accounts/{accountId}/check
 */
import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { decryptText } from "@/lib/server/core/security";
import { shanghaiNow } from "@/lib/server/core/time";
import {
  accountProfileFromUserInfo,
  cookieHeaderFromText,
  decodeCookieText,
  enrichUserInfoWithXhsSelfProfile,
  serializeAccount,
} from "@/lib/server/services/account-service";
import { NextResponse } from "next/server";

/** POST /api/accounts/{accountId}/check 账号健康检查（对应原版 check_account） */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const accountId = Number.parseInt(params.accountId, 10);
  const account = await prisma.platformAccount.findUnique({ where: { id: accountId } });
  if (!account || account.userId !== user.id) throw notFound("Account not found");

  // 取最新一条 Cookie 版本记录
  const cookieVersion = await prisma.accountCookieVersion.findFirst({
    where: { platformAccountId: account.id },
    orderBy: { createdAt: "desc" },
  });
  if (!cookieVersion) {
    const expired = await prisma.platformAccount.update({
      where: { id: account.id },
      data: { status: "expired", statusMessage: "No stored cookie version", updatedAt: shanghaiNow() },
    });
    return NextResponse.json(serializeAccount(expired));
  }

  const subType = account.subType ?? "pc";
  const cookiesText = decryptText(cookieVersion.encryptedCookies);
  try {
    // 1) 取用户信息
    let userInfo: Record<string, unknown>;
    if (subType === "creator") {
      const { XhsCreatorLoginAdapter } = await import("@/lib/server/xhs/adapters/creator-login-adapter");
      userInfo = await new XhsCreatorLoginAdapter().getUserInfo(decodeCookieText(cookiesText) as Record<string, string>);
    } else {
      const { XhsPcLoginAdapter } = await import("@/lib/server/xhs/adapters/pc-login-adapter");
      userInfo = await new XhsPcLoginAdapter().getUserInfo(decodeCookieText(cookiesText) as Record<string, string>);
    }
    // 2) PC 附加自我 profile 富化（失败静默）
    if (subType === "pc") {
      try {
        const { XhsPcApiAdapter } = await import("@/lib/server/xhs/adapters/pc-api-adapter");
        const selfProfile = await new XhsPcApiAdapter(cookieHeaderFromText(cookiesText)).getSelfInfo();
        userInfo = enrichUserInfoWithXhsSelfProfile(userInfo, selfProfile);
      } catch {
        // 富化失败不阻塞
      }
    }
    // 3) 更新账号为 active
    await prisma.platformAccount.update({
      where: { id: account.id },
      data: {
        status: "active",
        statusMessage: "",
        nickname: String(userInfo.nickname ?? account.nickname),
        avatarUrl: String(userInfo.avatar_url ?? account.avatarUrl),
        externalUserId: String(userInfo.external_user_id ?? account.externalUserId),
        profileJson: JSON.stringify(accountProfileFromUserInfo(userInfo)),
        updatedAt: shanghaiNow(),
      },
    });
    // 4) Creator 额外校验上传凭证
    if (subType === "creator") {
      try {
        const { XhsCreatorApis } = await import("@/lib/server/xhs/creator/api");
        const { XHSCreatorAuth } = await import("@/lib/server/xhs/creator/auth");
        const auth = XHSCreatorAuth.fromCookie(cookieHeaderFromText(cookiesText));
        const api = new XhsCreatorApis(auth);
        const [success, msg] = await api.getFileIds("image", decodeCookieText(cookiesText) as Record<string, string>);
        if (!success) {
          await prisma.platformAccount.update({
            where: { id: account.id },
            data: { status: "expired", statusMessage: `上传凭证获取失败: ${msg}` },
          });
        }
      } catch (uploadError) {
        await prisma.platformAccount.update({
          where: { id: account.id },
          data: { status: "expired", statusMessage: `上传凭证验证异常: ${(uploadError as Error).message}` },
        });
      }
    }
  } catch (error) {
    await prisma.platformAccount.update({
      where: { id: account.id },
      data: { status: "expired", statusMessage: (error as Error).message, updatedAt: shanghaiNow() },
    });
  }

  const refreshed = await prisma.platformAccount.findUnique({ where: { id: account.id } });
  return NextResponse.json(serializeAccount(refreshed!));
});
