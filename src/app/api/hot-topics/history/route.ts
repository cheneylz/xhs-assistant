import { getCurrentUser } from "@/lib/server/core/auth";
import { badRequest } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { hotTopicHistory } from "@/lib/server/services/hot-topic-service";
import { NextResponse } from "next/server";

/** GET /api/hot-topics/history?keyword=&limit= 关键词热度跨批次趋势 */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const keyword = searchParams.get("keyword") ?? "";
  if (!keyword.trim()) throw badRequest("keyword 参数必填");
  const limit = Number.parseInt(searchParams.get("limit") ?? "12", 10);
  const items = await hotTopicHistory(user.id, keyword.trim(), Number.isNaN(limit) ? 12 : limit);
  return NextResponse.json({ keyword: keyword.trim(), items });
});
