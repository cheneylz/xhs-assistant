"use client";
/** 执行中态（§5.2：思考指示器） */
import { Spin, Typography } from "antd";

const { Text } = Typography;

export function ThinkingIndicator({ label = "正在执行…" }: { label?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
      <Spin size="small" />
      <Text type="secondary" style={{ fontSize: 13 }}>
        {label}
      </Text>
    </div>
  );
}
