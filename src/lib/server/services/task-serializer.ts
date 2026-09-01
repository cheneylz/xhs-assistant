/**
 * 任务序列化（从 api/tasks/shared.ts 抽出，供 tasks/crawl/调度路由共用）
 */
import { formatDateTime } from "../core/time";

export interface TaskLike {
  id: number;
  platform: string;
  taskType: string;
  status: string;
  progress: number;
  payload: unknown;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorType: string | null;
  retryCount: number;
  maxRetries: number;
  parentTaskId: number | null;
}

/** 序列化任务为响应对象（snake_case，对应原版 serialize_task） */
export function serializeTask(task: TaskLike): Record<string, unknown> {
  let durationMs: number | null = null;
  if (task.startedAt && task.finishedAt) {
    durationMs = Math.floor(task.finishedAt.getTime() - task.startedAt.getTime());
  }
  return {
    id: task.id,
    platform: task.platform,
    task_type: task.taskType,
    status: task.status,
    progress: task.progress,
    payload: (task.payload as Record<string, unknown> | null) ?? {},
    created_at: formatDateTime(task.createdAt),
    started_at: task.startedAt ? formatDateTime(task.startedAt) : null,
    finished_at: task.finishedAt ? formatDateTime(task.finishedAt) : null,
    duration_ms: durationMs,
    error_type: task.errorType,
    retry_count: task.retryCount,
    max_retries: task.maxRetries,
    parent_task_id: task.parentTaskId,
  };
}
