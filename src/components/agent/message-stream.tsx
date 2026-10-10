"use client";
/**
 * 中栏：消息流 + 自动滚动（P1 设计稿 §5.2 / §5.4）
 *
 * 自动滚动规则：用户距底 40px 内视为「跟随」，新内容到达时自动滚到底；
 * 否则暂停跟随并显示「有新消息 ↓」按钮。
 *
 * 「是否跟随」存 ref 而不是 state：滚动 effect 只在内容变化时跑，读 state 会拿到旧闭包值。
 */
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Empty, Spin, Typography } from "antd";

import type { AgentTimelineItem } from "@/lib/agent/agent-state";
import { MessageBubble } from "./message-bubble";
import { ThinkingIndicator } from "./thinking-indicator";
import { ToolCallCard } from "./tool-call-card";

const { Text } = Typography;

interface MessageStreamProps {
  items: AgentTimelineItem[];
  executing: boolean;
  /** 事件或工具卡被服务端截断（只保留了最新一批） */
  truncated: boolean;
  loading: boolean;
}

export function MessageStream({ items, executing, truncated, loading }: MessageStreamProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  /** 上一次渲染的内容指纹（条数 + 末条 key）：只有内容真的变多才提示「有新消息」 */
  const contentRef = useRef("");
  const [hasNew, setHasNew] = useState(false);

  const handleScroll = () => {
    const element = containerRef.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    atBottomRef.current = nearBottom;
    if (nearBottom) setHasNew(false);
  };

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    // 切会话会先清空时间线（agentReducer 的 clear）：把跟随状态一并复位 ——
    // 否则在旧会话里上滚过的话，新会话会停在历史顶部并谎报「有新消息」
    // （items 为空只出现在「切会话清空」与「空会话」两种情形，运行中不会出现）
    if (items.length === 0) {
      atBottomRef.current = true;
      contentRef.current = "";
      setHasNew(false);
      return;
    }
    const fingerprint = `${items.length}:${items[items.length - 1].key}`;
    const contentChanged = fingerprint !== contentRef.current;
    contentRef.current = fingerprint;
    if (atBottomRef.current) {
      element.scrollTop = element.scrollHeight;
    } else if (contentChanged) {
      setHasNew(true);
    }
  }, [items, executing]);

  const scrollToBottom = () => {
    const element = containerRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    atBottomRef.current = true;
    setHasNew(false);
  };

  return (
    <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        // 滚轮上滚是**同步**信号：scroll 事件要等浏览器渲染阶段才派发，若一帧恰落在
        // 「用户已改 scrollTop」与「scroll 事件派发」之间，effect 会读到旧值把上滚抹掉。
        // 所以不让 atBottomRef 只由异步 scroll 事件驱动（滚回底部仍由 handleScroll 重新开启跟随）。
        onWheel={(event) => {
          if (event.deltaY < 0) {
            atBottomRef.current = false;
          }
        }}
        style={{ flex: 1, overflowY: "auto", padding: "16px 16px 12px" }}
      >
        {truncated && (
          <div style={{ textAlign: "center", marginBottom: 12 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              更早的记录已省略（服务端仅保留最新一批事件与工具卡）
            </Text>
          </div>
        )}

        {loading && items.length === 0 && (
          <div style={{ textAlign: "center", paddingTop: 48 }}>
            <Spin />
          </div>
        )}

        {!loading && items.length === 0 && (
          <div style={{ paddingTop: 48 }}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有消息，输入第一条任务开始" />
          </div>
        )}

        {items.map((item) => {
          if (item.kind === "user") {
            return <MessageBubble key={item.key} role="user" text={item.content} created_at={item.created_at} />;
          }
          if (item.kind === "assistant") {
            return <MessageBubble key={item.key} role="assistant" text={item.text} created_at={item.created_at} />;
          }
          if (item.kind === "notice") {
            return (
              <Alert
                key={item.key}
                type={item.level === "error" ? "error" : item.level === "warning" ? "warning" : "info"}
                message={item.message}
                showIcon
                style={{ marginBottom: 12 }}
              />
            );
          }
          return <ToolCallCard key={item.key} tool={item.tool} />;
        })}

        {executing && <ThinkingIndicator />}
      </div>

      {hasNew && (
        <Button
          size="small"
          type="primary"
          onClick={scrollToBottom}
          style={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)" }}
        >
          有新消息 ↓
        </Button>
      )}
    </div>
  );
}
