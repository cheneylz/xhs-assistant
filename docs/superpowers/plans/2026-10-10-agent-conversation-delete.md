# Agent 工作台会话删除 实现计划（P1-D）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Agent 工作台左栏给会话加删除入口（悬停出图标 + Popconfirm 确认），接已有的 `DELETE /api/agent/conversations/[id]`。

**Architecture:** 纯前端改动（服务端零改动）。三层各司其职：`api.ts` 只做 HTTP 封装；`ConversationList` 保持无状态（新增 `onDelete` / `deletingId` 两个 prop，只负责渲染与触发）；`page.tsx` 持有状态与竞态守卫（沿用既有 `selectionRef` 约定）。悬停显隐用 `globals.css` 的类（与 B 块的 `.agent-markdown` 同一归处），用 `visibility` 而非 `opacity` —— 后者不可见但仍可点击。

**Tech Stack:** Next.js 15.5 客户端组件 / React 19 / antd 6（`Popconfirm`）/ TypeScript 5.9

**设计依据:** `docs/superpowers/specs/2026-10-10-agent-conversation-delete-design.md`（交互取舍已与用户确认）

**前置:** 基线 30 文件 / 359 用例全绿、`tsc` 无输出。dev server（:3000）与 worker 都在跑着。

### 执行进度

| 任务 | 状态 | 提交 |
|---|---|---|
| Task 1 客户端封装 + 左栏入口 + 页面接线 | ⬜ 未开始 | |
| Task 2 回归 + 交接登记 + 浏览器验收清单 | ⬜ 未开始 | |

---

## 一、硬约束

| # | 约束 |
|---|---|
| 1 | 注释一律**中文**；**分号 + 双引号 + 2 空格缩进** |
| 2 | 中文提交信息必须写进 UTF-8 文件再 `git commit -F <文件>`；不要 push |
| 3 | 删除是破坏性操作：必须有二次确认（`Popconfirm`，项目惯例，11+ 处页面同款）+ 危险色按钮 |
| 4 | 不引前端测试栈（D25）：本功能不新增单测；验收 = 自动化回归 + 用户浏览器 3 步 |
| 5 | 竞态：每个 `await` 之后按页面既有约定比对 `selectionRef.current`；失败路径不吞错误（拦截器已 toast） |
| 6 | 服务端零改动（接口 8 已交付且被 `agent-api-smoke.ts` 第 8/9 项覆盖） |

---

## 二、文件结构

| 文件 | 改动 |
|---|---|
| `src/lib/api.ts` | 末尾追加 `deleteAgentConversation`（照 `cancelAgentRun` / `deleteDraft` 的写法） |
| `src/app/globals.css` | `.agent-markdown` 块之后追加两条类规则（`.agent-conv-row` / `.agent-conv-delete`） |
| `src/components/agent/conversation-list.tsx` | 行内 hover 图标 + `Popconfirm`；新增 `onDelete` / `deletingId` props |
| `src/app/(protected)/agent/page.tsx` | `deletingId` state + `handleDelete` + 向 `ConversationList` 传两个新 prop |

---

## Task 1: 客户端封装 + 左栏入口 + 页面接线

**Files:**
- Modify: `src/lib/api.ts`（末尾追加）
- Modify: `src/app/globals.css`
- Modify: `src/components/agent/conversation-list.tsx`（整文件替换）
- Modify: `src/app/(protected)/agent/page.tsx`

- [ ] **Step 1: 加客户端封装**

`src/lib/api.ts` 末尾（`fetchAgentArtifacts` 之后）追加：

```ts
/**
 * DELETE /api/agent/conversations/[id] 删除会话（接口 8）。
 * 执行中 → 409（服务端文案「会话正在执行中，请先取消或等待任务结束再删除」，由拦截器提示）；
 * 他人 / 不存在 → 404。服务端级联深删消息 / Run / 事件 / 工具调用 / 工件。
 */
export async function deleteAgentConversation(conversationId: number): Promise<{ deleted: boolean; id: number }> {
  const response = await http.delete<{ deleted: boolean; id: number }>(`/agent/conversations/${conversationId}`);
  return response.data;
}
```

- [ ] **Step 2: 加悬停显隐的样式**

`src/app/globals.css` 的 `.agent-markdown` 样式块**之后**追加：

```css
/* 会话行的删除入口：默认隐藏，悬停该行或键盘聚焦到按钮时出现。
   用 opacity + pointer-events 而非 visibility —— 后者会让按钮**不可聚焦**，
   `:focus-within` 永远匹配不上（键盘用户完全走不到）；pointer-events 则补上
   「不可见却能点」的漏洞 */
.agent-conv-delete {
  opacity: 0;
  pointer-events: none;
}
.agent-conv-row:hover .agent-conv-delete,
.agent-conv-row:focus-within .agent-conv-delete {
  opacity: 1;
  pointer-events: auto;
}
```

- [ ] **Step 3: 改造会话列表组件**

`src/components/agent/conversation-list.tsx` **整文件替换**为：

```tsx
"use client";
/**
 * 左栏：会话列表 + 新建 + 行内删除（P1 设计稿 §5.2 / P1-D 会话删除）
 *
 * updated_at 是「朴素上海墙钟」字符串，直接切片展示 —— 用 new Date() 解析会在
 * 非上海时区的浏览器上显示错。
 *
 * 删除入口只在悬停该行时出现（样式在 globals.css 的 .agent-conv-delete），
 * 点击必须 stopPropagation，否则会连带触发行的「选中」（P1-D 设计稿 §三.1）。
 */
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { Badge, Button, Empty, Popconfirm, Spin, Typography } from "antd";

import type { AgentConversation } from "@/types";

const { Text } = Typography;

interface ConversationListProps {
  items: AgentConversation[];
  selectedId: number | null;
  loading: boolean;
  creating: boolean;
  /** 正在删除的会话 id（该行按钮置灰，防止重复开确认框） */
  deletingId: number | null;
  onSelect: (id: number) => void;
  onCreate: () => void;
  /** 确认删除：返回 Promise —— Popconfirm 会自动给确认按钮加 loading 并在 resolve 后关闭 */
  onDelete: (id: number) => Promise<void>;
}

/** "2026-10-10T14:23:05" → "10-10 14:23" */
function formatListTime(value: string): string {
  return value.length >= 16 ? `${value.slice(5, 10)} ${value.slice(11, 16)}` : value;
}

export function ConversationList(props: ConversationListProps) {
  const { items, selectedId, loading, creating, deletingId, onSelect, onCreate, onDelete } = props;

  return (
    <div
      style={{
        width: 260,
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
          会话
        </Text>
        <Button size="small" type="primary" icon={<PlusOutlined />} loading={creating} onClick={onCreate}>
          新建
        </Button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
        {loading && items.length === 0 && (
          <div style={{ paddingTop: 32, textAlign: "center" }}>
            <Spin size="small" />
          </div>
        )}
        {!loading && items.length === 0 && (
          <div style={{ paddingTop: 32 }}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有会话" />
          </div>
        )}
        {items.map((item) => {
          const selected = item.id === selectedId;
          return (
            <div
              key={item.id}
              className="agent-conv-row"
              onClick={() => onSelect(item.id)}
              style={{
                padding: "8px 10px",
                marginBottom: 4,
                borderRadius: 8,
                cursor: "pointer",
                background: selected ? "#ecf0ff" : "transparent",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {item.status === "running" && <Badge status="processing" />}
                <Text
                  ellipsis
                  title={item.title}
                  style={{ flex: 1, fontSize: 13, fontWeight: selected ? 600 : 400, minWidth: 0 }}
                >
                  {item.title}
                </Text>
                {/* 点击删除图标不能连带选中会话 —— 包裹层 stopPropagation */}
                <span className="agent-conv-delete" onClick={(event) => event.stopPropagation()}>
                  <Popconfirm
                    title={`确定删除会话「${item.title}」？`}
                    description="消息与工件会一并清除，不可恢复"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => onDelete(item.id)}
                  >
                    <Button
                      type="text"
                      size="small"
                      danger
                      aria-label="删除会话"
                      disabled={deletingId === item.id}
                      icon={<DeleteOutlined />}
                    />
                  </Popconfirm>
                </span>
              </div>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {formatListTime(item.updated_at)}
              </Text>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 页面接线**

`src/app/(protected)/agent/page.tsx` 四处改动：

**(a)** import 里加 `deleteAgentConversation`（放在既有 `createAgentConversation` 与 `fetchAgentArtifacts` 之间的字母序位置即可）：

```ts
import {
  cancelAgentRun,
  createAgentConversation,
  deleteAgentConversation,
  fetchAgentArtifacts,
  fetchAgentConversation,
  fetchAgentConversations,
  sendAgentMessage,
} from "@/lib/api";
```

**(b)** 在 `const [creating, setCreating] = useState(false);` 之后加：

```ts
  /** 正在删除的会话 id（传给左栏，禁用该行按钮防重复提交） */
  const [deletingId, setDeletingId] = useState<number | null>(null);
```

**(c)** 在 `handleCreate` 之后新增：

```ts
  /**
   * 删除会话（P1-D）：成功即把该行从列表移除；若删的是**当前选中**会话，
   * 把工作台清回空态（syncedId=null 会随 effect 依赖断开 SSE）。
   * 失败（409 执行中 / 404 已被删）由拦截器 toast —— 之后 refreshList 对齐
   * 「执行中」标记与行集合（左栏标记来自列表接口快照，可能滞后）。
   */
  const handleDelete = useCallback(
    async (id: number) => {
      setDeletingId(id);
      try {
        await deleteAgentConversation(id);
        setConversations((items) => items.filter((item) => item.id !== id));
        // 删的正是当前选中的会话：清空工作台（用户删除时可能在途切走，故用 ref 比对）
        if (selectionRef.current === id) {
          selectionRef.current = null;
          setSelectedId(null);
          setSyncedId(null);
          dispatch({ type: "clear" });
          setDraft("");
        }
        message.success("会话已删除");
      } catch {
        // 拦截器已提示；刷新列表让「执行中」标记等状态与库对齐
        void refreshList();
      } finally {
        setDeletingId(null);
      }
    },
    [refreshList],
  );
```

**(d)** `ConversationList` 的 JSX 加两个 prop：

```tsx
      <ConversationList
        items={conversations}
        selectedId={selectedId}
        loading={listLoading}
        creating={creating}
        deletingId={deletingId}
        onSelect={handleSelect}
        onCreate={() => void handleCreate()}
        onDelete={handleDelete}
      />
```

- [ ] **Step 5: 跑单测与类型检查**

Run:
```bash
npx vitest run        # 期望 30 文件 / 359 用例全绿（本改动不新增用例）
npx tsc --noEmit      # 期望无输出
```
Expected: 全绿、无输出。

- [ ] **Step 6: 提交**

```bash
git add src/lib/api.ts src/app/globals.css src/components/agent/conversation-list.tsx "src/app/(protected)/agent/page.tsx"
git commit -F <UTF-8 文件>   # 信息：feat(agent-ui): 会话删除（左栏悬停入口 + Popconfirm + 删当前会话清空工作台）
```

---

## Task 2: 回归 + 交接登记 + 浏览器验收清单

**Files:**
- Modify: `docs/superpowers/HANDOFF-agent-p1-remaining.md`（登记 P1-D）

- [ ] **Step 1: 生产构建（先停 dev server）**

顺序不能反（build 会覆盖 dev 的 `.next`）：
```bash
# 1) 停 dev server（按端口找 PID 杀，或让用户 Ctrl+C）
# 2) npx next build          # 期望 Compiled successfully，路由表含 /agent
# 3) rm -rf .next
# 4) npm run dev              # 后台重启，恢复到「用户可用」状态
# 5) curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/agent   # 期望 200
```
Expected: build 成功、dev 恢复、`/agent` 200。

- [ ] **Step 2: 接口层回归脚本（确认无回归）**

worker 已在跑：
```bash
npx tsx src/scripts/agent-api-smoke.ts    # 期望 9/9（第 8 项覆盖删除接口的 409/404/200 与级联深删）
```
Expected: 「P1-A 接口层验收全部通过」。

- [ ] **Step 3: 交接文档登记**

`docs/superpowers/HANDOFF-agent-p1-remaining.md` 里加一小节（放在「§二 C 块」之后）：

```markdown
## §二·补 P1-D：会话删除（前端）

- **日期**：2026-10-10；状态：已实现（设计见 `docs/superpowers/specs/2026-10-10-agent-conversation-delete-design.md`）
- **改动**：服务端零改动（接口 8 已存在）；前端 3 处 —— `api.ts` 的 `deleteAgentConversation`、`conversation-list.tsx` 的行内悬停删除 + Popconfirm、`page.tsx` 的 `handleDelete`（删当前选中会话时清空工作台）
- **已知取舍**：运行中的会话不做前端禁用，以服务端 409 + 拦截器 toast 为准（左栏「执行中」标记来自快照、可能滞后）；删除入口默认隐藏，悬停会话行**或键盘 Tab 到该按钮**时出现（`.agent-conv-delete` 用 opacity + pointer-events 而非 visibility —— 后者不可聚焦）；触屏用户仍走不到（与全站列表项不可键盘访问的历史局限同源）
- **验收**：`vitest` / `tsc` / `next build` / `agent-api-smoke.ts` 全过；浏览器交互由用户点验
```

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/HANDOFF-agent-p1-remaining.md
git commit -F <UTF-8 文件>   # 信息：docs(agent): P1-D 会话删除的交接登记
```

- [ ] **Step 5: 交给用户浏览器验收（3 步 + 1 反向）**

在 dev server（:3000）的 `/agent` 上：
1. 悬停任一会话行 → 右侧出现红色删除图标
2. 点击 → 弹出确认框（标题含会话名、有「消息与工件会一并清除，不可恢复」）
3. 确认 → 该行消失并弹出「会话已删除」；**若删的是当前正在看的会话** → 中栏与右栏清空、输入框回到「选择或新建一个会话开始」
4. 反向：对一个**执行中**的会话删 → 弹出「会话正在执行中，请先取消或等待任务结束再删除」，该行不消失

---

## 附：自查结论（写计划时已核）

| 检查 | 结论 |
|---|---|
| 设计稿 §三 六条交互 | 1→Step 3 的 `.agent-conv-delete` + stopPropagation；2→Popconfirm 文案；3→Step 4(c) 的移行 + 清空；4→不做禁用（仅 catch 里 refreshList）；5→`deletingId` + `disabled`；6→`selectionRef` 比对 |
| 设计稿 §四 文件清单 | 与本文「二、文件结构」一致（服务端零改动） |
| 设计稿 §五「不做」 | 计划里没有任何批量/撤销/强删/键盘改造的内容 |
| 设计稿 §六 验收 | Task 2 Step 1/2/5 与之逐条对应 |
| 占位符扫描 | 无 TBD/TODO；每个代码步骤都是完整代码 |
| 类型一致性 | `deleteAgentConversation(id): Promise<{deleted,id}>`、`onDelete: (id) => Promise<void>`、`deletingId: number | null` 三处签名在 Task 1 内自洽；`http.delete<T>` 是既有写法（`api.ts:342/502`） |
