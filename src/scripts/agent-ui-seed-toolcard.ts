/**
 * 验收夹具：给最新一个已结束的 Run 补一条指定状态的工具卡（§7.2 第 3 条的 4 种状态渲染）。
 *
 * 用法：
 *   npx tsx src/scripts/agent-ui-seed-toolcard.ts add          # 插一条「被阻断」卡（默认）
 *   npx tsx src/scripts/agent-ui-seed-toolcard.ts add failed   # 插一条「失败」卡
 *   npx tsx src/scripts/agent-ui-seed-toolcard.ts remove       # 删除全部夹具行
 *
 * 注意：这是人工构造的验收数据（blocked 在 P1 生产不可达；failed 想确定性复现也不方便）。
 */
import { prisma } from "../lib/server/core/db";
import { shanghaiNow } from "../lib/server/core/time";

/** 夹具行的 toolCallId 前缀（删除时按前缀清理全部夹具） */
const FIXTURE_PREFIX = "manual_fixture";

const FIXTURES = {
  blocked: {
    toolName: "publish_note",
    status: "blocked",
    errorType: "guard_blocked",
    summary: "「发布笔记」需要人工确认，已阻断（人工构造的验收数据）",
  },
  failed: {
    toolName: "content_note_pack",
    status: "failed",
    errorType: "tool_error",
    summary: "生成失败：文本模型未配置（人工构造的验收数据）",
  },
} as const;

type FixtureStatus = keyof typeof FIXTURES;

async function addFixture(status: FixtureStatus): Promise<void> {
  const fixture = FIXTURES[status];
  const toolCallId = `${FIXTURE_PREFIX}_${status}`;
  const run = await prisma.agentRun.findFirst({
    where: { status: { in: ["succeeded", "failed", "cancelled"] } },
    orderBy: { id: "desc" },
  });
  if (!run) throw new Error("库里没有已结束的 Run，先在 /agent 里跑一轮任务");

  const existing = await prisma.agentToolCall.findFirst({ where: { runId: run.id, toolCallId } });
  if (existing) {
    console.log(`夹具行已存在（id=${existing.id}），直接刷新页面即可`);
    return;
  }

  const created = await prisma.agentToolCall.create({
    data: {
      runId: run.id,
      // 序号排在该 Run 现有卡片的最后，保证出现在时间线末尾
      stepIndex: await prisma.agentToolCall.count({ where: { runId: run.id } }),
      toolName: fixture.toolName,
      toolCallId,
      params: {},
      status: fixture.status,
      errorType: fixture.errorType,
      summary: fixture.summary,
      createdAt: shanghaiNow(),
    },
  });
  console.log(`已为 Run #${run.id}（会话 #${run.conversationId}）插入「${status}」卡片 id=${created.id}`);
  console.log("打开 http://localhost:3000/agent 选中该会话并刷新，即可看到对应状态的卡片");
}

async function removeFixtures(): Promise<void> {
  const result = await prisma.agentToolCall.deleteMany({ where: { toolCallId: { startsWith: FIXTURE_PREFIX } } });
  console.log(`已删除 ${result.count} 条夹具行`);
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === "add") {
    const status = (process.argv[3] ?? "blocked") as FixtureStatus;
    if (!(status in FIXTURES)) {
      throw new Error(`未知状态：${status}（可用：${Object.keys(FIXTURES).join(" / ")}）`);
    }
    return addFixture(status);
  }
  if (action === "remove") return removeFixtures();
  throw new Error("用法：npx tsx src/scripts/agent-ui-seed-toolcard.ts add [blocked|failed] | remove");
}

main()
  .catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
