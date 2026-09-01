/**
 * API 错误（对应原版 fastapi.HTTPException）
 * 路由处理统一捕获并转换为 JSON 响应 {"detail": "..."}，保持 API 契约不变
 */
import type { ZodError } from "zod";
import { NextResponse } from "next/server";

export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;
  readonly headers: Record<string, string>;

  constructor(status: number, detail: unknown, headers: Record<string, string> = {}) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.headers = headers;
  }
}

/** 401 未认证 */
export function unauthorized(detail = "Not authenticated", headers: Record<string, string> = { "WWW-Authenticate": "Bearer" }): ApiError {
  return new ApiError(401, detail, headers);
}

/** 404 未找到 */
export function notFound(detail = "Not found"): ApiError {
  return new ApiError(404, detail);
}

/** 400 参数错误 */
export function badRequest(detail: string): ApiError {
  return new ApiError(400, detail);
}

/** 403 无权限 */
export function forbidden(detail = "Forbidden"): ApiError {
  return new ApiError(403, detail);
}

/** 422 校验失败 */
export function validationError(detail: string): ApiError {
  return new ApiError(422, detail);
}

/**
 * 将未知错误转换为 NextResponse（统一错误出口）
 * - ApiError -> 对应状态码与 detail
 * - 其他异常 -> 500 Internal Server Error（日志输出）
 */
export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json({ detail: error.detail }, { status: error.status, headers: error.headers });
  }
  // eslint-disable-next-line no-console
  console.error("[api] unhandled error:", error);
  return NextResponse.json({ detail: "Internal server error" }, { status: 500 });
}

/** 将 zod 校验错误信息包装为 ApiError(422) */
export function zodError(error: ZodError): ApiError {
  const messages = error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return validationError(messages.join("; ") || "Validation error");
}
