"use client";
/**
 * Agent SSE 订阅（P1 设计稿 §4.1 / D25）
 *
 * 只用 fetch + ReadableStream，不用 EventSource —— 后者无法携带 Authorization 头
 * （P0 设计稿 §9.1 已定）。逐行解析范式与 lib/api.ts 的 crawlXhsDataStream 一致。
 *
 * 职责：
 *   1. 连接 /api/agent/conversations/[id]/events?last_event_id=N，把 data: 帧交给 onEvent
 *   2. 断线重连：间隔由 nextPollInterval(hasActiveRun) 决定（与 SSE 服务端同一个纯函数）
 *   3. agent_end 帧回调 onRunEnded（循环结束的唯一可靠信号）
 *
 * 【为什么不把 lastEventId / hasActiveRun / 回调写进依赖】
 * 它们每次渲染都会变，写进依赖会导致「每一帧都重连」。用「最新值 ref」模式：
 * 渲染期同步、重连时读取；重连只由 conversationId（会话切换/快照同步完成）与
 * streamKey（发送消息后、快照替换后主动重启）触发。
 */
import { useEffect, useRef } from "react";

import { parseSseBuffer } from "@/lib/agent/agent-state";
import { nextPollInterval } from "@/lib/agent/polling";
import { getAccessToken, refreshAccessToken } from "@/lib/api";
import type { AgentEventItem } from "@/types";

interface UseAgentEventsOptions {
  /** null = 不订阅（还没选中会话、或首屏快照尚未应用） */
  conversationId: number | null;
  /** 变化即重连（abort 旧流、用当前水位新开一条） */
  streamKey: number;
  /** 重连起点：只收 id 大于它的事件（首屏快照的 latest_event_id 或已处理的最大 id） */
  lastEventId: number;
  /** 是否还有未结束的 Run —— 决定重连间隔（500ms / 5s） */
  hasActiveRun: boolean;
  onEvent: (frame: AgentEventItem) => void;
  onRunEnded: () => void;
}

export function useAgentEvents(options: UseAgentEventsOptions): void {
  // 「最新值 ref」：渲染期同步，重连时读取；这些值的更新都不触发重连
  const lastEventIdRef = useRef(options.lastEventId);
  lastEventIdRef.current = options.lastEventId;
  const hasActiveRunRef = useRef(options.hasActiveRun);
  hasActiveRunRef.current = options.hasActiveRun;
  const onEventRef = useRef(options.onEvent);
  onEventRef.current = options.onEvent;
  const onRunEndedRef = useRef(options.onRunEnded);
  onRunEndedRef.current = options.onRunEnded;

  const { conversationId, streamKey } = options;

  useEffect(() => {
    if (!conversationId) return;
    const controller = new AbortController();
    let disposed = false;

    /** 可被 cleanup 中断的等待（卸载后不残留定时器） */
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        controller.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });

    const readStreamOnce = async (): Promise<void> => {
      const token = getAccessToken();
      console.info(`[agent] SSE 订阅会话 ${conversationId}（last_event_id=${lastEventIdRef.current}）`);
      const response = await fetch(
        `/api/agent/conversations/${conversationId}/events?last_event_id=${lastEventIdRef.current}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal },
      );

      if (response.status === 401) {
        // 长连接期间 access token 可能过期：刷新一次，交给外层循环重连。
        // 刷新失败（refresh token 也没了）就停流，交给路由守卫跳登录。
        try {
          await refreshAccessToken();
        } catch {
          disposed = true;
        }
        return;
      }
      if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!disposed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { frames, rest } = parseSseBuffer(buffer);
          buffer = rest;
          for (const frame of frames) {
            if (disposed) return;
            onEventRef.current(frame);
            if (frame.type === "agent_end") onRunEndedRef.current();
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // 已在关闭流程中（有挂起的 read 时 releaseLock 会抛）
        }
      }
    };

    const run = async (): Promise<void> => {
      while (!disposed) {
        try {
          await readStreamOnce();
        } catch (error) {
          if (disposed) return;
          // aborted（切会话 / 重启流）也会走到这里：disposed 已置位时会提前返回
          if (!controller.signal.aborted) console.warn("[agent] SSE 连接中断，将重连", error);
        }
        if (disposed) return;
        // 降速重连：会话空闲 5s、执行中 500ms（与 SSE 服务端共用同一个纯函数，见 lib/agent/polling.ts）
        const delay = nextPollInterval(hasActiveRunRef.current);
        console.info(`[agent] ${delay}ms 后重连 SSE（会话 ${conversationId}）`);
        await sleep(delay);
      }
    };

    void run();

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [conversationId, streamKey]);
}
