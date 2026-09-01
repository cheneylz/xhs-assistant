/**
 * 路由处理辅助（对应原版 FastAPI 的依赖注入 + 异常统一出口）
 * 所有 Route Handler 统一使用 handler() 包装，错误自动转为 {"detail": ...}
 */
import type { NextRequest, NextResponse } from "next/server";
import type { ZodType } from "zod";
import { ApiError, toErrorResponse, zodError } from "./http-error";

export interface RouteContext {
  /** 动态路径参数（Next.js 15+ 为 Promise） */
  params: Record<string, string>;
  /** 原始 searchParams */
  searchParams: URLSearchParams;
}

export type RouteHandler = (req: NextRequest, ctx: RouteContext) => Promise<NextResponse> | NextResponse;

/** 包装路由处理函数：统一异常转 JSON 响应 */
export function handle(fn: RouteHandler) {
  return async (req: NextRequest, context: { params: Promise<Record<string, string>> }) => {
    try {
      const params = await context.params;
      const url = new URL(req.url);
      return await fn(req, { params, searchParams: url.searchParams });
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

/** 解析 JSON 请求体（可选 zod 校验，校验失败抛 422） */
export async function readJson<T>(req: NextRequest, schema?: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ApiError(400, "Invalid JSON body");
  }
  if (schema) {
    const result = schema.safeParse(body);
    if (!result.success) throw zodError(result.error);
    return result.data;
  }
  return body as T;
}

/** 读取 multipart 表单请求体 */
export async function readFormData(req: NextRequest): Promise<FormData> {
  try {
    return await req.formData();
  } catch {
    throw new ApiError(400, "Invalid form data");
  }
}
