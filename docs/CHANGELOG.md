# 变更记录

本文件记录项目的功能新增与变更（对应 CLAUDE.md 开发原则第 4 条）。

---

## 2026-10-10 —— antd v6 废弃用法清理 + List 组件迁移

**变更类型**：重构 / 修复

### 背景

给 README 配图时暴露出运行时控制台告警。antd 版本实为 **6.6.1**（`package.json` 写 `^6.3.7`），
其中 `List` 已被标记为组件级废弃（`node_modules/antd/es/list/index.js` 每次渲染无条件告警，v7 将移除）。

### 1. 清理 11 项废弃用法（控制台告警 9 类 → 0）

| 原写法 | 新写法 | 处数 |
| --- | --- | --- |
| `Alert.message` | `title` | 45 |
| `Space.direction` | `orientation` | 17 |
| `Statistic.valueStyle` | `styles.content` | 14 |
| `Spin.tip` | `description` | 10 |
| `Drawer.width` | `size` | 9 |
| `Empty.imageStyle` | `styles.image` | 5 |
| `Drawer/Modal.destroyOnClose` | `destroyOnHidden` | 2 |
| `Button.iconPosition` | `iconPlacement` | 1 |
| `Dropdown.dropdownRender` | `popupRender` | 1 |

其中 `Alert.message` 与 `Space.direction` 是**接入告警探测器后才发现**的，此前人工扫描漏掉；
`destroyOnClose` 同时存在于 `Modal` 与 `Drawer`（布尔简写形式）。

### 2. 新增 `DataList` 替代废弃的 `List`（13 文件 / 24 处）

新增 `src/components/ui/data-list.tsx`（`DataList` / `DataListItem` / `DataListItemMeta`）
与 `globals.css` 结构规则。

刻意只覆盖项目实际用到的子集，**不是 antd List 的等价替身** —— 有意不实现
`grid` / `pagination` / `loading` / `bordered` / `header` / `footer` / `itemLayout`。

两条关键的层叠次序约定：

- 行内边距写在 CSS class（随 `size` 变化：`8px 16px` / `12px 0` / `16px 24px`），
  调用点的行内 `style` 才能自然覆盖；
- 分隔线用 CSS `:last-child` 实现而非 JS 算 isLast —— 调用点的行内 `border`
  既压过基规则也压过 `:last-child`，使「末行不留线」与「末行仍要留线」两种写法都正确。

`Meta` 保留 `h4` 标签以复刻现状字重（UA 的 `h4{font-weight:bold}`）。

### 3. 其他修复

- **补 favicon**：此前全站无 favicon，`/favicon.ico` 恒返回 404。由 `public/logo.png`
  压成 180×180 生成 `src/app/icon.png`，走 App Router 约定自动注入。
- **订正 CLAUDE.md 失效引用**：项目介绍里指向的 `docs/REWRITE_PLAN.md` 在仓库中不存在，已改为指向 `README.md` 与本文档。

### 验证

| 手段 | 结果 |
| --- | --- |
| 与 antd List 并排渲染 16 种形状，逐行比对 boundingRect 与计算样式 | 完全一致 |
| 16 张页面截图与迁移前逐像素比对 | 差异 0 像素 |
| 告警探测器（dev 模式，覆盖 21 个页面 + 弹层） | 0 类 antd 告警 |
| `npx tsc --noEmit` | 通过 |
| `npm test` | 30 文件 / 359 用例全绿 |

### 已知差异（有意保留）

- 未复刻 antd 的 `.ant-list * { outline: none }` —— 该项会掐掉列表内所有键盘焦点框，
  不复刻后列表内会出现焦点环，属可访问性改善。
- `DataList` 不跟随 `ConfigProvider` 的 `componentSize`（项目未设置该值）。

---

## 2026-10-10 —— 项目介绍文档与界面配图

**变更类型**：文档

**内容**：

1. 重写 `README.md` 为完整的项目介绍文档，新增章节：
   - 界面预览（11 张功能页配图 + 2 张操作态配图）
   - 功能模块（侧边栏 21 个功能页按职责分为六组）
   - 技术栈、系统架构（含 ASCII 架构图与关键设计说明）
   - 目录结构
2. 新增配图目录 `public/show/`，共 13 张截图：

   | 文件 | 内容 |
   | --- | --- |
   | `login.png` | 登录页 |
   | `agent.png` | Agent 工作台 |
   | `dashboard.png` | 总览 |
   | `accounts.png` | 账号矩阵 |
   | `accounts-bind.png` | 添加小红书账号抽屉（操作态） |
   | `discovery.png` | 笔记发现 |
   | `crawler.png` | 数据抓取 |
   | `library.png` | 内容库 |
   | `drafts.png` | 草稿工坊 |
   | `publish.png` | 发布中心 |
   | `auto-ops.png` | 自动运营 |
   | `auto-ops-create.png` | 新建自动运营任务表单（操作态） |
   | `review.png` | 审校工作台 |

   > 配图已对账号昵称、小红书号、平台用户 ID、头像及实时登录二维码做模糊处理。

**验证**：截图取自本地 dev server 实际运行页面（真实登录态 + 真实数据）；`npm test` 全绿。
