/**
 * 账号路由（对应原版 backend/app/api/accounts.py 的 GET /accounts）
 * POST /accounts/import-cookie 见同目录 import-cookie/route.ts
 */
import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { paginated } from "@/lib/server/core/paginate";
import { handle } from "@/lib/server/core/route";
import { serializeAccount } from "@/lib/server/services/account-service";
import { NextResponse } from "next/server";

/** GET /api/accounts 账号列表（分页，可按 platform 过滤，按创建时间倒序） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const platform = searchParams.get("platform") ?? undefined;
  const page = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(searchParams.get("page_size") ?? "20", 10);
  const accounts = await prisma.platformAccount.findMany({
    where: { userId: user.id, ...(platform ? { platform } : {}) },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(paginated(accounts.map((account) => serializeAccount(account)), page, pageSize));
});
