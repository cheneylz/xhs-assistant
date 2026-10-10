# xhs-assistant

**小红书运营平台助手** —— 基于 Next.js 全量重写的「抓取 → 洞察 → AI 创作 → 审校 → 发布」一体化运营工作台。

把账号矩阵、数据采集、内容库、AI 改写、合规审校和自动发布串成一条可调度的内容生产管线，并用一套本地实现的签名协议直接对接小红书 PC / Creator 双端接口。

![登录页](public/show/login.png)

---

## 目录

- [界面预览](#界面预览)
- [功能模块](#功能模块)
- [技术栈](#技术栈)
- [系统架构](#系统架构)
- [快速开始](#快速开始)
- [环境变量](#环境变量)
- [目录结构](#目录结构)
- [测试](#测试)
- [真实环境验证（PoC 清单）](#真实环境验证poc-清单)

---

## 界面预览

### Agent 工作台

以 Agent 会话为核心的操作台：左侧会话列表、中间对话区、右侧产出物面板，通过工具调用直接驱动抓取、改写、发布等动作。

![Agent 工作台](public/show/agent.png)

### 总览

把抓取、内容库、待发布与账号健康度放在同一张操作台上，并汇总高清话题与自动化执行结果。

![总览](public/show/dashboard.png)

### 账号矩阵

管理 PC 与 Creator 两类账号，支持二维码扫码、手机验证码、Cookie 导入三种绑定方式，并对 Cookie 做健康巡检与作用域隔离。

![账号矩阵](public/show/accounts.png)

<details>
<summary>查看「添加小红书账号」抽屉</summary>

![绑定账号](public/show/accounts-bind.png)

> 截图中的二维码为实时登录凭据，已做模糊处理。

</details>

### 笔记发现

按关键词或笔记链接检索，查看笔记详情、评论与原文，并一键保存到内容库。

![笔记发现](public/show/discovery.png)

### 数据抓取

支持搜索结果、笔记详情和评论批量抓取，失败项单独标注，结果可导出 Excel。

![数据抓取](public/show/crawler.png)

### 内容库

沉淀已保存的笔记素材，支持标签、筛选、批量操作与导出，是后续改写和发布的素材源。

![内容库](public/show/library.png)

### 草稿工坊

管理全部 AI 改写草稿，编辑正文与素材后送入发布中心。

![草稿工坊](public/show/drafts.png)

### 发布中心

预览草稿内容，配置发布参数后触发 Creator 端发布，支持立即发布与定时发布。

![发布中心](public/show/publish.png)

### 自动运营

设置关键词后自动抓取热门笔记、AI 改写并创建发布任务，形成全自动内容生产管线。

![自动运营](public/show/auto-ops.png)

<details>
<summary>查看「新建自动运营任务」表单</summary>

![新建自动运营任务](public/show/auto-ops-create.png)

</details>

### 审校工作台

双层内容预审（规则 + 语义）、声明验证、原创性检查、合规检查与梯度修复，三道门禁阻断违规内容发布。

![审校工作台](public/show/review.png)

---

## 功能模块

侧边栏共 **21** 个功能页，按职责分为六组：

| 分组 | 页面 | 说明 |
| --- | --- | --- |
| **智能体** | Agent 工作台 | 会话式操作台，工具调用驱动全站能力 |
| **数据侧** | 总览 | 抓取 / 内容库 / 待发布 / 账号健康度汇总 |
| | 策划工作台 | 全站热点洞察、爆款结构拆解与智能选题推荐（榜单每 30 分钟更新） |
| | 笔记发现 | 关键词与链接检索，查看详情、评论、原文 |
| | 数据抓取 | 搜索 / 详情 / 评论批量抓取，可导出 Excel |
| | 关键词组 | 维护选题、赛道与品牌关键词组，观察命中量与互动机会 |
| | 数据洞察 | 基于已保存笔记、标签和评论生成可执行的内容机会视图 |
| | 竞品监控 | 导入笔记链接追踪互动数据变化，洞察竞品表现 |
| **内容侧** | 内容库 | 笔记素材沉淀，标签 / 筛选 / 批量操作 / 导出 |
| | 草稿工坊 | AI 改写草稿管理与编辑 |
| | 图片工坊 | AI 生图、图片描述、封面合成与图片资产沉淀 |
| | 视频工坊 | 视频素材检测与处理 |
| **发布侧** | 发布中心 | 立即 / 定时发布，素材上传，发布任务管理 |
| | 自动运营 | 关键词 → 搜索 → AI 改写 → 自动发布全管线 |
| | 审校工作台 | 三道门禁合规审校与梯度修复 |
| | 评论运营 | 评论审核队列与自动回复规则 |
| **账号侧** | 账号矩阵 | PC / Creator 双账号体系，三种绑定方式 + Cookie 巡检 |
| **系统侧** | 工作流编排 | 预置工作流执行与技能库 |
| | 任务中心 | 异步任务进度与结果 |
| | 模型配置 | 文本 / 图像模型接入配置 |
| | 设置 | 平台与系统设置 |

---

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Next.js 15（App Router）+ React 19 |
| 语言 | TypeScript 5.9（`strict`） |
| UI | Ant Design 6 + `@ant-design/icons` + lucide-react |
| 状态 / 请求 | React Hooks + axios（Bearer Token + 自动刷新） |
| 图表 | Recharts 3 |
| 拖拽 | dnd-kit |
| 数据库 | PostgreSQL + Prisma 6（41 张表） |
| 校验 | Zod 4 |
| 调度 | node-cron（独立 worker 进程） |
| Agent | `@earendil-works/pi-agent-core` / `pi-ai`（ESM-only） |
| 测试 | Vitest 3 |
| 图像处理 | sharp |

---

## 系统架构

```
┌──────────────────────────────────────────────────────────┐
│  浏览器（Next.js App Router / React 19 / Ant Design 6）    │
│  src/app/(protected)/**  ← ProtectedRoute 鉴权 + AppShell  │
└───────────────────────────┬──────────────────────────────┘
                            │ 154 个 REST 路由（Bearer Token）
┌───────────────────────────▼──────────────────────────────┐
│  API 层  src/app/api/**                                    │
│  统一 handle() 包装：错误映射 / Zod 校验 / 鉴权             │
└───────────────────────────┬──────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────┐
│  服务层  src/lib/server/services/**（业务编排，24 个服务）   │
└──────┬──────────────────┬───────────────────┬────────────┘
       │                  │                   │
┌──────▼───────┐  ┌───────▼────────┐  ┌──────▼─────────────┐
│ 协议层        │  │ Agent 层        │  │ 数据层              │
│ xhs/         │  │ agent/          │  │ Prisma → PostgreSQL │
│ PC / Creator │  │ ReAct 循环      │  │ 41 张表             │
│ 签名 + 适配器 │  │ 工具注册表      │  └────────────────────┘
└──────┬───────┘  │ 流式事件        │
       │          └─────────────────┘
┌──────▼────────────────────┐
│ 传输层 transport/          │
│ curl-impersonate（TLS 指纹）│
└───────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│ 调度 Worker  src/worker/index.mts（独立进程，node-cron）    │
│ ① 定时发布 60s   ② 监控刷新 60s   ③ 自动运营管线 60s        │
│ ④ Cookie 巡检 2h ⑤ 热点榜单 30min ⑥ 评论自动响应 60s       │
│ ⑦ Agent 循环 3s（互斥锁防止任务重叠）                       │
└──────────────────────────────────────────────────────────┘
```

### 关键设计

**协议层自持签名。** 小红书请求所需的 `b1` / `X-s` / `X-S-Common` 签名算法 JS 已随项目携带（`src/lib/server/xhs/js/`），本地即可完成签名，不依赖外部服务；`PC` 与 `Creator` 两端各自维护独立的 auth / login-api / 适配器。

**传输指纹可替换。** 真实请求默认经 `curl-impersonate` 发出以保持 TLS 指纹保真；未安装时自动降级为 Node `fetch`（签名不受影响）。

**Agent 与 worker 解耦。** Agent 的 ReAct 循环跑在 worker 进程里（`agent_run_runner`，3s 轮询），Web 侧只做会话与事件流的读写，避免长任务占用请求生命周期。

**`.mts` 约束。** 依赖 Pi 包的模块必须保持 `.mts` 并以 ESM 加载，因此 `worker/index.mts` 内所有相对导入都显式带 `.ts` 后缀（ESM 不做扩展名推断）。

---

## 快速开始

```bash
# 1. 安装依赖（Node 24.17.0）
npm install

# 2. 配置环境变量
cp .env.example .env   # 修改 SECRET_KEY 等，详见下方环境变量

# 3. 初始化数据库（首次，PostgreSQL）
#    先创建数据库：CREATE DATABASE spider_xhs WITH ENCODING 'UTF8' TEMPLATE template0
npx prisma generate
npx prisma db push

# 4. 启动
npm run dev            # 开发（http://localhost:3000）
npm run worker         # 调度 worker（另开终端）
```

生产部署：`npm run build && npm start`，或用 Docker（`docker compose up -d`，app + worker 双服务）。

---

## 环境变量

| 变量                         | 默认                                                        | 说明                                          |
| ---------------------------- | ----------------------------------------------------------- | --------------------------------------------- |
| `DATABASE_URL`               | `postgresql://postgres:change_me@localhost:5432/spider_xhs` | PostgreSQL 连接串（需先建库，见快速开始）     |
| `SECRET_KEY`                 | `dev-only-change-me`                                        | JWT 签名密钥（生产必须改）                    |
| `FERNET_KEY`                 | 空                                                          | Fernet 加密密钥（空则从 SECRET_KEY 派生）     |
| `SCHEDULER_INTERVAL_SECONDS` | 60                                                          | worker 定时发布/监控刷新周期                  |
| `COOKIE_HEALTH_CHECK_HOURS`  | 2                                                           | worker Cookie 健康巡检周期                    |
| `CURL_IMPERSONATE_BIN`       | 空                                                          | curl-impersonate 二进制路径（PoC 必需，见下） |

密钥相关全部由 `.env` 管理并已加入 `.gitignore`，不入库。

---

## 目录结构

```
src/
├── app/                      # Next.js App Router
│   ├── (protected)/          # 受保护路由组（ProtectedRoute + AppShell）
│   │   ├── agent/            # Agent 工作台
│   │   ├── models/           # 模型配置
│   │   ├── settings/         # 设置
│   │   ├── tasks/            # 任务中心
│   │   └── platforms/xhs/    # 小红书 17 个功能页
│   ├── api/                  # 154 个 REST 路由
│   └── login/                # 登录页
├── components/               # UI 组件（account / agent / layout / ui）
├── hooks/                    # React Hooks
├── lib/
│   ├── agent/                # 前端 Agent 状态与轮询
│   └── server/
│       ├── core/             # 鉴权 / 加密 / 配置 / 数据库 / 错误
│       ├── services/         # 业务服务（~30 个）
│       ├── agent/            # Agent ReAct 循环、工具注册表
│       ├── xhs/              # 小红书协议层（PC / Creator / 签名 JS）
│       ├── media/            # 媒体处理
│       └── transport/        # curl-impersonate 传输
├── prompts/                  # 提示词模板
├── scripts/                  # 导入 / 冒烟脚本
└── worker/                   # 调度 worker（node-cron，7 个任务）
prisma/                       # 数据模型（41 张表）
public/show/                  # README 配图
tests/                        # 跨模块测试（安全 / 签名 / 契约）
```

---

## 测试

```bash
npm test        # vitest run
npm run test:watch
```

当前规模：**30 个测试文件 / 359 个用例全部通过**，覆盖安全兼容（JWT / Fernet / 密码哈希与 Python 版交叉验证）、签名一致性、HTTP 契约以及各业务服务。

---

## 真实环境验证（PoC 清单）

签名算法 JS 文件已随项目携带（`src/lib/server/xhs/js/`），本地签名（b1 / X-s / X-S-Common）无需网络。真实请求需要：

1. 安装 [curl-impersonate](https://github.com/lwthiker/curl-impersonate)（chrome146 档）并设置 `CURL_IMPERSONATE_BIN`；未安装时自动降级为 Node fetch（签名不受影响，但 TLS 指纹保真度需验证）
2. 绑定账号（QR / Cookie 导入）后测试真实搜索与发布
