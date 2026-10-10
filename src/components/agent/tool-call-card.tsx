"use client";
/**
 * 工具卡（D21：摘要卡片，摘要由服务端算好）
 *
 * 4 种状态都要渲染正确（§7.2 第 3 条）：运行中 / 成功 / 失败 / 被护栏阻断。
 * 状态来自 agent_tool_calls.status；摘要来自服务端（前端不得 import skill-catalog）。
 */
import { useState } from "react";
import type { CSSProperties } from "react";
import { Button, Card, Tag, Typography } from "antd";

import type { AgentToolCard } from "@/lib/agent/agent-state";

const { Text } = Typography;

/** 详情区展示上限（首屏的 result 已由服务端截到 4000 字符；SSE 帧的 result 未截，这里兜底） */
const DETAIL_TEXT_LIMIT = 4000;

const STATUS_VIEW: Record<string, { color: string; label: string }> = {
  running: { color: "processing", label: "运行中" },
  succeeded: { color: "success", label: "成功" },
  failed: { color: "error", label: "失败" },
  blocked: { color: "warning", label: "被阻断" },
};

function stringifyForDisplay(value: Record<string, unknown> | null): string {
  if (!value) return "（无）";
  const text = JSON.stringify(value, null, 2);
  return text.length > DETAIL_TEXT_LIMIT ? `${text.slice(0, DETAIL_TEXT_LIMIT)}\n…（已省略）` : text;
}

export function ToolCallCard({ tool }: { tool: AgentToolCard }) {
  const [expanded, setExpanded] = useState(false);
  const view = STATUS_VIEW[tool.status] ?? { color: "default", label: tool.status };

  return (
    <Card size="small" style={{ marginBottom: 12 }} styles={{ body: { padding: 10 } }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Tag color={view.color} style={{ marginRight: 0 }}>
          {view.label}
        </Tag>
        <Text code style={{ fontSize: 12 }}>
          {tool.toolName}
        </Text>
        {tool.durationMs !== null && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {(tool.durationMs / 1000).toFixed(1)}s
          </Text>
        )}
        <span style={{ flex: 1 }} />
        <Button type="text" size="small" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起" : "详情"}
        </Button>
      </div>

      {tool.summary && (
        <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.6 }}>{tool.summary}</div>
      )}

      {expanded && (
        <div style={{ marginTop: 8, borderTop: "1px solid #f0f0f0", paddingTop: 8 }}>
          {tool.errorType && (
            <div style={{ marginBottom: 6 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                错误类型：{tool.errorType}
              </Text>
            </div>
          )}
          <Text type="secondary" style={{ fontSize: 12 }}>
            入参
          </Text>
          <pre style={preStyle}>{stringifyForDisplay(tool.params)}</pre>
          <Text type="secondary" style={{ fontSize: 12 }}>
            结果{tool.resultTruncated ? "（服务端已截断到 4000 字符）" : ""}
          </Text>
          <pre style={preStyle}>{stringifyForDisplay(tool.result)}</pre>
        </div>
      )}
    </Card>
  );
}

const preStyle: CSSProperties = {
  margin: "4px 0 10px",
  padding: 8,
  background: "#fafafa",
  border: "1px solid #f0f0f0",
  borderRadius: 6,
  fontSize: 12,
  lineHeight: 1.5,
  maxHeight: 240,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};
