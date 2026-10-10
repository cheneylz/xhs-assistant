"use client";
/**
 * 用户 / 助手气泡
 *
 * created_at 是「朴素上海墙钟」字符串：直接切片 HH:mm 展示，不要 new Date() 解析。
 * 助手文本按 markdown 渲染（react-markdown + remark-gfm：表格/列表/代码块等），
 * 用户消息保持纯文本 —— 用户输入里的 `#` / `*` 不该被当语法解析。
 * 样式在 globals.css 的 `.agent-markdown`（项目既有的全局样式落点）。
 */
import { memo } from "react";
import { Typography } from "antd";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const { Text } = Typography;

interface MessageBubbleProps {
  role: "user" | "assistant";
  text: string;
  created_at: string;
}

/**
 * memo：时间线每次变化都会重渲染整棵 MessageStream，而助手气泡要跑一遍
 * micromark→hast→React 元素（比纯文本重两个数量级）—— props 是三个原始值，
 * memo 可让未变更的气泡跳过解析（与 ToolCallCard / ArtifactPanel 同一取舍）。
 */
export const MessageBubble = memo(function MessageBubble({ role, text, created_at }: MessageBubbleProps) {
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
            ...(isUser ? { whiteSpace: "pre-wrap", wordBreak: "break-word" } : {}),
          }}
        >
          {isUser ? (
            text
          ) : (
            <div className="agent-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
            </div>
          )}
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
});
