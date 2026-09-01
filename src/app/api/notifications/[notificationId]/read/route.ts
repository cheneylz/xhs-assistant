import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
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

/** POST /api/notifications/{notificationId}/read 标记单条通知已读（对应原版 mark_read） */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const notificationId = Number.parseInt(params.notificationId, 10);
  const notification = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (!notification || notification.userId !== user.id) {
    throw notFound("Notification not found");
  }
  const updated = await prisma.notification.update({
    where: { id: notification.id },
    data: { read: true },
  });
  return NextResponse.json(serializeNotification(updated));
});
