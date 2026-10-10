"use client";
/**
 * 右栏：工件面板（D20 常驻 + 空态；接口 6 仅供右栏单独刷新）
 *
 * memo：页面每帧 SSE 都会重渲染，而 artifacts 的数组引用只在「工件帧 / 快照 / 右栏刷新」时
 * 变化（噪声帧只推进水位）—— 与 MemoMessageStream / ToolCallCard 同一取舍。
 * 依赖调用方传稳定引用（页面的 handleRefreshArtifacts 是 useCallback），内联箭头会让它永远失效。
 */
import { memo } from "react";
import { ReloadOutlined } from "@ant-design/icons";
import { Button, Empty, Spin, Typography } from "antd";

import type { AgentArtifactItem } from "@/types";
import { ArtifactCard } from "./artifact-card";

const { Text } = Typography;

interface ArtifactPanelProps {
  artifacts: AgentArtifactItem[];
  truncated: boolean;
  /** 快照加载中（未选中会话时为 false）：只在列表为空时展示 spinner，避免「还没有产出物」谎报 */
  loading: boolean;
  refreshing: boolean;
  /** 未选中会话时禁用刷新（否则点了没有任何反馈） */
  disabled: boolean;
  onRefresh: () => void;
}

export const ArtifactPanel = memo(function ArtifactPanel({
  artifacts,
  truncated,
  loading,
  refreshing,
  disabled,
  onRefresh,
}: ArtifactPanelProps) {
  // 最新的排最上面（服务端按时间升序返回，展示时反转）
  const ordered = [...artifacts].reverse();

  return (
    <div
      style={{
        width: 320,
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
          产出物
        </Text>
        <Button
          type="text"
          size="small"
          icon={<ReloadOutlined />}
          loading={refreshing}
          disabled={disabled}
          onClick={onRefresh}
        />
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
        {loading && ordered.length === 0 && (
          <div style={{ paddingTop: 32, textAlign: "center" }}>
            <Spin size="small" />
          </div>
        )}
        {!loading && ordered.length === 0 && (
          <div style={{ paddingTop: 32 }}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次会话还没有产出物" />
          </div>
        )}
        {ordered.map((artifact) => (
          <ArtifactCard key={artifact.event_id} artifact={artifact} />
        ))}
        {truncated && (
          <div style={{ textAlign: "center", padding: "8px 0" }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              仅显示最新 200 条产出物
            </Text>
          </div>
        )}
      </div>
    </div>
  );
});
