# xhs-assistant 项目代码文档

> 小红书运营平台助手（Next.js 全量重写版，原版为 FastAPI + React Vite，见 `../XHS_ALL_IN_ONE`）
> 重构依据：`docs/REWRITE_PLAN.md`；进度记录：`docs/REWRITE_PROGRESS.md`

## 1. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 框架 | Next.js 15 (App Router) + React 19 + TypeScript | 强制 Node.js runtime（签名 SDK 依赖 node:vm） |
| ORM | Prisma 6（PostgreSQL） | 19 张表，与旧库逐字段一致（snake_case 列名 @map） |
| UI | antd v6 + @ant-design/icons + recharts + @dnd-kit | 与旧前端一致，页面平移 |
| 校验 | zod（前后端共用 schema 约定） | 请求体验证，422 错误 |
| 认证 | 手写 JWT（HS256，access 15min / refresh 7d）+ pbkdf2_sha256 密码哈希 | 与 Python 版逐字节兼容 |
| 加密 | Fernet（AES-128-CBC + HMAC-SHA256，node:crypto 实现） | 与 Python cryptography.fernet 互操作，旧库数据可直接解密 |
| 签名 SDK | 原 JS 算法文件直接 require（消除 Node 子进程） | `src/lib/server/xhs/js/` 16 个 JS + 7 个 JSON 原样保留 |
| 传输 | curl-impersonate 二进制（child_process）→ fetch 降级 | 见 `src/lib/server/transport/` |
| 调度 | 独立 worker 进程（node-cron，互斥锁） | `npm run worker` |
| 测试 | vitest（安全兼容 / 签名一致性 / 工具函数） | |

## 2. 目录结构

```
src/
├── app/                        # Next.js App Router（页面 + API 路由）
│   ├── api/                    # ~150 个 REST 端点（Route Handlers）
│   │   ├── auth/               # 注册/登录/refresh/登出/me
│   │   ├── accounts/           # 账号管理（Cookie 导入/健康检查）
│   │   ├── notes/ drafts/      # 内容库/草稿工坊
│   │   ├── publish/            # 发布中心（jobs/assets）
│   │   ├── auto-tasks/         # 自动运营
│   │   ├── model-configs/      # AI 模型配置
│   │   ├── tags/ notifications/ keyword-groups/ tasks/
│   │   ├── files/              # 上传/下载/图片合成/缩放
│   │   ├── ai/                 # AI 改写/生图/图片描述
│   │   └── xhs/                # 平台专属：pc / crawl(SSE) / creator / monitoring / analytics / login-sessions
│   ├── (protected)/            # 路由组：认证守卫 + AppShell 布局
│   │   └── platforms/xhs/...   # 21 个页面
│   ├── login/ platform-select/ platforms/[platformId]/
│   └── layout.tsx              # 根布局（AppProviders：antd 主题 + 本地化）
├── lib/                        # 前端共享（client）
│   ├── api.ts                  # axios 客户端（拦截器原样平移）
│   ├── types.ts                # 手写 API 类型（70+）
│   └── platforms.ts time.ts
├── types/                      # API 类型（旧前端 types/index.ts 平移）
├── hooks/use-auth.ts           # 认证状态（useSyncExternalStore）
├── components/                 # AppShell / 路由守卫 / 登录面板 / 平台选择
├── lib/server/                 # 后端（server-only）
│   ├── core/                   # config / db(Prisma) / security / auth / time / http-error / route / paginate
│   ├── xhs/                    # ★签名 SDK 层（详见 §3）
│   ├── transport/              # curl-impersonate 封装
│   ├── media/                  # sharp 图像工具 + ffprobe/ffmpeg 视频
│   ├── services/               # 调度/监控/AI/账号/通知/限流/规范化
│   └── worker/                 # 独立调度进程（node-cron 4 任务）
├── scripts/import_old_db.ts    # 旧库导入工具（npm run db:import）
└── worker/index.ts             # worker 进程入口
prisma/schema.prisma            # 19 张表（与旧库逐列一致）
tests/                          # vitest 测试（安全兼容/签名/工具）
docs/                           # 项目文档
```

## 3. 签名 SDK 层（src/lib/server/xhs/）

| 模块 | 对应原版 | 说明 |
|---|---|---|
| `js/`（core/pc/creator 子目录） | `xhs_utils/*/js/` | ★原 JS 算法文件原样保留（16 JS + 7 JSON），与 Python 版共用同一份源，升级同步替换 |
| `core/runtime.ts` | `xhs_core/runtime.py` + `xhs_pc/runtime.py` | 直接 require JS（b1/sign/profile/rap），输出门禁与 Python 逐条对齐；websectiga 保留子进程（JSVMP 不可信代码 + CLI 顶层读 stdin） |
| `core/cookies.ts` | `xhs_core/cookies.py` | HostCookieStore（按 host 隔离 + 键序保持） |
| `core/dsl.ts` | `xhs_core/dsl.py` | ds 接口 getdss() 拉取 + 5 分钟缓存 + 失败降级 |
| `core/http.ts` | `xhs_core/http.py` | orderedWireHeaders + BrowserHttpClient（curl-impersonate/fetch） |
| `core/auth.ts` | `xhs_core/auth.py` | PC/Creator 平台配置（域名/角色） |
| `pc/state.ts` | `xhs_pc/state.py` | PcDeviceProfile 状态机（MNS 档位/b1 遥测/dsllt/tiga） |
| `pc/params.ts` | `xhs_pc/params.py` | 签名请求头组装（8 种 header 顺序契约）+ murmur3 + traceid |
| `pc/login-api.ts` | `apis/xhs_pc_login_apis.py` | PC 登录全流程（QR/短信/安全引导） |
| `pc/api.ts` | `apis/xhs_pc_apis.py` | PC 业务 API（搜索/详情/评论/用户） |
| `creator/*` | `xhs_creator/*` + `apis/xhs_creator_*` | Creator 状态机/签名/登录/发布/上传 |
| `creator/publish.ts` | `xhs_creator_util.py` | 发布负载构造 + 上传签名 |
| `adapters/` | `backend/app/adapters/xhs/` | 平台 API 适配器（路由与调度共用） |
| `request-env.ts` | `request_env.py` | SDK 调用期间清除代理环境变量 |

## 4. API 契约约定

- 所有响应字段 snake_case，与 Python 版 FastAPI 输出一致
- 错误响应 `{"detail": "..."}`；401 带 `WWW-Authenticate: Bearer`
- 时间输出 naive 上海时间字符串 `YYYY-MM-DDTHH:mm:ss`（`formatDateTime`）
- 分页 `{total, page, page_size, items}`（page>=1、page_size 1..100，越界 422）
- 认证：`Authorization: Bearer <access_token>`
- SSE：`/api/xhs/crawl/data` 输出 `item/progress/error/done` 四类事件

## 5. 关键约定

- **时间语义**：数据库存「上海时区 naive datetime」—— `shanghaiNow()` 生成 Date 的 UTC 字段即上海墙钟，格式化不做时区换算（见 `src/lib/server/core/time.ts`）
- **密钥**：全部由 `.env` 管理（DATABASE_URL/SECRET_KEY/FERNET_KEY），不入库
- **命名**：变量/函数 camelCase，注释中文，接口 REST
- **启动**：`npm run dev`（开发）/ `npm run build && npm start`（生产）/ `npm run worker`（调度）
- **旧库导入**：`npm run db:import [源库路径]`（读取任意 SQLite 库 → 写入 PostgreSQL；仅对旧 FastAPI 库自动执行 gpt5.4→gpt-5.4 改名、SQLite 日期 +8h 归一化——以源库是否存在 `app_migrations` 表判别；单事务，失败整体回滚，幂等可重跑）

## 6. 测试

- `tests/security.test.ts`：JWT/Fernet/密码哈希与 Python 版交叉兼容（测试向量由 Python 生成）
- `tests/signature.test.ts`：murmur3/xy-direction/base36 与 Python 逐值一致 + b1 生成门禁 + PC 状态机
- 运行：`npm test`
