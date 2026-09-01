"use client";
import axios from "axios";
import { message } from "antd";

import type {
  AuthPayload,
  AutoTask,
  AutoTaskCreatePayload,
  AutoTaskRunResult,
  AutoTaskUpdatePayload,
  AnalyticsCommentInsight,
  AnalyticsHotTopic,
  AnalyticsReportPayload,
  AnalyticsReportResponse,
  AnalyticsTopContent,
  AppNotification,
  ComplianceRule,
  ComplianceRulePayload,
  FewShotNote,
  HotTopicEntry,
  HotTopicHistoryItem,
  HotTopicsResponse,
  ExplosionReport,
  TopicSuggestion,
  ScheduleSuggestion,
  AttributionConclusion,
  CommentReply,
  CommentReplyRule,
  WorkflowDef,
  WorkflowRunResult,
  WorkflowRunRecord,
  SkillItem,
  UsageSummary,
  AccountHealth,
  KnowledgeBase,
  NotePack,
  ReviewJob,
  SubmitReviewPayload,
  BenchmarkCreateDraftsResponse,
  BenchmarkOverview,
  BatchCreateDraftsPayload,
  BatchCreateDraftsResponse,
  BatchTagNotesPayload,
  BatchTagNotesResponse,
  ComposeImagePayload,
  CreateDraftPayload,
  DashboardOverview,
  Draft,
  DescribeImagePayload,
  GenerateNotePayload,
  GenerateCoverPayload,
  GenerateImagePayload,
  GenerateImageResult,
  GeneratedImageAsset,
  GenerateTagsPayload,
  GenerateTitlePayload,
  ImageUtilityFile,
  KeywordGroup,
  KeywordGroupDetail,
  KeywordGroupPayload,
  ModelConfig,
  ModelConfigPayload,
  ModelType,
  MonitoringNote,
  MonitoringRefreshResponse,
  MonitoringSnapshot,
  MonitoringTarget,
  MonitoringTargetPayload,
  NoteAsset,
  NoteComment,
  NotesExportPayload,
  NotesExportResponse,
  Paginated,
  PlatformAccount,
  PlatformUser,
  PublishAsset,
  PublishAssetPayload,
  PublishJob,
  PublishJobUpdatePayload,
  PolishTextPayload,
  ResizeImagePayload,
  RewriteDraftPayload,
  RunDueTasksResponse,
  SchedulerStatus,
  SavedNote,
  SaveNotesResponse,
  SendDraftToPublishPayload,
  Tag,
  UserImageFile,
  UserVideoFile,
  VideoCompliance,
  VideoComplianceItem,
  VideoCoverResult,
  VideoDetectResult,
  VideoMetadataResult,
  VideoTranscodeResult,
  TagPayload,
  TaskRecord,
  XhsNoteSearchResponse,
  XhsDataCrawlItem,
  XhsDataCrawlPayload,
  XhsDataCrawlResponse,
  XhsSearchOptions,
  XhsSearchNote,
  XhsQrLoginSession
} from "@/types";

const http = axios.create({
  baseURL: "/api",
  timeout: 120000,
});

const REFRESH_TOKEN_KEY = "xhs_crawer_refresh_token";
let accessToken: string | null = null;

export type AuthCredentials = {
  username: string;
  password: string;
};

export function getAccessToken(): string | null {
  return accessToken;
}

export function hasRefreshToken(): boolean {
  return typeof window !== "undefined" && Boolean(window.localStorage.getItem(REFRESH_TOKEN_KEY));
}

function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(REFRESH_TOKEN_KEY);
}

function setAccessToken(token: string | null): void {
  accessToken = token;
}

function persistAuthPayload(payload: AuthPayload): AuthPayload {
  setAccessToken(payload.access_token);
  if (payload.refresh_token) {
    if (typeof window !== "undefined") window.localStorage.setItem(REFRESH_TOKEN_KEY, payload.refresh_token);
  }
  return payload;
}

export function clearAuthTokens(): void {
  setAccessToken(null);
  if (typeof window !== "undefined") window.localStorage.removeItem(REFRESH_TOKEN_KEY);
}

http.interceptors.request.use((config) => {
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

http.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config as typeof error.config & { _authRetry?: boolean; _silent?: boolean };
    if (error.response?.status !== 401 || originalRequest?._authRetry || !getRefreshToken()) {
      if (!originalRequest?._silent) {
        const detail = error.response?.data?.detail;
        const msg = typeof detail === "string" ? detail : "请求失败，请稍后重试";
        message.error(msg);
      }
      return Promise.reject(error);
    }

    originalRequest._authRetry = true;
    try {
      const token = await refreshAccessToken();
      originalRequest.headers.Authorization = `Bearer ${token}`;
      return http(originalRequest);
    } catch (refreshError) {
      clearAuthTokens();
      message.error("登录已过期，请重新登录");
      return Promise.reject(refreshError);
    }
  }
);

export async function login(credentials: AuthCredentials): Promise<AuthPayload> {
  const response = await http.post<AuthPayload>("/auth/login", credentials);
  return persistAuthPayload(response.data);
}

export async function register(credentials: AuthCredentials): Promise<AuthPayload> {
  const response = await http.post<AuthPayload>("/auth/register", credentials);
  return persistAuthPayload(response.data);
}

export async function refreshAccessToken(): Promise<string> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    throw new Error("Missing refresh token");
  }

  const response = await http.post<{ access_token: string; token_type: "bearer" }>("/auth/refresh", {
    refresh_token: refreshToken
  });
  setAccessToken(response.data.access_token);
  return response.data.access_token;
}

export async function fetchMe(): Promise<PlatformUser> {
  const response = await http.get<PlatformUser>("/auth/me");
  return response.data;
}

export async function bootstrapAuth(): Promise<PlatformUser | null> {
  if (!getAccessToken() && hasRefreshToken()) {
    await refreshAccessToken();
  }
  if (!getAccessToken()) {
    return null;
  }
  return fetchMe();
}

export async function logout(): Promise<void> {
  try {
    await http.post("/auth/logout");
  } finally {
    clearAuthTokens();
  }
}

export async function fetchXhsOverview(): Promise<DashboardOverview> {
  const response = await http.get<DashboardOverview>("/xhs/analytics/overview");
  return response.data;
}

export async function fetchXhsTopContent(): Promise<{ items: AnalyticsTopContent[] }> {
  const response = await http.get<{ items: AnalyticsTopContent[] }>("/xhs/analytics/top-content");
  return response.data;
}

export async function fetchXhsHotTopics(): Promise<{ items: AnalyticsHotTopic[] }> {
  const response = await http.get<{ items: AnalyticsHotTopic[] }>("/xhs/analytics/hot-topics");
  return response.data;
}

export async function fetchXhsCommentInsights(): Promise<AnalyticsCommentInsight> {
  const response = await http.get<AnalyticsCommentInsight>("/xhs/analytics/comment-insights");
  return response.data;
}

export async function fetchXhsBenchmarks(): Promise<BenchmarkOverview> {
  const response = await http.get<BenchmarkOverview>("/xhs/analytics/benchmarks");
  return response.data;
}

export async function createBenchmarkDrafts(targetId: number, limit = 5): Promise<BenchmarkCreateDraftsResponse> {
  const response = await http.post<BenchmarkCreateDraftsResponse>(
    `/xhs/analytics/benchmarks/${targetId}/create-drafts`,
    null,
    { params: { limit } }
  );
  return response.data;
}

export async function createXhsAnalyticsReport(
  payload: AnalyticsReportPayload = { format: "json" }
): Promise<AnalyticsReportResponse> {
  const response = await http.post<AnalyticsReportResponse>("/xhs/analytics/reports", payload);
  return response.data;
}

export async function fetchAccounts(platform = "xhs"): Promise<PlatformAccount[]> {
  const response = await http.get<Paginated<PlatformAccount>>("/accounts", { params: { platform } });
  return response.data.items;
}

export type SavedNoteFilters = {
  platform?: string;
  q?: string;
  tag_id?: number;
  has_assets?: boolean;
  has_comments?: boolean;
  page_size?: number;
};

export async function fetchSavedNoteIds(platform = "xhs"): Promise<string[]> {
  const response = await http.get<{ items: string[] }>("/notes/ids", { params: { platform } });
  return response.data.items;
}

export async function fetchSavedNotes(platformOrFilters: string | SavedNoteFilters = "xhs"): Promise<Paginated<SavedNote>> {
  const params =
    typeof platformOrFilters === "string"
      ? { platform: platformOrFilters }
      : {
          platform: platformOrFilters.platform ?? "xhs",
          q: platformOrFilters.q || undefined,
          tag_id: platformOrFilters.tag_id,
          has_assets: platformOrFilters.has_assets,
          has_comments: platformOrFilters.has_comments,
          page_size: platformOrFilters.page_size,
        };
  const response = await http.get<Paginated<SavedNote>>("/notes", { params });
  return response.data;
}

export async function fetchSavedNote(noteId: number, silent = false): Promise<SavedNote> {
  const response = await http.get<SavedNote>(`/notes/${noteId}`, { _silent: silent } as never);
  return response.data;
}

export async function fetchSavedNoteAssets(noteId: number): Promise<Paginated<NoteAsset>> {
  const response = await http.get<Paginated<NoteAsset>>(`/notes/${noteId}/assets`);
  return response.data;
}

export async function addNoteAsset(noteId: number, payload: { asset_type: string; url?: string; local_path?: string }): Promise<NoteAsset> {
  const response = await http.post<NoteAsset>(`/notes/${noteId}/assets`, payload);
  return response.data;
}

export async function deleteNoteAsset(noteId: number, assetId: number): Promise<void> {
  await http.delete(`/notes/${noteId}/assets/${assetId}`);
}

export async function reorderNoteAssets(noteId: number, assetIds: number[]): Promise<void> {
  await http.put(`/notes/${noteId}/assets/reorder`, { asset_ids: assetIds });
}

export async function fetchSavedNoteComments(noteId: number, page = 1): Promise<Paginated<NoteComment>> {
  const response = await http.get<Paginated<NoteComment>>(`/notes/${noteId}/comments`, {
    params: { page, page_size: 50 }
  });
  return response.data;
}

export async function deleteSavedNote(noteId: number): Promise<{ id: number; status: string }> {
  const response = await http.delete<{ id: number; status: string }>(`/notes/${noteId}`);
  return response.data;
}

export async function fetchTags(): Promise<Paginated<Tag>> {
  const response = await http.get<Paginated<Tag>>("/tags");
  return response.data;
}

export async function createTag(payload: TagPayload): Promise<Tag> {
  const response = await http.post<Tag>("/tags", payload);
  return response.data;
}

export async function batchTagNotes(payload: BatchTagNotesPayload): Promise<BatchTagNotesResponse> {
  const response = await http.post<BatchTagNotesResponse>("/notes/batch-tag", payload);
  return response.data;
}

export async function batchCreateDraftsFromNotes(
  payload: BatchCreateDraftsPayload
): Promise<BatchCreateDraftsResponse> {
  const response = await http.post<BatchCreateDraftsResponse>("/notes/batch-create-drafts", payload);
  return response.data;
}

export async function exportSavedNotes(payload: NotesExportPayload): Promise<NotesExportResponse> {
  const response = await http.post<NotesExportResponse>("/notes/export", payload);
  return response.data;
}

export async function downloadExportFile(downloadUrl: string, fileName: string): Promise<void> {
  const endpoint = downloadUrl.startsWith("/api") ? downloadUrl.slice(4) : downloadUrl;
  const response = await http.get<Blob>(endpoint, { responseType: "blob" });
  const objectUrl = window.URL.createObjectURL(response.data);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(objectUrl);
}

export async function downloadMediaFile(downloadUrl: string, fileName: string): Promise<void> {
  return downloadExportFile(downloadUrl, fileName);
}

export type UploadedFile = {
  file_name: string;
  file_path: string;
  download_url: string;
  asset_type: "image" | "video";
  size: number;
};

export async function uploadAssetFile(file: File): Promise<UploadedFile> {
  const formData = new FormData();
  formData.append("file", file);
  const response = await http.post<UploadedFile>("/files/upload", formData, {
    headers: { "Content-Type": "multipart/form-data" },
    timeout: 120000,
  });
  return response.data;
}

export async function createMediaObjectUrl(downloadUrl: string): Promise<string> {
  const endpoint = downloadUrl.startsWith("/api") ? downloadUrl.slice(4) : downloadUrl;
  const response = await http.get<Blob>(endpoint, { responseType: "blob" });
  return window.URL.createObjectURL(response.data);
}

export async function searchXhsNotes(payload: XhsSearchOptions): Promise<XhsNoteSearchResponse> {
  const response = await http.post<XhsNoteSearchResponse>("/xhs/pc/search/notes", payload);
  return response.data;
}

export async function crawlXhsDataStream(
  payload: XhsDataCrawlPayload,
  onItem: (index: number, item: XhsDataCrawlItem) => void,
  onProgress?: (message: string) => void,
  onError?: (message: string) => void,
): Promise<{ total: number; success_count: number; failed_count: number }> {
  const token = getAccessToken();
  const response = await fetch("/api/xhs/crawl/data", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { detail?: string }).detail || `HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response stream");
  const decoder = new TextDecoder();
  let buffer = "";
  let result = { total: 0, success_count: 0, failed_count: 0 };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6));
        if (event.type === "item") onItem(event.index, event.item);
        else if (event.type === "progress") onProgress?.(event.message);
        else if (event.type === "error") onError?.(event.message);
        else if (event.type === "done") result = { total: event.total, success_count: event.success_count, failed_count: event.failed_count };
      } catch { /* skip malformed events */ }
    }
  }
  return result;
}

export async function fetchXhsNoteDetail(payload: { account_id: number; url: string }): Promise<XhsSearchNote> {
  const response = await http.post<XhsSearchNote>("/xhs/pc/notes/detail", payload);
  return response.data;
}

export async function fetchXhsNoteComments(payload: {
  account_id: number;
  note_url: string;
}): Promise<Paginated<NoteComment>> {
  const response = await http.post<{ total: number; items: NoteComment[] }>("/xhs/pc/notes/comments", payload);
  return {
    total: response.data.total,
    page: 1,
    page_size: response.data.items.length,
    items: response.data.items
  };
}

export async function saveXhsNotesToLibrary(payload: {
  account_id: number;
  notes: XhsSearchNote[];
}): Promise<SaveNotesResponse> {
  const response = await http.post<SaveNotesResponse>("/notes/batch-save", payload);
  return response.data;
}

export async function createDraftFromNote(payload: CreateDraftPayload): Promise<Draft> {
  const response = await http.post<Draft>("/drafts", payload);
  return response.data;
}

export async function fetchDrafts(platform = "xhs"): Promise<Paginated<Draft>> {
  const response = await http.get<Paginated<Draft>>("/drafts", { params: { platform } });
  return response.data;
}

export async function updateDraft(draftId: number, payload: { title?: string; body?: string; tags?: { id?: string; name: string }[] }): Promise<Draft> {
  const response = await http.patch<Draft>(`/drafts/${draftId}`, payload);
  return response.data;
}

export async function deleteDraft(draftId: number): Promise<{ id: number; status: string }> {
  const response = await http.delete<{ id: number; status: string }>(`/drafts/${draftId}`);
  return response.data;
}

export type DraftAsset = {
  id: number;
  draft_id: number;
  asset_type: "image" | "video" | string;
  url: string;
  local_path: string;
  sort_order: number;
};

export async function fetchDraftAssets(draftId: number): Promise<{ items: DraftAsset[] }> {
  const response = await http.get<{ items: DraftAsset[] }>(`/drafts/${draftId}/assets`);
  return response.data;
}

export async function addDraftAsset(draftId: number, payload: { asset_type: string; url?: string; local_path?: string }): Promise<DraftAsset> {
  const response = await http.post<DraftAsset>(`/drafts/${draftId}/assets`, payload);
  return response.data;
}

export async function deleteDraftAsset(draftId: number, assetId: number): Promise<void> {
  await http.delete(`/drafts/${draftId}/assets/${assetId}`);
}

export async function updateDraftAsset(draftId: number, assetId: number, payload: { url?: string; local_path?: string }): Promise<DraftAsset> {
  const response = await http.patch<DraftAsset>(`/drafts/${draftId}/assets/${assetId}`, payload);
  return response.data;
}

export async function reorderDraftAssets(draftId: number, assetIds: number[]): Promise<void> {
  await http.put(`/drafts/${draftId}/assets/reorder`, { asset_ids: assetIds });
}

export async function sendDraftToPublish(draftId: number, payload: SendDraftToPublishPayload): Promise<PublishJob> {
  const response = await http.post<PublishJob>(`/drafts/${draftId}/send-to-publish`, payload);
  return response.data;
}

export async function rewriteDraftWithAi(payload: RewriteDraftPayload): Promise<Draft> {
  const response = await http.post<Draft>("/ai/rewrite-note", payload);
  return response.data;
}

export async function generateNoteWithAi(payload: GenerateNotePayload): Promise<Draft> {
  const response = await http.post<Draft>("/ai/generate-note", payload);
  return response.data;
}

export async function generateTitleOptions(payload: GenerateTitlePayload): Promise<{ items: string[] }> {
  const response = await http.post<{ items: string[] }>("/ai/generate-title", payload);
  return response.data;
}

export async function generateTagOptions(payload: GenerateTagsPayload): Promise<{ items: string[] }> {
  const response = await http.post<{ items: string[] }>("/ai/generate-tags", payload);
  return response.data;
}

export async function polishTextWithAi(payload: PolishTextPayload): Promise<{ text: string }> {
  const response = await http.post<{ text: string }>("/ai/polish-text", payload);
  return response.data;
}

export async function fetchGeneratedImageAssets(): Promise<Paginated<GeneratedImageAsset>> {
  const response = await http.get<Paginated<GeneratedImageAsset>>("/ai/images/assets");
  return response.data;
}

export async function deleteGeneratedImageAsset(assetId: number): Promise<void> {
  await http.delete(`/ai/images/assets/${assetId}`);
}

export async function deleteUserImage(fileName: string): Promise<void> {
  await http.delete(`/files/images/${fileName}`);
}

export async function generateCoverWithAi(payload: GenerateCoverPayload): Promise<GeneratedImageAsset> {
  const response = await http.post<GeneratedImageAsset>("/ai/images/generate-cover", payload);
  return response.data;
}

export async function generateImageWithAi(payload: GenerateImagePayload): Promise<GenerateImageResult> {
  const response = await http.post<GenerateImageResult>("/ai/images/generate", payload, { timeout: 180000 });
  return response.data;
}

export async function fetchUserImages(): Promise<{ items: UserImageFile[] }> {
  const response = await http.get<{ items: UserImageFile[] }>("/files/images");
  return response.data;
}

export async function fetchUserVideos(): Promise<{ items: UserVideoFile[] }> {
  const response = await http.get<{ items: UserVideoFile[] }>("/files/videos");
  return response.data;
}

export async function deleteUserVideo(fileName: string): Promise<void> {
  await http.delete(`/files/media/${fileName}`);
}

export async function detectVideo(payload: { file_name: string }): Promise<VideoDetectResult> {
  const response = await http.post<VideoDetectResult>("/xhs/video-studio/detect", payload, { timeout: 60000 });
  return response.data;
}

export async function extractVideoCover(payload: { file_name: string; position_ms?: number }): Promise<VideoCoverResult> {
  const response = await http.post<VideoCoverResult>("/xhs/video-studio/cover", payload, { timeout: 60000 });
  return response.data;
}

export async function transcodeVideo(payload: { file_name: string }): Promise<VideoTranscodeResult> {
  const response = await http.post<VideoTranscodeResult>("/xhs/video-studio/transcode", payload, { timeout: 360000 });
  return response.data;
}

export async function describeImageWithAi(payload: DescribeImagePayload): Promise<{ text: string }> {
  const response = await http.post<{ text: string }>("/ai/images/describe", payload);
  return response.data;
}

export async function composeImageUtility(payload: ComposeImagePayload): Promise<ImageUtilityFile> {
  const response = await http.post<ImageUtilityFile>("/files/images/compose", payload);
  return response.data;
}

export async function resizeImageUtility(payload: ResizeImagePayload): Promise<ImageUtilityFile> {
  const response = await http.post<ImageUtilityFile>("/files/images/resize", payload);
  return response.data;
}

export async function fetchModelConfigs(modelType?: ModelType): Promise<Paginated<ModelConfig>> {
  const response = await http.get<Paginated<ModelConfig>>("/model-configs", {
    params: modelType ? { model_type: modelType } : undefined
  });
  return response.data;
}

export async function createModelConfig(payload: ModelConfigPayload): Promise<ModelConfig> {
  const response = await http.post<ModelConfig>("/model-configs", payload);
  return response.data;
}

export async function setDefaultModelConfig(configId: number): Promise<ModelConfig> {
  const response = await http.post<ModelConfig>(`/model-configs/${configId}/set-default`);
  return response.data;
}

export async function updateModelConfig(configId: number, payload: Partial<ModelConfigPayload>): Promise<ModelConfig> {
  const response = await http.patch<ModelConfig>(`/model-configs/${configId}`, payload);
  return response.data;
}

export async function testModelConfig(configId: number): Promise<{ id: number; status: string; message: string }> {
  const response = await http.post<{ id: number; status: string; message: string }>(`/model-configs/${configId}/test`);
  return response.data;
}

export async function deleteModelConfig(configId: number): Promise<{ id: number; status: string }> {
  const response = await http.delete<{ id: number; status: string }>(`/model-configs/${configId}`);
  return response.data;
}

export async function fetchTasks(platform?: string): Promise<Paginated<TaskRecord>> {
  const response = await http.get<Paginated<TaskRecord>>("/tasks", {
    params: platform ? { platform } : undefined
  });
  return response.data;
}

export async function fetchSchedulerStatus(): Promise<SchedulerStatus> {
  const response = await http.get<SchedulerStatus>("/tasks/scheduler/status");
  return response.data;
}

export async function cancelTask(taskId: number): Promise<TaskRecord> {
  const response = await http.post<TaskRecord>(`/tasks/${taskId}/cancel`);
  return response.data;
}

export async function retryTask(taskId: number): Promise<TaskRecord> {
  const response = await http.post<TaskRecord>(`/tasks/${taskId}/retry`);
  return response.data;
}

export async function runDueTasks(platform = "xhs"): Promise<RunDueTasksResponse> {
  const response = await http.post<RunDueTasksResponse>("/tasks/run-due", null, { params: { platform } });
  return response.data;
}

export async function fetchMonitoringTargets(): Promise<Paginated<MonitoringTarget>> {
  const response = await http.get<Paginated<MonitoringTarget>>("/xhs/monitoring/targets");
  return response.data;
}

export async function createMonitoringTarget(payload: MonitoringTargetPayload): Promise<MonitoringTarget> {
  const response = await http.post<MonitoringTarget>("/xhs/monitoring/targets", payload);
  return response.data;
}

export async function updateMonitoringTarget(
  targetId: number,
  payload: Partial<MonitoringTargetPayload>
): Promise<MonitoringTarget> {
  const response = await http.patch<MonitoringTarget>(`/xhs/monitoring/targets/${targetId}`, payload);
  return response.data;
}

export async function deleteMonitoringTarget(targetId: number): Promise<{ id: number; status: string }> {
  const response = await http.delete<{ id: number; status: string }>(`/xhs/monitoring/targets/${targetId}`);
  return response.data;
}

export async function refreshMonitoringTarget(targetId: number): Promise<MonitoringRefreshResponse> {
  const response = await http.post<MonitoringRefreshResponse>(`/xhs/monitoring/targets/${targetId}/refresh`);
  return response.data;
}

export async function fetchMonitoringSnapshots(targetId: number): Promise<{ target_id: number; items: MonitoringSnapshot[] }> {
  const response = await http.get<{ target_id: number; items: MonitoringSnapshot[] }>(
    `/xhs/monitoring/targets/${targetId}/snapshots`
  );
  return response.data;
}

export async function fetchMonitoringTargetNotes(targetId: number): Promise<{ target_id: number; items: MonitoringNote[] }> {
  const response = await http.get<{ target_id: number; items: MonitoringNote[] }>(
    `/xhs/monitoring/targets/${targetId}/notes`
  );
  return response.data;
}

export async function fetchKeywordGroups(platform = "xhs"): Promise<Paginated<KeywordGroup>> {
  const response = await http.get<Paginated<KeywordGroup>>("/keyword-groups", { params: { platform } });
  return response.data;
}

export async function createKeywordGroup(payload: KeywordGroupPayload): Promise<KeywordGroup> {
  const response = await http.post<KeywordGroup>("/keyword-groups", payload);
  return response.data;
}

export async function fetchKeywordGroup(groupId: number): Promise<KeywordGroupDetail> {
  const response = await http.get<KeywordGroupDetail>(`/keyword-groups/${groupId}`);
  return response.data;
}

export async function updateKeywordGroup(
  groupId: number,
  payload: Partial<KeywordGroupPayload>
): Promise<KeywordGroup> {
  const response = await http.patch<KeywordGroup>(`/keyword-groups/${groupId}`, payload);
  return response.data;
}

export async function deleteKeywordGroup(groupId: number): Promise<{ id: number; status: string }> {
  const response = await http.delete<{ id: number; status: string }>(`/keyword-groups/${groupId}`);
  return response.data;
}

export async function fetchPublishJobs(platform = "xhs"): Promise<Paginated<PublishJob>> {
  const response = await http.get<Paginated<PublishJob>>("/publish/jobs", { params: { platform } });
  return response.data;
}

export async function fetchPublishJob(jobId: number): Promise<PublishJob> {
  const response = await http.get<PublishJob>(`/publish/jobs/${jobId}`);
  return response.data;
}

export async function updatePublishJob(jobId: number, payload: PublishJobUpdatePayload): Promise<PublishJob> {
  const response = await http.patch<PublishJob>(`/publish/jobs/${jobId}`, payload);
  return response.data;
}

export async function publishJobToCreator(jobId: number): Promise<PublishJob> {
  const response = await http.post<PublishJob>(`/publish/jobs/${jobId}/publish`);
  return response.data;
}

export async function retryPublishJob(jobId: number): Promise<PublishJob> {
  const response = await http.post<PublishJob>(`/publish/jobs/${jobId}/retry`);
  return response.data;
}

export async function cancelPublishJob(jobId: number): Promise<PublishJob> {
  const response = await http.post<PublishJob>(`/publish/jobs/${jobId}/cancel`);
  return response.data;
}

export async function deletePublishJob(jobId: number): Promise<void> {
  await http.delete(`/publish/jobs/${jobId}`);
}

export async function fetchPublishAssets(jobId: number): Promise<Paginated<PublishAsset>> {
  const response = await http.get<Paginated<PublishAsset>>(`/publish/jobs/${jobId}/assets`);
  return response.data;
}

export async function addPublishAsset(jobId: number, payload: PublishAssetPayload): Promise<PublishAsset> {
  const response = await http.post<PublishAsset>(`/publish/jobs/${jobId}/assets`, payload);
  return response.data;
}

export async function deletePublishAsset(assetId: number): Promise<{ id: number; status: string }> {
  const response = await http.delete<{ id: number; status: string }>(`/publish/assets/${assetId}`);
  return response.data;
}

export async function uploadPublishAsset(assetId: number): Promise<PublishAsset> {
  const response = await http.post<PublishAsset>(`/publish/assets/${assetId}/upload`);
  return response.data;
}

export async function importXhsCookieAccount(payload: {
  sub_type: "pc" | "creator";
  cookie_string: string;
  sync_creator?: boolean;
}): Promise<PlatformAccount> {
  const response = await http.post<PlatformAccount>("/accounts/import-cookie", {
    platform: "xhs",
    ...payload
  });
  return response.data;
}

export async function checkAccount(accountId: number): Promise<PlatformAccount> {
  const response = await http.post<PlatformAccount>(`/accounts/${accountId}/check`);
  return response.data;
}

export async function deleteAccount(accountId: number): Promise<{ id: number; status: string }> {
  const response = await http.delete<{ id: number; status: string }>(`/accounts/${accountId}`);
  return response.data;
}

export async function createXhsPcQrLoginSession(payload?: {
  sync_creator?: boolean;
}): Promise<XhsQrLoginSession> {
  const response = await http.post<XhsQrLoginSession>("/xhs/login-sessions/pc/qrcode", payload ?? {});
  return response.data;
}

export async function createXhsCreatorQrLoginSession(): Promise<XhsQrLoginSession> {
  const response = await http.post<XhsQrLoginSession>("/xhs/login-sessions/creator/qrcode");
  return response.data;
}

export async function pollXhsLoginSession(sessionId: number): Promise<XhsQrLoginSession> {
  const response = await http.get<XhsQrLoginSession>(`/xhs/login-sessions/${sessionId}`);
  return response.data;
}

export async function sendXhsPhoneCode(payload: {
  sub_type: "pc" | "creator";
  phone: string;
  sync_creator?: boolean;
}): Promise<{ session_id: number; status: string; message: string }> {
  const response = await http.post<{ session_id: number; status: string; message: string }>(
    `/xhs/login-sessions/${payload.sub_type}/phone/send-code`,
    { phone: payload.phone, sync_creator: payload.sync_creator }
  );
  return response.data;
}

export async function confirmXhsPhoneLogin(payload: {
  sub_type: "pc" | "creator";
  session_id: number;
  phone: string;
  code: string;
  sync_creator?: boolean;
}): Promise<XhsQrLoginSession> {
  const response = await http.post<XhsQrLoginSession>(`/xhs/login-sessions/${payload.sub_type}/phone/confirm`, {
    session_id: payload.session_id,
    phone: payload.phone,
    code: payload.code,
    sync_creator: payload.sync_creator
  });
  return response.data;
}

export async function fetchNotifications(params?: { unread?: boolean; page?: number; page_size?: number }): Promise<Paginated<AppNotification>> {
  const response = await http.get<Paginated<AppNotification>>("/notifications", { params });
  return response.data;
}

export async function markNotificationRead(id: number): Promise<AppNotification> {
  const response = await http.post<AppNotification>(`/notifications/${id}/read`);
  return response.data;
}

export async function markAllNotificationsRead(): Promise<{ marked: number }> {
  const response = await http.post<{ marked: number }>("/notifications/read-all");
  return response.data;
}

// Auto Tasks (Auto Operations)

export async function fetchAutoTasks(): Promise<Paginated<AutoTask>> {
  const response = await http.get<Paginated<AutoTask>>("/auto-tasks");
  return response.data;
}

export async function createAutoTask(payload: AutoTaskCreatePayload): Promise<AutoTask> {
  const response = await http.post<AutoTask>("/auto-tasks", payload);
  return response.data;
}

export async function updateAutoTask(taskId: number, payload: AutoTaskUpdatePayload): Promise<AutoTask> {
  const response = await http.patch<AutoTask>(`/auto-tasks/${taskId}`, payload);
  return response.data;
}

export async function deleteAutoTask(taskId: number): Promise<{ id: number; status: string }> {
  const response = await http.delete<{ id: number; status: string }>(`/auto-tasks/${taskId}`);
  return response.data;
}

export async function runAutoTask(taskId: number): Promise<AutoTaskRunResult> {
  const response = await http.post<AutoTaskRunResult>(`/auto-tasks/${taskId}/run`);
  return response.data;
}

// ==================== AI Agent 平台（审校 / 知识库 / 文案包 / 发布批准） ====================

// ---------- 审校（R-01~R-06）----------

export async function submitReview(payload: SubmitReviewPayload): Promise<ReviewJob> {
  const response = await http.post<ReviewJob>("/review", payload);
  return response.data;
}

export async function fetchReviewJobs(params: { status?: string; page?: number; page_size?: number } = {}): Promise<Paginated<ReviewJob>> {
  const response = await http.get<Paginated<ReviewJob>>("/review", { params });
  return response.data;
}

export async function fetchReviewJob(jobId: number): Promise<ReviewJob> {
  const response = await http.get<ReviewJob>(`/review/${jobId}`);
  return response.data;
}

export async function autoFixReview(jobId: number): Promise<ReviewJob> {
  const response = await http.post<ReviewJob>(`/review/${jobId}/auto-fix`);
  return response.data;
}

export async function batchReview(draftIds: number[]): Promise<{ total: number; items: Array<{ draft_id: number; review: ReviewJob }> }> {
  const response = await http.post<{ total: number; items: Array<{ draft_id: number; review: ReviewJob }> }>("/review/batch", { draft_ids: draftIds });
  return response.data;
}

// ---------- 合规规则库 ----------

export async function fetchComplianceRules(): Promise<{ items: ComplianceRule[] }> {
  const response = await http.get<{ items: ComplianceRule[] }>("/compliance-rules");
  return response.data;
}

export async function createComplianceRule(payload: ComplianceRulePayload): Promise<ComplianceRule> {
  const response = await http.post<ComplianceRule>("/compliance-rules", payload);
  return response.data;
}

export async function updateComplianceRule(ruleId: number, payload: Partial<ComplianceRulePayload> & { enabled?: boolean }): Promise<ComplianceRule> {
  const response = await http.put<ComplianceRule>(`/compliance-rules/${ruleId}`, payload);
  return response.data;
}

export async function deleteComplianceRule(ruleId: number): Promise<{ success: boolean }> {
  const response = await http.delete<{ success: boolean }>(`/compliance-rules/${ruleId}`);
  return response.data;
}

// ---------- 知识库（S-02 / C-07 / A-06）----------

export async function fetchKnowledgeBase(platformAccountId?: number | null): Promise<KnowledgeBase> {
  const response = await http.get<KnowledgeBase>("/knowledge-base", { params: platformAccountId ? { platform_account_id: platformAccountId } : {} });
  return response.data;
}

export async function updateKnowledgeBase(payload: {
  platform_account_id?: number | null;
  positioning?: string;
  tone_style?: string;
  credible_claims?: string[];
  content_boundary?: string;
  visual_identity?: Record<string, unknown>;
}): Promise<KnowledgeBase> {
  const response = await http.put<KnowledgeBase>("/knowledge-base", payload);
  return response.data;
}

export async function fetchFewShotNotes(platformAccountId?: number | null): Promise<{ items: FewShotNote[] }> {
  const response = await http.get<{ items: FewShotNote[] }>("/knowledge-base/few-shot", { params: platformAccountId ? { platform_account_id: platformAccountId } : {} });
  return response.data;
}

export async function addFewShotNote(payload: {
  platform_account_id?: number | null;
  note_id?: number | null;
  title?: string;
  body?: string;
  style_analysis?: string;
  sort_order?: number;
}): Promise<FewShotNote> {
  const response = await http.post<FewShotNote>("/knowledge-base/few-shot", payload);
  return response.data;
}

export async function analyzeFewShotStyle(payload: { note_id?: number | null; title?: string; body?: string }): Promise<{ style_analysis: string }> {
  const response = await http.post<{ style_analysis: string }>("/knowledge-base/few-shot/analyze", payload);
  return response.data;
}

export async function deleteFewShotNote(itemId: number): Promise<{ success: boolean }> {
  const response = await http.delete<{ success: boolean }>(`/knowledge-base/few-shot/${itemId}`);
  return response.data;
}

export async function addKnowledgeLesson(payload: { platform_account_id?: number | null; lesson: string }): Promise<{ lessons_learned: string[] }> {
  const response = await http.post<{ lessons_learned: string[] }>("/knowledge-base/lessons", payload);
  return response.data;
}

// ---------- 文案包（C-01）----------

export async function generateNotePack(payload: {
  platform?: string;
  topic: string;
  direction?: string;
  style?: string;
  reference?: string;
  instruction?: string;
  platform_account_id?: number | null;
}): Promise<NotePack> {
  const response = await http.post<NotePack>("/ai/generate-note-pack", payload);
  return response.data;
}

// ---------- 发布批准（D-02）----------

export async function approvePublishJob(jobId: number): Promise<PublishJob> {
  const response = await http.post<PublishJob>(`/publish/jobs/${jobId}/approve`);
  return response.data;
}

// ==================== 策划工作台（热点 / 爆款 / 选题 / 排期 / 归因） ====================

// ---------- P-01 热点榜单 ----------

export async function fetchHotTopics(category?: string): Promise<HotTopicsResponse> {
  const response = await http.get<HotTopicsResponse>("/hot-topics", { params: category ? { category } : {} });
  return response.data;
}

export async function refreshHotTopics(): Promise<{ collected: number; snapshot_time: string | null }> {
  const response = await http.post<{ collected: number; snapshot_time: string | null }>("/hot-topics/refresh");
  return response.data;
}

export async function fetchHotTopicHistory(keyword: string, limit = 12): Promise<{ keyword: string; items: HotTopicHistoryItem[] }> {
  const response = await http.get<{ keyword: string; items: HotTopicHistoryItem[] }>("/hot-topics/history", { params: { keyword, limit } });
  return response.data;
}

// ---------- P-02 爆款拆解 ----------

export async function analyzeExplosions(keyword: string, rangeDays = 7): Promise<ExplosionReport> {
  const response = await http.post<ExplosionReport>("/xhs/analytics/explosions", { keyword, range_days: rangeDays });
  return response.data;
}

export async function fetchExplosionReports(): Promise<{ items: ExplosionReport[] }> {
  const response = await http.get<{ items: ExplosionReport[] }>("/xhs/analytics/explosions");
  return response.data;
}

// ---------- P-03 选题推荐 ----------

export async function generateSuggestions(payload: { count?: number; direction?: string; platform_account_id?: number | null }): Promise<{ total: number; items: TopicSuggestion[] }> {
  const response = await http.post<{ total: number; items: TopicSuggestion[] }>("/xhs/analytics/suggestions", payload);
  return response.data;
}

export async function fetchSuggestions(status?: string): Promise<{ items: TopicSuggestion[] }> {
  const response = await http.get<{ items: TopicSuggestion[] }>("/xhs/analytics/suggestions", { params: status ? { status } : {} });
  return response.data;
}

export async function acceptSuggestion(suggestionId: number): Promise<{ suggestion: TopicSuggestion; draft_id: number }> {
  const response = await http.post<{ suggestion: TopicSuggestion; draft_id: number }>(`/xhs/analytics/suggestions/${suggestionId}/accept`);
  return response.data;
}

// ---------- D-01 智能排期 ----------

export async function recommendPublishSchedules(platformAccountId: number, days = 3): Promise<{ total: number; items: ScheduleSuggestion[]; buffer_remaining: number; reason: string }> {
  const response = await http.post<{ total: number; items: ScheduleSuggestion[]; buffer_remaining: number; reason: string }>("/publish/schedules/recommend", {
    platform_account_id: platformAccountId,
    days,
  });
  return response.data;
}

export async function fetchPublishSchedules(platformAccountId?: number): Promise<{ items: ScheduleSuggestion[] }> {
  const response = await http.get<{ items: ScheduleSuggestion[] }>("/publish/schedules", { params: platformAccountId ? { platform_account_id: platformAccountId } : {} });
  return response.data;
}

// ---------- A-02 归因分析 / A-04 周报 ----------

export async function generateAttribution(): Promise<{ conclusions: AttributionConclusion[]; samples: Record<string, unknown> }> {
  const response = await http.post<{ conclusions: AttributionConclusion[]; samples: Record<string, unknown> }>("/xhs/analytics/attribution");
  return response.data;
}

export async function generateWeeklyReport(): Promise<{ markdown: string; summary: Record<string, unknown> }> {
  const response = await http.post<{ markdown: string; summary: Record<string, unknown> }>("/xhs/analytics/weekly-report");
  return response.data;
}

// ==================== Phase 3（评论响应 / 工作流 / 技能 / 用量 / 健康） ====================

// ---------- D-05 评论自动响应 ----------

export async function fetchCommentReplies(status?: string): Promise<{ items: CommentReply[] }> {
  const response = await http.get<{ items: CommentReply[] }>("/xhs/comments/replies", { params: status ? { status } : {} });
  return response.data;
}

export async function approveCommentReply(replyId: number): Promise<CommentReply> {
  const response = await http.post<CommentReply>(`/xhs/comments/replies/${replyId}/approve`);
  return response.data;
}

export async function skipCommentReply(replyId: number): Promise<CommentReply> {
  const response = await http.post<CommentReply>(`/xhs/comments/replies/${replyId}/skip`);
  return response.data;
}

export async function fetchReplyRules(): Promise<{ items: CommentReplyRule[] }> {
  const response = await http.get<{ items: CommentReplyRule[] }>("/xhs/comments/reply-rules");
  return response.data;
}

export async function createReplyRule(payload: { intent: string; keywords?: string[]; reply_template?: string }): Promise<CommentReplyRule> {
  const response = await http.post<CommentReplyRule>("/xhs/comments/reply-rules", payload);
  return response.data;
}

export async function updateReplyRule(ruleId: number, payload: Partial<{ intent: string; keywords: string[]; reply_template: string; enabled: boolean }>): Promise<CommentReplyRule> {
  const response = await http.put<CommentReplyRule>(`/xhs/comments/reply-rules/${ruleId}`, payload);
  return response.data;
}

export async function deleteReplyRule(ruleId: number): Promise<{ success: boolean }> {
  const response = await http.delete<{ success: boolean }>(`/xhs/comments/reply-rules/${ruleId}`);
  return response.data;
}

// ---------- S-04 工作流 / S-03 技能库 ----------

export async function fetchWorkflows(): Promise<{ items: WorkflowDef[] }> {
  const response = await http.get<{ items: WorkflowDef[] }>("/workflows");
  return response.data;
}

export async function runWorkflow(workflowKey: string, params: Record<string, unknown> = {}): Promise<WorkflowRunResult> {
  const response = await http.post<WorkflowRunResult>("/workflows/run", { workflow_key: workflowKey, params });
  return response.data;
}

export async function fetchWorkflowRuns(): Promise<{ items: WorkflowRunRecord[] }> {
  const response = await http.get<{ items: WorkflowRunRecord[] }>("/workflows/runs");
  return response.data;
}

export async function fetchSkills(): Promise<{ items: SkillItem[] }> {
  const response = await http.get<{ items: SkillItem[] }>("/skills");
  return response.data;
}

// ---------- S-06 用量监控 ----------

export async function fetchUsageSummary(days = 7): Promise<UsageSummary> {
  const response = await http.get<UsageSummary>("/usage/summary", { params: { days } });
  return response.data;
}

// ---------- A-03 账号健康诊断 ----------

export async function fetchAccountHealth(): Promise<{ items: AccountHealth[] }> {
  const response = await http.get<{ items: AccountHealth[] }>("/xhs/analytics/health");
  return response.data;
}

// ---------- C-05 视频脚本 ----------

export async function generateVideoScript(draftId: number): Promise<{ draft_id: number; script: string }> {
  const response = await http.post<{ draft_id: number; script: string }>("/ai/generate-script", { draft_id: draftId });
  return response.data;
}
