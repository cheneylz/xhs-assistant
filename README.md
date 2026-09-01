# xhs-assistant

小红书运营平台助手 —— 基于 Next.js + TypeScript 开发的类爬虫系统

## 功能概览

- **账号矩阵**：PC / Creator 双账号体系，QR / 短信 / Cookie 导入三种绑定方式，Cookie 健康巡检
- **笔记发现**：关键词搜索、笔记详情、评论抓取（SSE 流式进度）
- **数据抓取**：关键词 / 批量 URL / 用户笔记爬取，自动入库 + 素材本地化
- **内容库**：笔记管理（标签、素材、评论、批量操作、CSV/JSON 导出）
- **草稿工坊**：AI 改写 / 标题生成 / 标签生成，图片工坊（封面合成 / 缩放 / AI 生图）
- **发布中心**：立即 / 定时发布，素材上传，发布任务管理
- **自动运营**：关键词 → 搜索 → AI 改写 → 自动发布全管线（手动触发 + 定时调度）
- **竞品监控**：关键词 / 账号 / 品牌 / 笔记监控，快照与趋势
- **数据洞察**：内容分析、热词趋势、竞品基准、报告导出

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env   # 修改 SECRET_KEY 等

# 3. 初始化数据库（首次，PostgreSQL）
#    先创建数据库：CREATE DATABASE spider_xhs WITH ENCODING 'UTF8' TEMPLATE template0
npx prisma generate
npx prisma db push

# 4. 启动
npm run dev            # 开发（http://localhost:3000）
npm run worker         # 调度 worker（另开终端）
```

生产部署：`npm run build && npm start`，或用 Docker（`docker compose up -d`，app + worker 双服务）。

## 环境变量

| 变量                         | 默认                                                        | 说明                                          |
| ---------------------------- | ----------------------------------------------------------- | --------------------------------------------- |
| `DATABASE_URL`               | `postgresql://postgres:change_me@localhost:5432/spider_xhs` | PostgreSQL 连接串（需先建库，见快速开始）     |
| `SECRET_KEY`                 | `dev-only-change-me`                                        | JWT 签名密钥（生产必须改）                    |
| `FERNET_KEY`                 | 空                                                          | Fernet 加密密钥（空则从 SECRET_KEY 派生）     |
| `SCHEDULER_INTERVAL_SECONDS` | 60                                                          | worker 定时发布/监控刷新周期                  |
| `COOKIE_HEALTH_CHECK_HOURS`  | 2                                                           | worker Cookie 健康巡检周期                    |
| `CURL_IMPERSONATE_BIN`       | 空                                                          | curl-impersonate 二进制路径（PoC 必需，见下） |

## 真实环境验证（PoC 清单）

签名算法 JS 文件已随项目携带（`src/lib/server/xhs/js/`），本地签名（b1 / X-s / X-S-Common）无需网络。真实请求需要：

1. 安装 [curl-impersonate](https://github.com/lwthiker/curl-impersonate)（chrome146 档）并设置 `CURL_IMPERSONATE_BIN`；未安装时自动降级为 Node fetch（签名不受影响，但 TLS 指纹保真度需验证）
2. 绑定账号（QR / Cookie 导入）后测试真实搜索与发布

## 测试

```bash
npm test   # vitest：安全兼容（JWT/Fernet/密码与 Python 版交叉验证）+ 签名一致性
```
