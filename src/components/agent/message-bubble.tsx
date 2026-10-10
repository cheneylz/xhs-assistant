"use client";
/**
 * 用户 / 助手气泡
 *
 * created_at 是「朴素上海墙钟」字符串：直接切片 HH:mm 展示，不要 new Date() 解析。
 */
import { Typography } from "antd";

const { Text } = Typography;

interface MessageBubbleProps {
  role: "user" | "assistant";
  text: string;
  created_at: string;
}

export function MessageBubble({ role, text, created_at }: MessageBubbleProps) {
  const isUser = role === "user";
  return (
    <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", marginBottom: 12 }}>
      <div style={{ maxWidth: "85%", minWidth: 0 }}>
        <div
          style={{
            background: isUser ? "#386bff" : "#ffffff",
            color: isUser ? "#ffffff" : "#1a1a1a",
            border: isUser ? "none" : "1px solid #f0f0f0",
            borderRadius: 10,
            padding: "8px 12px",
            fontSize: 13,
            lineHeight: 1.7,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {text}
        </div>
        <Text
          type="secondary"
          style={{ fontSize: 11, display: "block", marginTop: 2, textAlign: isUser ? "right" : "left" }}
        >
          {created_at.length >= 16 ? created_at.slice(11, 16) : ""}
        </Text>
      </div>
    </div>
  );
}
