/**
 * SSE 轮询间隔决策（前后端共用，P1 设计稿 D22 / D25）
 *
 * 放在 lib/agent/ 而不是 lib/server/：前端也要用它决定重连节奏，
 * 且本文件不含任何服务端依赖（prisma / node:*），可被客户端安全 import。
 *
 * 为什么服务端与前端各要一份同样的判定：服务端用它决定「多久查一次库」，
 * 前端用它决定「多久重连一次」。两者的输入都是「会话里还有没有未结束的 Run」，
 * 抽成同一个纯函数就不会漂移。
 */

/** 会话内有 pending / running 的 Run 时的快查间隔 */
export const SSE_ACTIVE_INTERVAL_MS = 500;

/**
 * 全部 Run 已结束时的降速间隔。
 * 不设这个降速，页面开着就每 500ms 空转一次数据库查询（P1 设计稿 §3.3）。
 */
export const SSE_IDLE_INTERVAL_MS = 5000;

/** 依据「会话内是否还有未结束的 Run」决定下一次轮询间隔（毫秒） */
export function nextPollInterval(hasActiveRun: boolean): number {
  return hasActiveRun ? SSE_ACTIVE_INTERVAL_MS : SSE_IDLE_INTERVAL_MS;
}
