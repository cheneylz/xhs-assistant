# XHS_ALL_IN_ONE — TypeScript + Next.js 全量重写方案

> 目标：用 TypeScript + Next.js 重写整个平台，**所有功能保持不变**（功能清单见 README「完整功能清单」章节）。
> 本文档基于对现有代码库的全面分析（后端 18 张表 / ~150 API 端点 / 前端 20+ 页面 / 逆向签名 SDK）编写。

---

## 1. 结论先行

**可行，且可行性高于一般直觉。** 决定性事实：**小红书逆向签名层本来就是 JavaScript**（`xhs_utils/*/js/` 下 30+ 个纯算法文件，Python 侧只是用 Node 子进程执行）。因此签名算法可以**原样复用**，不存在"重新逆向"的不确定性。真正需要攻关的只有 1 项技术风险（TLS 指纹模拟）和 1 项架构调整（调度器独立进程），其余全部为翻译型工作量。

单人估算 **4~6 周**，其中前端部分因已是 TypeScript + React 可近乎平移。

---

## 2. 现状盘点

### 2.1 技术栈

| 层 | 现有技术 | 规模 |
|---|---|---|
| 后端 | FastAPI + SQLAlchemy 2.0 + Alembic + APScheduler | 18 张表、~150 个 REST 端点、5 个服务模块 |
| 前端 | **React 19 + Vite + TypeScript** + antd v6 + axios + dnd-kit + recharts + zod | 20+ 页面、880 行 API 客户端、70+ 手写类型 |
| 签名 SDK | Python 封装 → **Node 子进程执行 JS**（mns/b1/xs_common/rap/websectiga 等） | 30+ 个纯算法 JS 文件 |
| HTTP 传输 | curl_cffi（TLS/HTTP2 指纹模拟 chrome146）+ 强制 header 顺序契约 | 全 SDK 共用 |
| 数据 | SQLite（默认）/ MySQL；手写 JWT；Fernet 加密 Cookie 与 API Key | 单用户系统 |
| 调度 | APScheduler 后台 4 个 interval 任务 | 与 FastAPI 同进程 |

### 2.2 数据模型（18 张表 + 1 关联表）

`users`、`platform_accounts`（PC/creator 双账号体系）、`account_cookie_versions`、`login_sessions`、`notes`、`note_assets`、`note_comments`、`tags` + `note_tags`、`ai_drafts`、`draft_assets`、`ai_generated_assets`、`model_configs`、`publish_jobs`、`publish_assets`、`tasks`、`auto_tasks`、`monitoring_targets`、`monitoring_snapshots`、`notifications`、`keyword_groups`、`api_logs`

### 2.3 API 端点分组

认证 / 平台注册 / 账号 / XHS 登录会话（QR + 短信轮询）/ 笔记 / 文件（上传下载 + 图像 compose/resize）/ 草稿 / AI（文本改写 + 图片生成）/ 任务 / 模型配置 / 标签 / 通知 / 关键词组 / 发布 / XHS PC（搜索/详情/评论）/ XHS 爬虫（含 SSE 流式）/ XHS 创作者（话题/地点/上传/发布）/ XHS 监控 / XHS 分析 / 自动运营 / health

### 2.4 关键交互机制

- **QR 登录**：HTTP 轮询（前端 2s setInterval），无 WebSocket
- **通知**：HTTP 轮询（30s）
- **抓取进度**：SSE 流式（`/api/xhs/crawl/data`），前端 fetch reader 解析
- **定时发布/自动运营**：APScheduler 后台线程
- **素材拖拽排序**：dnd-kit 前端本地 + 后端 reorder 端点
- **上传下载**：普通 multipart / FileResponse，无分片

---

## 3. 目标架构

```
┌─────────────────────────────────────────────┐
│  Next.js (App Router, 强制 Node.js runtime)  │
│  ├─ app/**/page.tsx          前端页面（平移现有 TSX）│
│  ├─ app/api/**/route.ts      ~150 个端点（逐端点复刻）│
│  ├─ src/lib/xhs/             签名 TS 类 + SDK 会话状态机 │
│  ├─ src/lib/xhs/js/          ★原 JS 签名文件原样引入     │
│  ├─ src/lib/transport/       curl-impersonate 封装      │
│  └─ prisma/                  ORM schema（SQLite/MySQL） │
└───────────────┬─────────────────────────────┘
                │ 共享同一数据库（SQLite 文件 / MySQL）
┌───────────────▼─────────────────────────────┐
│  Worker 进程（独立部署，node-cron）           │
│  ① 定时发布扫描（60s） ② 监控刷新（60s）      │
│  ③ 自动运营管线（60s） ④ Cookie 健康巡检（2h）│
└─────────────────────────────────────────────┘
```

**为什么调度器必须独立进程**：Next.js 是请求驱动进程，无法可靠承载常驻定时任务。拆出 worker 进程后：
- 主应用无状态，可多实例/无感重启
- 调度任务与请求线程解耦，顺带修复现有"请求内同步执行任务"的设计缺陷
- Docker compose 增加一个 `worker` 服务即可

**为什么必须 Node.js runtime**：`websectiga_cli.js`（执行服务端下发 JSVMP 脚本）与 Creator DS 程序依赖 Node `vm` 模块，**不可部署到 Edge runtime**。

---

## 4. 技术选型对照表

| 现有 | 选型 | 说明 |
|---|---|---|
| FastAPI 路由 | Next.js Route Handlers | 同构路径 `app/api/**/route.ts`，SSE 用 ReadableStream |
| SQLAlchemy + Alembic | **Prisma**（或 Drizzle） | SQLite + MySQL 双支持，JSON 列原生，迁移自动生成 |
| Pydantic schemas | **Zod** | 与前端类型共用一份 schema，消除双份维护 |
| 手写 JWT | `crypto` 原生（HMAC-SHA256） | 保持算法不变，access 15min / refresh 7d |
| Fernet 加密 | npm `fernet`（或手写 AES-128-CBC+HMAC） | Cookie / API Key 落库加密，密钥派生逻辑不变 |
| APScheduler | **node-cron**（worker 进程） | 4 个任务等价平移，`max_instances=1` 用互斥锁实现 |
| curl_cffi（TLS 指纹） | **curl-impersonate 二进制**（child_process） | 唯一高风险项，见 §6 风险 1 |
| requests / retry | axios / undici + p-retry | 全部同步调用，无并发差异 |
| PyExecJS（creator 签名） | **直接 import 原 JS 文件** | 无需桥接层，天然更优 |
| opencv-python | sharp + ffprobe/ffmpeg | 仅用取尺寸 + 视频抽帧封面，见 §5.4 |
| Pillow | sharp + SVG text | 封面合成 / 缩放 / webp→jpeg |
| qrcode | npm `qrcode` | `toDataURL` 生成 base64 |
| openpyxl | exceljs | 仅遗留 CLI 爬虫用，平台导出为 CSV/JSON 无需改 |
| react-router-dom | Next.js 文件路由 | 20+ 条路由一一对应 |
| axios（前端） | 保留 axios | 拦截器逻辑原样搬运 |
| keepalive-for-react | 放弃或 react-activation | 仅 discovery/crawler 两页保活，非核心功能 |

---

## 5. 各层移植要点

### 5.1 签名 SDK 层（复用，非重写）

**核心资产：`xhs_utils/*/js/` 下 30+ 个纯算法 JS 文件，直接拷入项目使用。**

| 文件 | 作用 | 处理 |
|---|---|---|
| `xhs_core/js/sign.js` | 签名统一入口（x3/xs/xt/xs_common），可执行服务端 DS 程序 | 直接引入 |
| `xhs_core/js/mns.js` | MNS 0101/0201/0301 三档签名（TLV、XXTEA、自定义 Base58/64、ARX） | 直接引入 |
| `xhs_core/js/b1.js` | b1 生成（RC4 + 自定义 Base64） | 直接引入 |
| `xhs_core/js/xs_common.js` | X-S-Common + CRC32 变体 | 直接引入 |
| `xhs_core/js/websectiga_cli.js` / `websectiga_env.js` | 执行服务端 JSVMP 脚本（需 `vm` 模块） | 直接引入 |
| `xhs_pc/js/*` | profile.js / rap.js / aes_*.js / deflate.js（纯算） | 直接引入 |
| `xhs_creator/js/*` | 薄封装指向共享核心 | 直接引入 |
| `mns_keystreams.json` / `mns_0101_keystream.json` / `reference_profile.json` 等 | 密钥流 / 设备模板 | 原样保留 |

**需要 TS 翻译（Python 侧逻辑）**：
- `runtime.py` 的 Node 子进程调用 → 直接 `import` / `require` 原 JS（消除 subprocess 开销）
- 会话状态机 `PcDeviceProfile` / `PcSessionState`（seq/loadts/dsllt/tiga 刷新/fingerprint_ready）
- `HostCookieStore`（按 host 隔离 + 键序保持）——纯逻辑平移
- `dsl.py` 的 `_dsl` 锚点时间戳获取 + 5 分钟内存缓存
- 输出门禁校验（x3 前缀/长度检查）→ 转为单测断言，保证与 Python 版逐字节一致

**兼容策略**：与 Python 版共用同一份 JS 源文件（symlink 或构建拷贝），XHS 升级签名时两边同步替换，行为一致。

### 5.2 API 层（逐端点复刻）

- **认证**：`OAuth2PasswordBearer` 等价物 → 中间件/装饰器解析 `Authorization: Bearer`，逻辑不变
- **登录会话**：`login_sessions.py` 的 QR 生成（qrcode→dataURL）、状态轮询（HTTP GET）、confirmed 后 upsert 账号 + 可选联动 creator 账号——全部原逻辑平移
- **SSE**：`crawl.py /data` 用 `ReadableStream` 输出 `item/progress/done/error` 四类事件，字段名不变，前端 fetch reader 代码零改动
- **文件**：`/api/files/upload` multipart 白名单 + 100MB 上限不变；`/media/{name}` 静态服务用 `sendFile`；`/exports/{name}` 同
- **定时发布 / 自动运营管线**：三段重复实现的管线逻辑（`api/auto_tasks.py` / `api/publish.py` / `scheduler_service.py`）在 worker 内统一为单一实现，行为对外保持不变（手动触发路径 A / 调度闭环路径 B / 定时发布路径 C）

### 5.3 数据层

- Prisma schema 按现有 18+1 张表逐字段翻译（含 JSON 列、自引用 `parent_task_id`、`parent_comment_id`）
- 时间统一 `Asia/Shanghai` 语义保持（naive datetime 存储），前端 `lib/time.ts` 平移
- 手写数据迁移（gpt5.4→gpt-5.4 改名、SQLite 日期 +8h 归一化）在新库初始化时等价格式保留

### 5.4 媒体处理

| Python | TS | 说明 |
|---|---|---|
| `cv2.imdecode` 取宽高（get_file_info） | sharp.metadata() | 仅尺寸信息，无像素处理 |
| `cv2.VideoCapture` 时长/FPS/抽首帧封面 | ffprobe + ffmpeg | 顺带替换 opencv 依赖 |
| `PIL` 封面合成 compose_cover_image | sharp.composite + SVG text | 圆角色条/标题换行/页脚布局参数平移 |
| `PIL` resize_image_file（contain/fit + LANCZOS） | sharp.resize 对应策略 | 输出格式/质量参数平移 |
| webp→jpeg（quality 92） | sharp | 上传兼容性不变 |

### 5.5 调度 worker

| APScheduler 任务 | 周期 | worker 等价物 |
|---|---|---|
| due_publish_runner（定时发布） | 60s（可配） | node-cron + 互斥锁（防并发） |
| monitoring_refresh_runner | 60s | 同上 |
| auto_tasks_runner（自动运营全管线） | 60s | 同上 |
| cookie_health_checker | 2h | 同上 |

`rate_limiter`（内存滑动窗口，5 次/分/账号）平移进 worker 与 API 公共模块。

### 5.6 前端层（平移为主）

- 20+ 页面 TSX **原样拷贝**进 `app/` 目录，仅改：路由（react-router → 文件路由）、`api.ts` baseURL 保持 `/api` 不变
- AppShell（侧边栏 13 项导航 + 通知铃铛 + 主题切换）→ `app/layout.tsx` 布局 + 客户端组件
- 认证守卫：ProtectedRoute/PublicOnlyRoute → Next.js middleware 或客户端布局校验（保持现有 use-auth store + useSyncExternalStore 模式，无需引入第三方状态库）
- 各页面 useEffect 数据拉取模式保持不变（不强制迁移到 react-query，控制改动面）
- antd v6 主题配置（暗/亮）平移

---

## 6. 风险清单与对策

| # | 风险 | 等级 | 对策 |
|---|---|---|---|
| 1 | **TLS 指纹模拟迁移**（curl_cffi chrome146 → curl-impersonate） | **高** | **开工第一优先做 PoC**：curl-impersonate 直连 XHS，跑通 1 次真实搜索 + 1 次真实发布，确认风控放行；备选方案：node-curl-impersonate 包装 / Playwright 无头浏览器（最重最后选） |
| 2 | websectiga JSVMP / DS 程序需 `vm` 模块 | 中 | 锁定 Node.js runtime，禁止 Edge 部署；文档 + CI 断言 |
| 3 | 调度器脱离主进程后的一致性 | 中 | worker 与主应用共享 DB 与限流模块；compose 编排；互斥锁防重叠执行 |
| 4 | 长任务超时（AI 生图 180s / 上传 100MB） | 低 | Next.js 独立 server 配置（`serverActions` 无关，route handler 超时调优），必要时 http.Server 手动创建 |
| 5 | KeepAlive 页面保活丢失 | 低 | 放弃或 react-activation；影响仅 discovery/crawler 滚动位置 |
| 6 | 签名 JS 随 XHS 更新失效 | 低 | 与 Python 版共用源文件，升级路径一致；门禁校验转单测 |
| 7 | 前端图片下载 URL 相对路径约定（`/api/files/media/...`） | 低 | 路由平移后天然兼容 |

---

## 7. 功能不变性保障策略

1. **API 契约冻结**：以现有 OpenAPI 文档（FastAPI `/docs`）导出为基线，重写后逐端点 diff（方法/路径/请求/响应字段），用契约测试锁定
2. **行为基准对照**：Python 版与 TS 版并行运行，关键流程（登录→搜索→入库→AI→发布）做端到端对照测试
3. **签名一致性**：签名产物（x3/x-s/x-s-common/b1）用固定输入在两端生成并比对，逐字节一致为通过标准
4. **数据库兼容**：新库 schema 与旧库逐表比对；提供旧库导入/迁移脚本，用户数据无缝迁移
5. **前端像素级对齐**：页面截图对照现有 `static/frontend_*.jpg` 与实机运行效果
6. **验收清单**：README「完整功能清单」逐项打勾 + 126 条现有测试等价平移（pytest → vitest）

---

## 8. 实施计划（里程碑）

### M0 — PoC（2~3 天，先行验证风险 1）
- [ ] 搭 Next.js + Prisma 脚手架
- [ ] 原 JS 签名文件引入并跑通 `sign.js`（对比 Python 输出）
- [ ] curl-impersonate 封装完成，**真实搜索 1 次 + 真实发布 1 次**
- [ ] 通过 → 进入 M1；失败 → 评估 Playwright 备选方案并重新验证

**验收**：签名产物与 Python 版逐字节一致；搜索/发布在 XHS 真实环境放行。

### M1 — 基础设施（3~4 天）
- [ ] Prisma 建模 18+1 张表 + 迁移脚本 + 旧库数据导入工具
- [ ] 认证（JWT 手写实现 / 注册 / 登录 / refresh / 登出 / me）
- [ ] Fernet 加密模块（Cookie / API Key）
- [ ] 配置系统（env + 配置文件，SQLite/MySQL 切换）
- [ ] Docker：app + worker 双服务 compose

**验收**：注册→登录→建模型配置→测试连通 全链路可用。

### M2 — SDK 翻译（1~2 周，与 M3 可并行）
- [ ] 会话状态机 + HostCookieStore + 限流器
- [ ] PC 登录（QR/短信/Cookie 导入）与 PC API 适配器
- [ ] Creator 登录（CAS/QR/交换会话）与 Creator API 适配器
- [ ] 蒲公英 / 千帆 SDK
- [ ] 视频封面抽取（ffprobe/ffmpeg）+ 图片尺寸（sharp）

**验收**：每个适配器方法与 Python 版对照返回一致。

### M3 — API 复刻（1~2 周）
- [ ] ~150 端点逐组复刻（按 §2.3 分组顺序）
- [ ] SSE 流式抓取
- [ ] AI 服务（OpenAI 兼容文本/图片客户端）
- [ ] worker 进程：4 个调度任务 + 自动运营全管线统一实现

**验收**：契约测试全绿；手动触发自动任务产出可发布的草稿+任务。

### M4 — 前端迁移（1 周）
- [ ] 20+ 页面平移 + 路由改造 + AppShell
- [ ] QR 登录面板 / SSE 进度 / 拖拽排序 / 定时发布交互回归

**验收**：全部页面可导航、可操作，与现有版本功能一一对应。

### M5 — 联调回归（3~5 天）
- [ ] 全链路：绑定账号 → 搜索入库 → 内容库 → 草稿工坊 → AI 改写/生图 → 发布中心（立即+定时）→ 自动运营 → 监控 → 洞察
- [ ] 126 条测试等价平移 + 契约测试 + 签名一致性测试
- [ ] 数据迁移演练 + 文档更新（README/部署）

**验收**：README 功能清单 100% 打勾；旧库导入后功能无感知。

---

## 9. 工作量汇总

| 里程碑 | 估时 | 说明 |
|---|---|---|
| M0 PoC | 2~3 天 | 风险前置验证 |
| M1 基础设施 | 3~4 天 | 脚手架/建模/认证 |
| M2 SDK 翻译 | 1~2 周 | 与 M3 并行 |
| M3 API 复刻 | 1~2 周 | 含调度 worker |
| M4 前端迁移 | 1 周 | 现有 TSX 平移 |
| M5 联调回归 | 3~5 天 | 契约/对照/数据迁移 |
| **合计** | **4~6 周（单人）** | 不含 XHS 端风控策略变化导致的返工 |

---

## 10. 决策备忘（需要确认的事项）

1. **ORM**：Prisma（推荐，生态成熟）vs Drizzle（更轻，SQLite 体验好）
2. **调度器**：独立 worker 进程（推荐）— 接受部署形态变为双服务
3. **KeepAlive 保活**：放弃（推荐，影响极小）vs react-activation 补齐
4. **前端数据层**：维持 useState/useEffect 现状（推荐，改动面最小）vs 引入 TanStack Query
5. **数据库**：保留 SQLite 默认 + MySQL 可选（推荐，与现状一致）
6. **是否保留 Python 版**：建议保留为对照基准直至 M5 完成
