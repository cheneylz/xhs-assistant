"use client";
/**
 * 右栏：工件面板（D20 常驻 + 空态；接口 6 仅供右栏单独刷新）
 */
import { ReloadOutlined } from "@ant-design/icons";
import { Button, Empty, Typography } from "antd";

import type { AgentArtifactItem } from "@/types";
import { ArtifactCard } from "./artifact-card";

const { Text } = Typography;

interface ArtifactPanelProps {
  artifacts: AgentArtifactItem[];
  truncated: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}

export function ArtifactPanel({ artifacts, truncated, refreshing, onRefresh }: ArtifactPanelProps) {
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
        <Button type="text" size="small" icon={<ReloadOutlined />} loading={refreshing} onClick={onRefresh} />
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
        {ordered.length === 0 && (
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
}
