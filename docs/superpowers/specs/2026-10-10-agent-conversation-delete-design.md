# Agent 工作台：会话删除功能设计

- 日期：2026-10-10
- 前置：P1（A/B/C 三块）已完成并合入 `main`（`3aef451`）
- 本稿性质：**单功能设计（小）**。交互取舍已与用户当面确认（2026-10-10）；实施计划另见 `docs/superpowers/plans/` 下的对应计划

---

## 一、目标与范围

让用户能在 Agent 工作台里删除会话。

**现状**：服务端 `DELETE /api/agent/conversations/[id]` **已交付**（P1-A 接口 8），语义与级联深删都已被 `agent-api-smoke.ts` 第 8/9 项端到端覆盖。缺的**只有前端**：`src/lib/api.ts` 没有对应的客户端封装，左栏会话行也没有任何删除入口。

**范围**：只改前端 3 个文件（服务端零改动）。

---

## 二、现状证据（实施前已核实）

| 事实 | 位置 |
|---|---|
| 接口语义：200 → `{ deleted: true, id }`；404「会话不存在」；409「会话正在执行中，请先取消或等待任务结束再删除」。归属校验在服务层最前面（他人会话一律 404，不因「正在跑」泄露 409） | `src/app/api/agent/conversations/[id]/route.ts:88-97` |
| 深删级联：消息 / Run / 事件 / 工具调用 / 工件一并清除；执行中返回 `active_run` | `deleteConversationDeep`（`agent-service.ts`） |
| 客户端已有 6 个 agent 封装（列表/新建/首屏/发消息/取消/工件），**没有 delete** | `src/lib/api.ts:1248-1297` |
| 左栏会话行是 `div onClick`，无任何行内操作；`status === "running"` 只用于渲染执行中徽标 | `src/components/agent/conversation-list.tsx:73-102` |
| 项目删除类交互惯例：`Popconfirm` + danger 色 `DeleteOutlined`（11+ 处页面同款） | 如 `platforms/xhs/library/page.tsx:388` |

---

## 三、交互设计（已确认）

1. **入口**：鼠标悬停会话行时，右侧浮现 danger 色 `DeleteOutlined` 图标；图标的 `onClick` **阻止冒泡**（不触发行的选中）
2. **二次确认**：`Popconfirm` —— 标题「确定删除会话「{标题}」？」，描述「消息与工件会一并清除，不可恢复」，按钮「删除 / 取消」
3. **确认后**：调 `DELETE`；成功 → 该行从列表移除 + `message.success("会话已删除")`
   - **若删的是当前选中的会话** → 工作台清空回空态：`selectedId = null`、`syncedId = null`（既有 effect 依赖随之断开 SSE）、`dispatch({type:"clear"})`、草稿清空
   - **若删的是非选中会话** → 只移除该行，当前工作台不受影响
4. **运行中的会话**：**不做前端禁用**。理由：左栏「执行中」标记来自列表接口快照、可能滞后（B 块已知局限），前端禁用会出现「明明空闲却灰着」的假象；以服务端为权威 —— 点击后 409 由 axios 拦截器 toast 服务端文案，随后 `refreshList()` 对齐标记
5. **在途防重**：页面持有 `deletingId`（正在删除的会话 id），该行的确认按钮呈 loading、图标不可重复点击
6. **竞态守卫**：沿用页面既有约定 —— 每个 `await` 之后比对 `selectionRef.current !== id`，避免把过期响应的结果写进别的会话

---

## 四、代码改动

| 文件 | 改动 |
|---|---|
| `src/lib/api.ts` | 新增 `deleteAgentConversation(conversationId: number): Promise<{ deleted: boolean; id: number }>`（照 `cancelAgentRun` 的写法） |
| `src/components/agent/conversation-list.tsx` | 行内 hover 删除图标 + `Popconfirm`；新增 props：`onDelete(id)`、`deletingId`（组件保持无状态） |
| `src/app/(protected)/agent/page.tsx` | `deletingId` state + `handleDelete(id)`：调用 → 成功则移行、必要时清空工作台；失败由拦截器提示后 `refreshList()` 对齐 |
| 服务端 | **零改动** |

**删除后不重新拉取列表**：就地移除该行即可 —— 删除不会改变其它行的排序或标题。

---

## 五、边界与「不做」（YAGNI）

- 不做批量删除、不做删除撤销 / 回收站
- 不做运行中会话的强删（服务端明确不支持：D19 的取消只作用于 pending）
- 不做列表项的键盘可访问改造（`div onClick` 是全站一致的历史局限，已登记在交接文档）
- 不引入前端测试栈（D25）

---

## 六、验收

**自动化（Claude 跑）**
- `npx vitest run` 全绿、`npx tsc --noEmit` 无输出、`npx next build` 通过
- `npx tsx src/scripts/agent-api-smoke.ts` —— 第 8 项已覆盖删除接口的 409 / 404 / 200 与级联深删，本次改的是调用方、接口调用方式不变，用来确认无回归

**浏览器（用户在 dev server 上点 3 步）**
1. 悬停任一会话行 → 右侧出现红色删除图标
2. 点击 → 弹出确认框（含会话标题）
3. 确认 → 该行消失并 toast；若删的是当前会话 → 工作台回到空态（中/右栏清空、输入框禁用）
   - 反向：删一个**执行中**的会话 → toast「会话正在执行中…」，行不消失

**不新增单测的理由**：本次是纯前端接线（D25：项目不引前端测试栈）；本功能可测的语义面（409/404/级联删除/库计数回到基线）已由 `agent-api-smoke.ts` 端到端覆盖。
