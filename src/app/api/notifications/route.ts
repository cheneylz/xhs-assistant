import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { ApiError } from "@/lib/server/core/http-error";
import { paginated } from "@/lib/server/core/paginate";
import { handle } from "@/lib/server/core/route";
import { formatDateTime } from "@/lib/server/core/time";
import { NextResponse } from "next/server";

/** 序列化通知（响应字段与原版 serialize_notification 一致） */
function serializeNotification(n: {
  id: number;
  title: string;
  body: string;
  level: string;
  sourceTaskId: number | null;
  sourceType: string | null;
  sourceId: number | null;
  read: boolean;
  createdAt: Date;
}) {
  return {
    id: n.id,
    title: n.title,
    body: n.body,
    level: n.level,
    source_task_id: n.sourceTaskId,
    source_type: n.sourceType,
    source_id: n.sourceId,
    read: n.read,
    created_at: formatDateTime(n.createdAt),
  };
}

/** GET /api/notifications 通知列表（支持 unread 过滤，按创建时间倒序，对应原版 list_notifications） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  // unread 仅当显式为 true 时过滤未读（与原版 `if unread is True` 语义一致）
  const unreadRaw = searchParams.get("unread");
  let unread: boolean | undefined;
  if (unreadRaw !== null) {
    if (unreadRaw === "true" || unreadRaw === "1") unread = true;
    else if (unreadRaw === "false" || unreadRaw === "0") unread = false;
    else throw new ApiError(422, "unread must be a boolean");
  }
  const page = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(searchParams.get("page_size") ?? "20", 10);
  const notifications = await prisma.notification.findMany({
    where: { userId: user.id, ...(unread === true ? { read: false } : {}) },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(paginated(notifications.map(serializeNotification), page, pageSize));
});
