/**
 * 鉴权依赖（对应原版 backend/app/core/deps.py 的 get_current_user）
 * 解析 Authorization: Bearer <token>，校验 access token 并加载用户
 */
import type { NextRequest } from "next/server";
import { prisma } from "./db";
import { ApiError, unauthorized } from "./http-error";
import { decodeToken } from "./security";

/** 从请求头解析 Bearer token */
export function getBearerToken(req: NextRequest): string {
  const header = req.headers.get("authorization");
  if (!header) throw unauthorized();
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) throw unauthorized();
  return token;
}

/** 校验 access token，返回当前用户（对应原版 get_current_user） */
export async function getCurrentUser(req: NextRequest) {
  const token = getBearerToken(req);
  const payload = decodeToken(token);
  if (payload.token_type !== "access") {
    throw new ApiError(401, "Invalid access token", { "WWW-Authenticate": "Bearer" });
  }
  const user = await prisma.user.findUnique({ where: { id: payload.user_id as number } });
  if (!user) {
    throw new ApiError(401, "User not found", { "WWW-Authenticate": "Bearer" });
  }
  return user;
}

/** 管理员权限校验（S-01 两级角色：admin/user），非 admin 抛 403 */
export async function requireAdmin(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (user.role !== "admin") {
    throw new ApiError(403, "需要管理员权限");
  }
  return user;
}

/** 可选认证：有 token 则返回用户，无 token 返回 null */
export async function getOptionalUser(req: NextRequest) {
  const header = req.headers.get("authorization");
  if (!header) return null;
  try {
    const token = getBearerToken(req);
    const payload = decodeToken(token);
    if (payload.token_type !== "access") return null;
    return await prisma.user.findUnique({ where: { id: payload.user_id as number } });
  } catch {
    return null;
  }
}
