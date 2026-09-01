/**
 * 发布模块序列化器（publish 路由与调度共用，避免跨目录路由 import）
 */
import { formatDateTime } from "../core/time";

export function loadPublishOptions(publishOptions: string): Record<string, unknown> {
  try {
    const options = JSON.parse(publishOptions || "{}");
    return options && typeof options === "object" && !Array.isArray(options) ? options : {};
  } catch {
    return {};
  }
}

export function serializePublishJob(job: {
  id: number;
  platformAccountId: number | null;
  sourceDraftId: number | null;
  platform: string;
  title: string;
  body: string;
  publishMode: string;
  publishOptions: string;
  status: string;
  gateStatus: string;
  scheduledAt: Date | null;
  externalNoteId: string;
  publishError: string;
  publishedAt: Date | null;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: job.id,
    platform_account_id: job.platformAccountId,
    source_draft_id: job.sourceDraftId,
    platform: job.platform,
    title: job.title,
    body: job.body,
    publish_mode: job.publishMode,
    publish_options: loadPublishOptions(job.publishOptions),
    status: job.status,
    gate_status: job.gateStatus,
    scheduled_at: job.scheduledAt ? formatDateTime(job.scheduledAt) : null,
    external_note_id: job.externalNoteId,
    publish_error: job.publishError,
    published_at: job.publishedAt ? formatDateTime(job.publishedAt) : null,
    created_at: formatDateTime(job.createdAt),
  };
}

export function serializePublishAsset(asset: {
  id: number;
  publishJobId: number;
  assetType: string;
  filePath: string;
  uploadStatus: string;
  creatorMediaId: string;
  uploadError: string;
  creatorUploadInfo: string;
}): Record<string, unknown> {
  let creatorUploadInfo: unknown = {};
  try {
    creatorUploadInfo = JSON.parse(asset.creatorUploadInfo || "{}");
  } catch {
    creatorUploadInfo = {};
  }
  return {
    id: asset.id,
    publish_job_id: asset.publishJobId,
    asset_type: asset.assetType,
    file_path: asset.filePath,
    upload_status: asset.uploadStatus,
    creator_media_id: asset.creatorMediaId,
    upload_error: asset.uploadError,
    creator_upload_info: creatorUploadInfo,
  };
}
