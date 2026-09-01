# 重构进度与变更记录

> 对应 `REWRITE_PLAN.md` 的里程碑 M0~M5。本文档记录重构过程中的关键决策与遗留事项。

## 里程碑状态

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M0 PoC（脚手架 + 签名引入 + 传输层） | ✅ 代码完成，**真实网络验证待用户执行** | curl-impersonate 二进制本机未安装，传输层自动降级 fetch；PoC 清单见下 |
| M1 基础设施（Prisma/认证/Fernet/配置/导入工具） | ✅ | 19 表建模与旧库逐列一致；旧库导入已验证（含真实 Cookie 解密） |
| M2 SDK 翻译 | ✅ | JS 原样引入 + TS 状态机平移；签名一致性测试 30 项通过 |
| M3 API 复刻 | ✅ | ~150 端点（107 个路由文件），含 SSE 流式爬取 |
| M3 调度 Worker | ✅ | node-cron 4 任务 + 互斥锁，冒烟测试通过 |
| M4 前端迁移 | ✅ | 21 页面 + AppShell + 守卫，全部页面 e2e 验证 200 |
| M5 联调回归 | 🔄 部分完成 | 端到端验证通过（注册/登录/CRUD/媒体/SSE 错误路径）；完整回归见「遗留事项」 |

## 关键决策记录

1. **ORM 选 Prisma**（用户确认）
2. **Fernet 密钥分半顺序**：本机 cryptography 50.0.0 为「签名=key[:16]、加密=key[16:]」（新版布局），旧库数据即该布局加密，已用旧库真实 Cookie/API Key 验证
3. **node:crypto 的 AES-CBC 自动 PKCS7 填充**：无需手工 pad/unpad
4. **登录会话路径**：`/api/xhs/login-sessions`（与原版一致，accounts 代理初版误写为 /api/login-sessions，已迁移修正）
5. **keepalive-for-react 放弃**：AppShell 直接渲染 children（仅影响 discovery/crawler 滚动位置）
6. **蒲公英签名**：原版 generate_pugongying_headers 调 generate_xs_xs_common 是破损中间态，按 generate_xs 设计意图平移（只带 X-s/X-t）
7. **analytics 生图不落盘**：原版即仅存 URL
8. **worker 自动运营**：PC 适配器按任务账号 Cookie 工厂构造（修正初版注入设计）

## PoC 清单（需用户在真实环境验证）

- [ ] 安装 curl-impersonate 二进制（chrome146 档），设置 `CURL_IMPERSONATE_BIN`
- [ ] 用已绑定账号跑一次真实搜索（`POST /api/xhs/pc/search/notes`）
- [ ] 用已绑定账号跑一次真实发布（`POST /api/publish/jobs/{id}/publish`）
- [ ] 若被风控拦截（406/验证码），评估 Playwright 备选方案（REWRITE_PLAN §6 风险 1）

## 遗留事项

- [ ] 旧库 126 条 pytest → vitest 等价平移（当前 30 项核心测试）
- [ ] API 契约测试（对照原版 OpenAPI 逐端点 diff）
- [ ] 前端页面全量回归（页面迁移完成后）
- [ ] README 重写（部署/使用文档）
- [ ] Excel 导出（原版 openpyxl 遗留 CLI 功能，平台导出为 CSV/JSON 已覆盖）
- [ ] data_util.py 的遗留爬虫工具（save_to_xlsx/download_note 等）未平移——平台 API 不依赖，按需补充
- [ ] Docker 镜像构建验证（Dockerfile 已按 standalone + 签名 JS 拷贝编写，未实构建）

## 变更日志

| 日期 | 变更 |
|---|---|
| 2026-08-21 | 脚手架/Prisma 建模/认证/Fernet/旧库导入完成 |
| 2026-08-21 | 签名 SDK 层（core/pc/creator/蒲公英/千帆）全部平移，30 项一致性测试通过 |
| 2026-08-21 | API 层 ~150 端点复刻完成（含 SSE），tsc 零错误、next build 通过 |
| 2026-08-21 | Worker 进程（4 调度任务）完成 |
| 2026-08-21 | 前端基座（AppShell/守卫/登录/平台选择）完成 |
| 2026-08-21 | 21 页面全部迁移完成；生产构建通过；端到端验证：登录页渲染、注册/登录/me、标签/关键词组/模型配置（Fernet 加密）/监控目标 CRUD、封面合成/下载/上传、SSE 错误路径全部通过 |
| 2026-08-21 | Dockerfile（app+worker 双服务 compose）、README、PROJECT_DOC、REWRITE_PROGRESS 完成 |
| 2026-08-23 | 去除平台工作区选择，默认进入小红书工作区（删除 /platform-select、Coming Soon 占位页、/api/platforms 及前后端平台注册表，无 git 记录不可恢复） |
| 2026-08-23 | 视频工坊上线：素材库 + ffprobe 规格体检（小红书规范）+ 封面抽帧 + H.264 转码（/api/xhs/video-studio/detect|cover|transcode）；上传上限 100MB→500MB；任务式发布支持视频（SDK 内部抽帧/上传/转码轮询）；Dockerfile 补装 ffmpeg；本机 ffmpeg 依赖 G:\ffmpeg\bin（用户 PATH） |
| 2026-08-23 | 视频工坊 P1：AI 生成视频文案（复用 /api/ai/generate-note，自动建草稿）；一键发送到草稿工坊（无文案新建草稿、有文案挂载素材，复用 /api/drafts 与 assets 接口）；素材库支持外部拖入视频文件上传（Upload.Dragger 多选） |
| 2026-08-24 | 修复 Creator 登录 QR 码生成 wire header 契约漂移：generateProfileRequestParams 默认注入 x-b3-traceid/x-xray-traceid（浏览器实证仅 redcaptcha/login-user-info/业务签名请求携带），CAS/security 契约表不含这两个头；10 处 _signed 调用点显式补 includeTraceHeaders: false（含 QR 码生成/查询、zones、service-ticket、verify-code、手机号登录、DS/websectiga/webprofile）；补 3 项契约回归测试 |
| 2026-08-24 | UI 风格迁移到小红书创作平台浅色风格（参考 html/xhs.html）：删除暗色模式与切换按钮（仅保留浅色主题）；主色 #1668dc→#386bff；AppShell 浅色化（白底 Sider/选中浅蓝底、删除主题切换按钮、通知面板浅色化）；登录页重做浅色渐变+白卡片；账号组件 4 文件浅色化；24 页 280 处暗色 token 全部替换（含白字 alpha 分层映射）；globals.css 浅色滚动条/表格 hover/主色效果。规范见 docs/UI_THEME.md |
| 2026-09-01 | **数据库迁移 SQLite → PostgreSQL**：schema provider 改 postgresql（db push 建表，Int→serial/Json→jsonb/DateTime→timestamp(3)）；`.env`/`.env.example`/`config.ts` 默认值改 PG 连接串；`import_old_db.ts` 写侧重写为 pg 直连（读侧 node:sqlite 保留）：以源库是否存在 `app_migrations` 表判别是否执行旧库归一化（避免对 Prisma 新建库重复 +8h）、datetime 三分支转换（epoch ms / ISO 带 Z / naive 串，纯文本处理保持上海 naive 语义）、单事务 + setval 序列延续、源列∩PG 列交集过滤 legacy 列、支持 argv 源库路径参数；新增 pg/@types/pg 依赖；docker-compose 新增 postgres:18-alpine 服务（宿主 5433 映射、PG18 新卷路径、healthcheck，app/worker 容器内直连）；现有 SQLite 数据已迁移至本地 PG（22 表行数/值级对比一致、无时区偏移、序列连续、幂等重跑通过、vitest 51 项通过、next build 通过、dev/worker 冒烟通过）；SQLite 备份保留于 prisma/data/xhs_crawer.pre-pg.db |
