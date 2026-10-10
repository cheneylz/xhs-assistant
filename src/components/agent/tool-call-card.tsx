"use client";
/**
 * 工具卡（D21：摘要卡片，摘要由服务端算好）
 *
 * 4 种状态都要渲染正确（§7.2 第 3 条）：运行中 / 成功 / 失败 / 被护栏阻断。
 * 状态来自 agent_tool_calls.status；摘要来自服务端（前端不得 import skill-catalog）。
 * 展示派生（状态映射 / 耗时格式 / 截断与序列化）抽在 lib/agent/tool-card-view.ts，有 vitest 覆盖。
 */
import { memo, useState } from "react";
import type { CSSProperties } from "react";
import { Button, Card, Tag, Typography } from "antd";

import type { AgentToolCard } from "@/lib/agent/agent-state";
import {
  formatToolDuration,
  resultTextForDisplay,
  statusViewFor,
  stringifyForDisplay,
} from "@/lib/agent/tool-card-view";

const { Text } = Typography;

/**
 * memo：工具卡的更新是按 `tool` 对象身份保留的（upsertToolCard 只替换被更新的那张卡），
 * 其余卡片对象引用不变 —— 包一层可跳过一次流事件里其余卡片的整棵子树重渲染。
 */
export const ToolCallCard = memo(function ToolCallCard({ tool }: { tool: AgentToolCard }) {
  const [expanded, setExpanded] = useState(false);
  const view = statusViewFor(tool.status);
  const duration = formatToolDuration(tool.durationMs);

  return (
    <Card size="small" style={{ marginBottom: 12 }} styles={{ body: { padding: 10 } }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Tag color={view.color} style={{ marginRight: 0 }}>
          {view.label}
        </Tag>
        <Text code style={{ fontSize: 12 }}>
          {tool.toolName}
        </Text>
        {duration !== null && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {duration}
          </Text>
        )}
        <span style={{ flex: 1 }} />
        <Button type="text" size="small" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起" : "详情"}
        </Button>
      </div>

      {tool.summary && <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.6 }}>{tool.summary}</div>}

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
            结果{tool.resultTruncated ? "（服务端已截断，仅存前 4000 字符的紧凑 JSON）" : ""}
          </Text>
          <pre style={preStyle}>{resultTextForDisplay(tool)}</pre>
        </div>
      )}
    </Card>
  );
});

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
