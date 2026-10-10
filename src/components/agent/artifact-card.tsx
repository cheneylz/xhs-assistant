"use client";
/**
 * 工件卡：点击跳对应模块
 *
 * href 由服务端拼好（skill-catalog 的 artifact.hrefPrefix + id），前端不复制映射表。
 */
import { useRouter } from "next/navigation";
import { Card, Tag, Typography } from "antd";

import type { AgentArtifactItem } from "@/types";

const { Text } = Typography;

const KIND_VIEW: Record<string, { color: string; label: string }> = {
  draft: { color: "blue", label: "草稿" },
  topic: { color: "purple", label: "选题" },
  image: { color: "magenta", label: "图片" },
  review: { color: "orange", label: "审校" },
  report: { color: "cyan", label: "报告" },
  script: { color: "geekblue", label: "脚本" },
};

export function ArtifactCard({ artifact }: { artifact: AgentArtifactItem }) {
  const router = useRouter();
  const view = KIND_VIEW[artifact.kind] ?? { color: "default", label: artifact.kind || "产出" };
  const clickable = Boolean(artifact.href);

  return (
    <Card
      size="small"
      hoverable={clickable}
      onClick={clickable ? () => router.push(artifact.href) : undefined}
      style={{ marginBottom: 8 }}
      styles={{ body: { padding: 10 } }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Tag color={view.color} style={{ marginRight: 0 }}>
          {view.label}
        </Tag>
        <Text ellipsis title={artifact.title} style={{ flex: 1, fontSize: 13, minWidth: 0 }}>
          {artifact.title || `#${artifact.id}`}
        </Text>
      </div>
      {artifact.created_at.length >= 16 && (
        <Text type="secondary" style={{ fontSize: 11 }}>
          {artifact.created_at.slice(11, 16)}
        </Text>
      )}
    </Card>
  );
}
