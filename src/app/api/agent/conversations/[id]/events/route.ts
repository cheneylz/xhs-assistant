import { getCurrentUser } from "@/lib/server/core/auth";
import { notFound } from "@/lib/server/core/http-error";
import { handle, parsePathId } from "@/lib/server/core/route";
import {
  attachToolCallSummaries,
  collectToolCallIds,
  encodeSseFrame,
  SSE_HEARTBEAT_FRAME,
  SSE_HEARTBEAT_MS,
} from "@/lib/server/agent/stream-events";
import {
  findConversationForUser,
  findToolCallSummaries,
  isRunTerminal,
  listEventsAfter,
  listRuns,
} from "@/lib/server/services/agent-service";
import { nextPollInterval } from "@/lib/agent/polling";
import { serializeEvent } from "../../../shared";

/**
 * 每个请求都必须动态执行：SSE 一旦被静态优化或缓存，客户端就再也拿不到新事件。
 */
export const dynamic = "force-dynamic";

/** 单批最多推送的事件数（一次运行的事件量远小于此，批量只是防御性上限） */
const BATCH_LIMIT = 200;

/** 可中止的睡眠：客户端断开时立刻返回，不留悬挂的定时器 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * GET /api/agent/conversations/[id]/events  SSE 订阅（接口 5）
 *
 * 服务端每 500ms 查一次 agent_events 的新事件再转发（D22：API 轮询数据库，
 * 与 D15「worker 3s 轮询」同一哲学，零新依赖）：
 *   - 帧格式 `data: <json>\n\n`，json 里带 id —— 客户端手工解析，断线重连复用同一个 last_event_id
 *   - 心跳 `: ping\n\n` 每 15s，防中间层掐长连接
 *   - 会话内没有 pending/running 的 Run 时降速到 5s，避免页面挂着空转（§3.3）
 *
 * 认证沿用 fetch + Authorization: Bearer（EventSource 无法携带自定义 header，P0 设计稿 §9.1）。
 * 前端拿首屏的 latest_event_id 作为起点，只渲染 id 大于它的事件，因此首屏与订阅之间
 * 的时间窗不会导致重复渲染（§4.4）。
 *
 * 注意：`handle()` 的 try/catch 覆盖不到流开始之后的异常 —— 流一旦作为 Response 返回，
 * 后续的异步异常必须在这里自己捕获并收尾（见下方 pump 的 try/catch）。
 */
export const GET = handle(async (req, { params, searchParams }) => {
  const user = await getCurrentUser(req);
  const conversationId = parsePathId(params.id, "会话 id");
  // 归属校验必须在流开始**之前**：流一旦开始就无法再改状态码
  const conversation = await findConversationForUser(conversationId, user.id);
  if (!conversation) throw notFound("会话不存在");

  const rawLastId = Number.parseInt(searchParams.get("last_event_id") ?? "0", 10);
  let lastId = Number.isNaN(rawLastId) || rawLastId < 0 ? 0 : rawLastId;
  let cancelled = false;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        let lastHeartbeatAt = Date.now();
        try {
          while (!cancelled && !req.signal.aborted) {
            const runs = await listRuns(conversationId);
            const runIds = runs.map((run) => run.id);
            const hasActiveRun = runs.some((run) => !isRunTerminal(run.status));

            if (runIds.length > 0) {
              const rows = await listEventsAfter(runIds, lastId, BATCH_LIMIT);
              if (rows.length > 0) {
                // 补摘要：前端不能 import skill-catalog（会把 prisma 打进客户端包），
                // 而工具的摘要在循环侧写不进事件（subscribe 只能观察），只能在这里补齐。
                // 查库要连 runIds 一起传：返回的 Map 用 `runId:toolCallId` 复合键，
                // 否则同会话两个 Run 的同名 call_1 会互相串摘要。
                const summaries = await findToolCallSummaries(runIds, collectToolCallIds(rows));
                for (const row of attachToolCallSummaries(rows, summaries)) {
                  controller.enqueue(encoder.encode(encodeSseFrame(serializeEvent(row))));
                }
                lastId = rows[rows.length - 1].id;
              }
            }

            if (Date.now() - lastHeartbeatAt >= SSE_HEARTBEAT_MS) {
              controller.enqueue(encoder.encode(SSE_HEARTBEAT_FRAME));
              lastHeartbeatAt = Date.now();
            }

            await sleep(nextPollInterval(hasActiveRun), req.signal);
          }
        } catch (error) {
          // 流已开始，改不了状态码：记日志并结束流，客户端按断线重连处理
          console.error("[agent] SSE 流异常结束", error);
        } finally {
          try {
            controller.close();
          } catch {
            // 已关闭（客户端断开后 enqueue 会抛，close 同样可能抛）
          }
        }
      })();
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
});
