/**
 * Agent 自定义消息类型声明合并
 *
 * Pi 允许应用通过 declaration merging 扩展 AgentMessage 联合类型，
 * 用于携带 UI 专用消息（工件卡片、系统通知）。
 *
 * 【本文件含 Pi 依赖】—— 仅 worker 侧使用，Next.js 侧禁止 import。
 */
import type { ArtifactKind } from "./skill-catalog";

/** 工件卡片：工具产出物在右栏工件面板的展示数据 */
export interface ArtifactMessage {
  role: "artifact";
  // 复用 skill-catalog 的 ArtifactKind，避免同一个联合类型有两处定义而漂移
  kind: ArtifactKind;
  id: number;
  title: string;
  href: string;
  timestamp: number;
}

/** 系统通知：护栏触发、崩溃恢复等非模型产生的提示 */
export interface NotificationMessage {
  role: "notification";
  level: "info" | "warning" | "error";
  text: string;
  timestamp: number;
}

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    artifact: ArtifactMessage;
    notification: NotificationMessage;
  }
}
