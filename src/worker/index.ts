/**
 * 调度 Worker 进程（对应原版 APScheduler 后台任务，node-cron 实现）
 *
 * 4 个任务（与重构文档 §5.5 一致）：
 *  ① due_publish_runner       定时发布扫描  60s（可配 SCHEDULER_INTERVAL_SECONDS）
 *  ② monitoring_refresh_runner 监控刷新     60s
 *  ③ auto_tasks_runner        自动运营管线  60s
 *  ④ cookie_health_checker    Cookie 健康巡检 2h（可配 COOKIE_HEALTH_CHECK_HOURS）
 *
 * 互斥锁（对应 APScheduler max_instances=1 + coalesce）：
 *  同一任务上一次执行未结束时跳过本次触发
 */
import cron, { type ScheduledTask } from "node-cron";
import { getConfig } from "../lib/server/core/config";
import {
  checkAllAccountCookiesOnce,
  getTextModelForUser,
  runDueAutoTasks,
  runDuePublishJobsForAllUsers,
  runMonitoringRefreshForAllUsers,
  type GateReviewer,
} from "../lib/server/services/scheduler-service";
import { OpenAICompatibleTextClient } from "../lib/server/services/ai-service";
import { runHotTopicsForAllUsers } from "../lib/server/services/hot-topic-service";
import { detectNewCommentsForUser } from "../lib/server/services/comment-reply-service";
import { XhsCreatorApiAdapter } from "../lib/server/xhs/adapters/creator-api-adapter";
import { XhsPcApiAdapter } from "../lib/server/xhs/adapters/pc-api-adapter";
import { XhsCreatorLoginAdapter } from "../lib/server/xhs/adapters/creator-login-adapter";
import { XhsPcLoginAdapter } from "../lib/server/xhs/adapters/pc-login-adapter";

/** 互斥锁：防止任务重叠执行 */
class Mutex {
  private running = false;

  async run(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.running) {
      console.log(`[worker] ${name} 上次执行未完成，跳过本次触发`);
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    try {
      await fn();
      console.log(`[worker] ${name} 完成，耗时 ${Date.now() - startedAt}ms`);
    } catch (error) {
      console.error(`[worker] ${name} 失败: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

const publishMutex = new Mutex();
const monitoringMutex = new Mutex();
const autoTasksMutex = new Mutex();
const cookieHealthMutex = new Mutex();
const hotTopicsMutex = new Mutex();
const commentReplyMutex = new Mutex();

/** 门禁审查器：按用户提供文本模型上下文（未配置模型时返回 null，仅规则层） */
const gateReviewer: GateReviewer = async (userId) => {
  const [modelConfig, apiKey] = await getTextModelForUser(userId);
  if (!modelConfig || !apiKey) return null;
  return {
    textClient: new OpenAICompatibleTextClient(),
    modelConfig: modelConfig as unknown as Parameters<OpenAICompatibleTextClient["complete"]>[0]["modelConfig"],
    apiKey,
  };
};

/** ① 定时发布扫描 */
async function duePublishRunner(): Promise<void> {
  await runDuePublishJobsForAllUsers({
    platform: "xhs",
    adapterFactory: (cookies) => new XhsCreatorApiAdapter(cookies),
    gateReviewer,
  });
}

/** ② 监控刷新 */
async function monitoringRefreshRunner(): Promise<void> {
  await runMonitoringRefreshForAllUsers({ platform: "xhs" });
}

/** ③ 自动运营管线 */
async function autoTasksRunner(): Promise<void> {
  await runDueAutoTasks({
    pcAdapterFactory: (cookies) => new XhsPcApiAdapter(cookies),
    creatorAdapterFactory: (cookies) => new XhsCreatorApiAdapter(cookies),
    textClient: new OpenAICompatibleTextClient(),
  });
}

/** ⑤ 热点采集（P-01，30 分钟一次） */
async function hotTopicsRunner(): Promise<void> {
  await runHotTopicsForAllUsers({
    adapterFactory: (cookies) => new XhsPcApiAdapter(cookies),
  });
}

/** ⑥ 评论自动响应检测（D-05，60s）：新评论 → 意图分类 → 生成待审核回复 */
async function commentReplyRunner(): Promise<void> {
  const accounts = await (
    await import("../lib/server/core/db")
  ).prisma.platformAccount.findMany({
    where: { platform: "xhs", subType: "pc" },
    select: { userId: true },
    distinct: ["userId"],
    orderBy: { userId: "asc" },
  });
  for (const account of accounts) {
    try {
      const modelContext = await gateReviewer(account.userId);
      await detectNewCommentsForUser({
        userId: account.userId,
        adapterFactory: (cookies) => new XhsPcApiAdapter(cookies),
        textClient: new OpenAICompatibleTextClient(),
        modelConfig: modelContext?.modelConfig ?? null,
        apiKey: modelContext?.apiKey ?? null,
      });
    } catch (error) {
      console.warn(`[worker] 评论响应检测失败（用户 ${account.userId}）: ${(error as Error).message}`);
    }
  }
}

/** ④ Cookie 健康巡检 */
async function cookieHealthChecker(): Promise<void> {
  await checkAllAccountCookiesOnce({
    userInfoFetcherFor: (account) => {
      const adapter = account.subType === "creator" ? new XhsCreatorLoginAdapter() : new XhsPcLoginAdapter();
      return async (cookies) => {
        await adapter.getUserInfo(cookies as Record<string, string>);
      };
    },
  });
}

const scheduled: ScheduledTask[] = [];

function schedule(expression: string, name: string, mutex: Mutex, fn: () => Promise<void>): void {
  const task = cron.schedule(
    expression,
    () => {
      void mutex.run(name, fn);
    },
    { timezone: "Asia/Shanghai" },
  );
  scheduled.push(task);
  console.log(`[worker] 已注册任务 ${name}：cron=${expression}`);
}

function main(): void {
  const config = getConfig();
  const intervalSeconds = Math.max(1, Math.min(config.schedulerIntervalSeconds, 59));
  const healthHours = Math.max(1, config.cookieHealthCheckHours);

  schedule(`*/${intervalSeconds} * * * * *`, "due_publish_runner", publishMutex, duePublishRunner);
  schedule(`*/${intervalSeconds} * * * * *`, "monitoring_refresh_runner", monitoringMutex, monitoringRefreshRunner);
  schedule("* * * * *", "auto_tasks_runner", autoTasksMutex, autoTasksRunner);
  schedule(`7 */${healthHours} * * *`, "cookie_health_checker", cookieHealthMutex, cookieHealthChecker);
  schedule("*/30 * * * *", "hot_topics_runner", hotTopicsMutex, hotTopicsRunner); // P-01 热点榜单 30 分钟
  schedule("* * * * *", "comment_reply_runner", commentReplyMutex, commentReplyRunner); // D-05 评论响应 60s

  console.log(`[worker] 启动完成：interval=${config.schedulerIntervalSeconds}s, cookieHealth=${healthHours}h`);
  console.log("[worker] 按 Ctrl+C 退出");
}

main();

// 优雅退出
process.on("SIGINT", () => {
  console.log("[worker] 收到退出信号，停止调度");
  for (const task of scheduled) task.stop();
  process.exit(0);
});
