import { prisma } from "@/lib/server/core/db";
import { badRequest, notFound } from "@/lib/server/core/http-error";
import { decryptText } from "@/lib/server/core/security";

function cookiesToString(value: string): string {
  const stripped = value.trim();
  if (!stripped) return stripped;
  if (stripped.startsWith("{")) {
    try {
      const cookies = JSON.parse(stripped) as Record<string, unknown>;
      return Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    } catch {
      return stripped;
    }
  }
  return stripped;
}

/** 取归属当前用户的 PC 账号 Cookie（对应 _get_owned_pc_account_cookies） */
export async function getOwnedPcAccountCookies(userId: number, accountId: number): Promise<string> {
  const account = await prisma.platformAccount.findUnique({ where: { id: accountId } });
  if (!account || account.userId !== userId || account.platform !== "xhs" || account.subType !== "pc") {
    throw notFound("Account not found");
  }
  const cookieVersion = await prisma.accountCookieVersion.findFirst({
    where: { platformAccountId: account.id },
    orderBy: { createdAt: "desc" },
  });
  if (!cookieVersion) throw badRequest("Account has no cookies");
  return cookiesToString(decryptText(cookieVersion.encryptedCookies));
}
