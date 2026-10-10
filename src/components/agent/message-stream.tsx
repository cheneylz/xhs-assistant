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
    if (atBottomRef.current) {
      element.scrollTop = element.scrollHeight;
    } else {
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
      <div ref={containerRef} onScroll={handleScroll} style={{ flex: 1, overflowY: "auto", padding: "16px 16px 4px" }}>
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
