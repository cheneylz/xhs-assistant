"use client";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import type { ReactNode } from "react";

/**
 * 全局主题：仅保留小红书创作平台浅色风格（参考 html/xhs.html 色板）。
 * 色板事实源见 docs/UI_THEME.md。
 */
const xhsTokens = {
  colorPrimary: "#386bff",
  colorInfo: "#386bff",
  colorLink: "#386bff",
  colorSuccess: "#00ab46",
  colorWarning: "#fd6321",
  colorError: "#fb3367",
  colorBgBase: "#ffffff",
  colorBgLayout: "#f5f5f5",
  colorBgContainer: "#ffffff",
  colorBgElevated: "#ffffff",
  colorBorder: "#e8e8e8",
  colorBorderSecondary: "#f0f0f0",
  colorText: "#1a1a1a",
  colorTextSecondary: "#3d3d3d",
  colorTextTertiary: "#8f8f8f",
  colorTextQuaternary: "#c8c8c8",
  colorSplit: "#f0f0f0",
  borderRadius: 8,
  borderRadiusLG: 12,
  borderRadiusSM: 6,
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif',
};

const xhsComponents = {
  Layout: { siderBg: "#ffffff", headerBg: "#ffffff", bodyBg: "#f5f5f5" },
  Menu: {
    itemBg: "transparent",
    itemColor: "#3d3d3d",
    itemHoverBg: "#f5f7ff",
    itemHoverColor: "#386bff",
    itemSelectedBg: "#ecf0ff",
    itemSelectedColor: "#386bff",
    itemHeight: 40,
    itemBorderRadius: 8,
  },
  Card: { headerBg: "#ffffff", colorBorderSecondary: "#f0f0f0" },
  Table: { headerBg: "#fafafa", headerColor: "#3d3d3d", rowHoverBg: "#f5f7ff" },
  Segmented: {
    trackBg: "#f2f2f2",
    itemSelectedBg: "#ffffff",
    itemSelectedColor: "#1a1a1a",
  },
  Badge: { colorError: "#ff2442" },
};

type AppProvidersProps = { children: ReactNode };

export function AppProviders({ children }: AppProvidersProps) {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: xhsTokens,
        components: xhsComponents,
      }}
    >
      <App>{children}</App>
    </ConfigProvider>
  );
}
