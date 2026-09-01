import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";

/** POST /api/notifications/read-all 全部标记已读（对应原版 mark_all_read） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const unread = await prisma.notification.findMany({
    where: { userId: user.id, read: false },
    select: { id: true },
  });
  if (unread.length > 0) {
    await prisma.notification.updateMany({
      where: { id: { in: unread.map((n) => n.id) } },
      data: { read: true },
    });
  }
  return NextResponse.json({ marked: unread.length });
});
