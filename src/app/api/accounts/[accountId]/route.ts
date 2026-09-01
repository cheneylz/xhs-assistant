/**
 * 单个账号操作（对应原版 backend/app/api/accounts.py 的 update_account / delete_account）
 * URL 路径 /api/accounts/{accountId}
 */
import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { decryptText } from "@/lib/server/core/security";
import { shanghaiNow } from "@/lib/server/core/time";
import {
  accountProfileFromUserInfo,
  decodeCookieText,
  enrichUserInfoWithXhsSelfProfile,
  serializeAccount,
} from "@/lib/server/services/account-service";
import { cookieHeaderFromText } from "@/lib/server/services/account-service";
import { NextResponse } from "next/server";

/** PATCH /api/accounts/{accountId} 更新账号（与原版一致：纯桩实现，不做认证与数据库操作） */
export const PATCH = handle(async (_req, { params }) => {
  const accountId = Number.parseInt(params.accountId, 10);
  return NextResponse.json({ id: accountId, status: "updated" });
});

/** DELETE /api/accounts/{accountId} 删除账号及其全部 Cookie 版本（对应原版 delete_account） */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const accountId = Number.parseInt(params.accountId, 10);
  const account = await prisma.platformAccount.findUnique({ where: { id: accountId } });
  if (!account || account.userId !== user.id) throw notFound("Account not found");
  await prisma.accountCookieVersion.deleteMany({ where: { platformAccountId: accountId } });
  await prisma.platformAccount.delete({ where: { id: accountId } });
  return NextResponse.json({ id: accountId, status: "deleted" });
});
