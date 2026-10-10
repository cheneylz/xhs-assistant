"use client";
/**
 * 左栏：会话列表 + 新建 + 行内删除（P1 设计稿 §5.2 / P1-D 会话删除）
 *
 * updated_at 是「朴素上海墙钟」字符串，直接切片展示 —— 用 new Date() 解析会在
 * 非上海时区的浏览器上显示错。
 *
 * 删除入口只在悬停该行时出现（样式在 globals.css 的 .agent-conv-delete），
 * 点击必须 stopPropagation，否则会连带触发行的「选中」（P1-D 设计稿 §三.1）。
 */
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { Badge, Button, Empty, Popconfirm, Spin, Typography } from "antd";

import type { AgentConversation } from "@/types";

const { Text } = Typography;

interface ConversationListProps {
  items: AgentConversation[];
  selectedId: number | null;
  loading: boolean;
  creating: boolean;
  /** 正在删除的会话 id（该行按钮置灰，防止重复开确认框） */
  deletingId: number | null;
  onSelect: (id: number) => void;
  onCreate: () => void;
  /** 确认删除：返回 Promise —— Popconfirm 会自动给确认按钮加 loading 并在 resolve 后关闭 */
  onDelete: (id: number) => Promise<void>;
}

/** "2026-10-10T14:23:05" → "10-10 14:23" */
function formatListTime(value: string): string {
  return value.length >= 16 ? `${value.slice(5, 10)} ${value.slice(11, 16)}` : value;
}

export function ConversationList(props: ConversationListProps) {
  const { items, selectedId, loading, creating, deletingId, onSelect, onCreate, onDelete } = props;

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
              className="agent-conv-row"
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
                {/* 点击删除图标不能连带选中会话 —— 包裹层 stopPropagation */}
                <span className="agent-conv-delete" onClick={(event) => event.stopPropagation()}>
                  <Popconfirm
                    title={`确定删除会话「${item.title}」？`}
                    description="消息与工件会一并清除，不可恢复"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => onDelete(item.id)}
                  >
                    <Button
                      type="text"
                      size="small"
                      danger
                      aria-label="删除会话"
                      disabled={deletingId === item.id}
                      icon={<DeleteOutlined />}
                    />
                  </Popconfirm>
                </span>
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
