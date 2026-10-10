"use client";
/**
 * 左栏：会话列表 + 新建（P1 设计稿 §5.2）
 *
 * updated_at 是「朴素上海墙钟」字符串，直接切片展示 —— 用 new Date() 解析会在
 * 非上海时区的浏览器上显示错。
 */
import { PlusOutlined } from "@ant-design/icons";
import { Badge, Button, Empty, Spin, Typography } from "antd";

import type { AgentConversation } from "@/types";

const { Text } = Typography;

interface ConversationListProps {
  items: AgentConversation[];
  selectedId: number | null;
  loading: boolean;
  creating: boolean;
  onSelect: (id: number) => void;
  onCreate: () => void;
}

/** "2026-10-10T14:23:05" → "10-10 14:23" */
function formatListTime(value: string): string {
  return value.length >= 16 ? `${value.slice(5, 10)} ${value.slice(11, 16)}` : value;
}

export function ConversationList(props: ConversationListProps) {
  const { items, selectedId, loading, creating, onSelect, onCreate } = props;

  return (
    <div
      style={{
        width: 260,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        background: "#fff",
        border: "1px solid #f0f0f0",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 12px",
          borderBottom: "1px solid #f0f0f0",
        }}
      >
        <Text strong style={{ fontSize: 14 }}>
          会话
        </Text>
        <Button size="small" type="primary" icon={<PlusOutlined />} loading={creating} onClick={onCreate}>
          新建
        </Button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
        {loading && items.length === 0 && (
          <div style={{ paddingTop: 32, textAlign: "center" }}>
            <Spin size="small" />
          </div>
        )}
        {!loading && items.length === 0 && (
          <div style={{ paddingTop: 32 }}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有会话" />
          </div>
        )}
        {items.map((item) => {
          const selected = item.id === selectedId;
          return (
            <div
              key={item.id}
              onClick={() => onSelect(item.id)}
              style={{
                padding: "8px 10px",
                marginBottom: 4,
                borderRadius: 8,
                cursor: "pointer",
                background: selected ? "#ecf0ff" : "transparent",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {item.status === "running" && <Badge status="processing" />}
                <Text
                  ellipsis
                  title={item.title}
                  style={{ flex: 1, fontSize: 13, fontWeight: selected ? 600 : 400, minWidth: 0 }}
                >
                  {item.title}
                </Text>
              </div>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {formatListTime(item.updated_at)}
              </Text>
            </div>
          );
        })}
      </div>
    </div>
  );
}
