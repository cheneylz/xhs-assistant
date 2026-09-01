import { getCurrentUser } from "@/lib/server/core/auth";
import { handle, readJson } from "@/lib/server/core/route";
import { normalizeDetailPayload } from "@/lib/server/services/crawl-normalizers";
import { serializeTask } from "@/lib/server/services/task-serializer";
import { NextResponse } from "next/server";
import { z } from "zod";
import { completeTask, createCrawlTask, getOwnedPcAccount, getPcCookies, saveNormalizedNotes, serializeNote } from "../shared";

const CrawlNoteUrlsSchema = z.object({
  account_id: z.number().int(),
  urls: z.array(z.string()).min(1).max(50),
  save_to_library: z.boolean().default(true),
  fetch_comments: z.boolean().default(false),
});

/** POST /api/xhs/crawl/note-urls 批量笔记 URL 爬取（对应原版 crawl_note_urls） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, CrawlNoteUrlsSchema);
  const account = await getOwnedPcAccount(user.id, payload.account_id);
  const cookies = await getPcCookies(account.id);
  const task = await createCrawlTask(user.id, "note_urls", {
    account_id: account.id,
    url_count: payload.urls.length,
  });

  const { XhsPcApiAdapter } = await import("@/lib/server/xhs/adapters/pc-api-adapter");
  const adapter = new XhsPcApiAdapter(cookies);
  const normalizedItems: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, string>> = [];
  for (const url of payload.urls) {
    const [success, message, rawPayload] = await adapter.getNoteInfo(url);
    if (success) {
      normalizedItems.push(normalizeDetailPayload((rawPayload ?? {}) as Record<string, unknown>));
    } else {
      errors.push({ url, error: message || "XHS note detail crawl failed" });
    }
  }

  const savedNotes = payload.save_to_library ? await saveNormalizedNotes(account, normalizedItems) : [];
  await completeTask(task.id, { result_count: normalizedItems.length, saved_count: savedNotes.length, errors });
  const { prisma } = await import("@/lib/server/core/db");
  const completedTask = await prisma.task.findUnique({ where: { id: task.id } });
  return NextResponse.json({
    task: completedTask ? serializeTask(completedTask) : null,
    result_count: normalizedItems.length,
    saved_count: savedNotes.length,
    errors,
    items: savedNotes.map(serializeNote),
  });
});
