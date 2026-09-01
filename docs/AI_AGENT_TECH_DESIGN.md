# 小红书 AI Agent 智能运营平台 — 可行性分析与技术实现方案

> 对应产品文档：`docs/AI_Agent_PRD.md`（V1.0）
> 基于当前代码库（Next.js 15 + TypeScript + Prisma + PostgreSQL，xhs-assistant 重构版）逐模块对照编写。
> 编写日期：2026-09-01

---

## 一、可行性结论

**结论：整体可行，核心链路已具备约 60% 的基础能力，建议按「增强复用 + 新增模块」分阶段实施。**

判定依据（决定性事实）：

1. **基础设施完备**：认证（JWT）、多账号体系（PC/Creator 双端）、XHS 逆向 SDK（签名/登录/搜索/详情/评论/上传/发布）、AI 文本与图片生成（OpenAI 兼容多模型）、任务调度（独立 worker 进程）、19 张表 111 个 API 端点——PRD 要求的「策-采-编-发-复盘」链路中，**采**（抓取）、**编**（AI 生成）、**发**（发布）均已可用。
2. **发布链路已验证**：Creator 上传（uploadMedia + postNote）+ 定时发布（worker 60s 扫描）+ 多账号隔离均已实现，D-02 一键发布只需补「显式批准」环节。
3. **已有最简 Agent 雏形**：`auto_tasks` 自动运营管线（搜索→选最佳→建草稿→AI 改写→发布）就是一条可运行的 Agent 工作流，编排模式可复用。
4. **AI 能力底座**：`OpenAICompatibleTextClient / OpenAICompatibleImageClient` 支持任意 OpenAI 兼容模型（文本 128K 上下文、图生图、图描述），满足 S-05 多模型选型。

**需要新增的核心模块（均为纯业务代码，无技术攻关项）**：

| 缺口 | 对应 PRD | 工作量 |
| ---- | -------- | ------ |
| 知识库（账号定位/口吻/可信主张/Few-shot） | S-02、C-07、P-03 | 中 |
| 审校引擎（规则库+LLM 双层+三道门禁） | R-01~R-06 | 中 |
| 全站热点采集与榜单 | P-01 | 中 |
| 爆款拆解 / 选题推荐 | P-02、P-03 | 中 |
| 智能排期推荐 | D-01 | 小 |
| 评论自动响应 | D-05 | 中 |
| 工作流编排（可视化） | S-04 | 大（建议后置） |

**不采纳的外部依赖**（PRD 附录建议，但与现有架构冲突或风险高）：

- **LangChain / AutoGen**：现有代码为自研轻量服务编排（fetch + 服务函数 + Task 表自引用），引入 LangChain 会破坏代码风格一致性，且对 XHS 逆向场景无增益。Agent 层用「编排函数 + LLM 工具调用」自研实现，复杂度可控。
- **Milvus / Pinecone 向量库**：PostgreSQL 原生 `pgvector` 扩展即可满足知识库检索（Phase 1 甚至只需结构化 JSON + Few-shot，无需向量）。
- **Celery / RabbitMQ**：现有 worker 进程（node-cron + 互斥锁）已承担调度，PRD 任务吞吐 100 个/小时远低于其能力上限。
- **小红书开放平台 API**：开放平台需企业资质，现有项目走逆向 SDK 路线（curl-impersonate TLS 指纹），发布与数据获取均依赖此路线，**不引入官方 API 依赖**（详见 §11 风险 1）。

---

## 二、现状能力盘点（逐模块对照）

### 2.1 策划工作台（热点洞察 Agent）

| PRD 功能 | 现有能力 | 差距 | 方案 |
| -------- | -------- | ---- | ---- |
| P-01 热点榜单 | `hot-topics` API 存在，但仅统计**本地已抓笔记库**的标签频次，非全站热点 | 无全站数据源 | 新增定时热点采集（§5.1）：PC 搜索热词 + 发现页推荐流，30 分钟周期，热度分公式落地 |
| P-02 爆款拆解 | 搜索（`searchNote`）、笔记详情抓取均已具备 | 无拆解编排 | 新增分析管线：搜索低粉高互动笔记→详情→LLM 结构化拆解（标题/封面/正文/互动引导） |
| P-03 选题推荐 | LLM 生成能力具备 | 无知识库上下文 | 知识库（§5.6）+ 热点榜单 + 爆款结构 → LLM 生成选题列表 |
| P-04 竞品监控 | `monitoring_targets`（note/账号/关键词三类）+ 60s 刷新 + 快照表**已完整具备** | 无 | **直接复用**，仅需补前端展示 |
| P-05 趋势预测 | 监控快照 + 笔记历史数据可积累 | 无预测逻辑 | 规则版（移动平均/环比）先行，LLM 解读，P2 后置 |

### 2.2 创作工作台（内容创作 Agent）

| PRD 功能 | 现有能力 | 差距 | 方案 |
| -------- | -------- | ---- | ---- |
| C-01 文案生成 | `generate-note` / `generate-title` / `generate-tags` 三个 API 已有 | 无 CTA、结构化「文案包」输出 | 扩展为单一「文案包」接口（标题 3-5 备选+正文+标签+CTA），结构化 JSON 输出 |
| C-02 去AI味改写 | `polish-text` / `rewrite-note` 已有 | 无强度分级、无前后对比 | 增加 intensity 参数（轻度/中度/深度），返回原文本+改写文本 |
| C-03 封面图生成 | `images/generate-cover` 已有（支持参考图） | 需验证 3:4 尺寸与模板库 | 新增封面模板定义（对比型/清单型/人物型/纯文型），prompt 工程化 |
| C-04 配图生成 | `images/generate` 已有 | 无 | 直接复用 |
| C-05 视频脚本生成 | 无 | 需新增 | 纯 LLM 提示词功能，新增 prompt 即可 |
| C-07 风格模仿 | 无 | 需新增 | 知识库历史笔记 Few-shot + 风格分析报告（§5.2） |

### 2.3 审校工作台（合规审校 Agent）— **全部缺失，P0 核心新增**

| PRD 功能 | 现状 | 方案 |
| -------- | ---- | ---- |
| R-01 双重预审 | 无 | 规则层（可配置规则库：敏感词/绝对化用语/功效宣称/诱导行为）+ LLM 语义层（§5.3） |
| R-02 合规检查 | 无 | 规则库 + LLM，检测维度按 PRD 六类落地 |
| R-03 声明验证 | 无 | LLM 提取功效声明/数据引用 → 校验是否有来源支撑 |
| R-04 原创性检查 | `notes` 表已存全量抓取笔记 | 与本地笔记库比对：关键词 Jaccard 粗筛 + LLM 判定（Phase 2 可升级 pgvector 向量相似度） |
| R-05 梯度修复 | 无 | LLM 按梯度（披露→证据→收窄断言→最小改写→删除）修复并复检 |
| R-06 三道门禁 | 无 | 发布前串行检查编排（§5.3），任一不通过阻断发布 |

### 2.4 发布工作台（发布运营 Agent）

| PRD 功能 | 现有能力 | 差距 | 方案 |
| -------- | -------- | ---- | ---- |
| D-01 智能排期 | `publish_jobs` 含 scheduledAt/publishedAt，笔记互动数据可统计 | 无推荐算法 | 规则版推荐（§5.4）：按账号历史互动高峰时段 + PRD 约束（每日≤3 条/同类目间隔≥2h/库存缓冲） |
| D-02 一键发布 | **完整链路已具备**：Creator 上传+发布、扫码登录（QR 轮询）、草稿发送 `send-to-publish`、发布任务取消/重试 | 无「显式批准」环节 | 发布流增加 pending_approval 状态：草稿预览→人工确认→执行 |
| D-03 账号管理 | `platform_accounts` 多账号 + 健康巡检（2h）+ Cookie 版本管理**已具备** | 无 | 直接复用 |
| D-04 内容库存管理 | `ai_drafts` 草稿体系已具备 | 无库存缓冲概念 | 排期器自动控制库存水位（≥3 条待发布），低水位提醒 |
| D-05 评论自动响应 | **PC 接口 `comment/post` 已存在**，评论抓取已具备 | 无意图识别与回复编排 | 意图分类（询问/好评/差评/广告）→ 知识库匹配 → LLM 生成 → 人工规则审核 → 回复（§5.5） |
| D-06 私信自动回复 | 无接口 | 接口不存在 | **暂缓**（P2，平台高风险，见 §11 风险 4） |

### 2.5 数据看板（数据分析 Agent）

| PRD 功能 | 现有能力 | 差距 | 方案 |
| -------- | -------- | ---- | ---- |
| A-01 数据同步 | 笔记详情抓取含互动数据、监控快照、`analytics/overview` 等 8 组分析 API 已具备 | 无定时自动同步 | 新增 worker 任务：定时抓取已发布笔记详情更新互动指标（沿用监控刷新模式） |
| A-02 效果归因 | `analytics/engagement`、`top-content`、`benchmarks` 已提供数据基础 | 无归因报告 | LLM 归因分析（标题/封面/时间/标签维度），数据来自现有分析 API |
| A-03 账号健康诊断 | Cookie 健康巡检已有 | 无账号权重估算 | 规则打分（互动率/粉丝增长/发布稳定性）+ LLM 解读 |
| A-04 复盘报告 | `analytics/reports` 已存在 | 需确认周报形态 | 扩展为 LLM 生成周报/月报 |
| A-05 A/B 实验 | 无 | P2 | 后置（需发布两个变体+数据对照） |
| A-06 闭环学习 | 无 | 无知识写回通道 | 归因结论结构化写入知识库「经验结论」字段，生成时自动注入提示词（§5.6） |

### 2.6 系统管理

| PRD 功能 | 现有能力 | 差距 | 方案 |
| -------- | -------- | ---- | ---- |
| S-01 账号权限 | 单 User 表 + JWT | 无角色/权限 | 新增 `role` 字段（admin/user 两级，见 §12 决策 5），中间件级校验，工作量小 |
| S-02 知识库 | **完全缺失** | 核心新增 | 新表 + 管理 API（§5.6） |
| S-03 技能库 | 无 | P1 | `skill_registry` 表 + 注册/调用 API（Phase 3） |
| S-04 工作流编排 | Task 表已支持 parent_task_id 子任务（DAG 基础） | 无可视化编排 | Phase 3：`workflow_defs` JSON 定义 + 执行引擎；先固化 3 条预置工作流为代码 |
| S-05 模型配置 | `model_configs` + 默认模型 + 连通测试**已具备** | 无 | 直接复用 |
| S-06 用量监控 | `api_logs` 记录 API 调用 | 无 Token/成本统计 | AI 调用处补记 token 用量（新增 `api_usage_logs` 或扩展 api_logs.meta） |
| S-07 操作日志 | `api_logs` 部分覆盖 | 无业务操作审计 | 审校/发布/知识库变更处写业务日志（复用 Notification/ApiLog 模式） |

---

## 三、总体架构设计

```
┌──────────────────────────────────────────────────────────────────────┐
│                          前端应用层（新增 5 个工作台）                  │
│  策划工作台 · 创作工作台 · 审校工作台 · 发布工作台 · 数据看板            │
│  （复用现有 AppShell / antd / axios 模式）                             │
├──────────────────────────────────────────────────────────────────────┤
│                          Agent 编排层（新增）                          │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ AgentRuntime：编排函数 + LLM 工具调用（ReAct 轻量实现）          │  │
│  │ 热点洞察Agent │ 内容创作Agent │ 合规审校Agent │ 发布运营Agent    │  │
│  │ 数据分析Agent │ 预置工作流（标准生产流/热点追更流/批量生产流）    │  │
│  └────────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────────┤
│                          能力层（Skill）                              │
│  │ 文案包生成 │ 去AI味 │ 封面生成 │ 合规检查 │ 声明验证 │ 原创性检查 │  │
│  │ 梯度修复 │ 排期推荐 │ 热点采集 │ 爆款拆解 │ 选题生成 │ 评论响应 │   │
│  └────────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────────┤
│                       现有基础设施（复用，不重构）                      │
│  │ XHS SDK（PC/Creator 签名+登录+抓取+发布） │ AI 服务（文本/图片）  │
│  │ 任务系统（Task 表 DAG） │ worker 调度（node-cron） │ 存储（PG）   │
│  │ 文件服务（sharp 媒体处理） │ 通知系统 │ 限流器（5 次/分/账号）      │
└──────────────────────────────────────────────────────────────────────┘
```

**设计原则**：

1. **复用优先**：一切与 XHS 平台的交互走现有 SDK（签名/限流/TLS 指纹/账号隔离），Agent 层只编排不重造传输。
2. **Agent 轻量自研**：Agent 本质 = 现有服务函数 + 结构化 LLM 调用。统一封装 `AgentRuntime`（工具注册表 + 任务状态机），工具即现有 service 函数。
3. **状态持久化**：所有 Agent 任务落 `tasks` 表（复用 parent_task_id 表达多步管线），前端轮询进度（与现有 SSE/轮询模式一致）。
4. **人工兜底**：发布、自动回复、梯度修复均为「建议+人工确认」模式（Human-in-the-Loop），不无条件自动执行。

---

## 四、数据模型扩展（新增 12 张表）

> 命名与现有 Prisma schema 风格一致（snake_case 映射、@map 注明、Asia/Shanghai naive datetime）。

### 4.1 知识库

```prisma
// 账号知识库（S-02）：定位/口吻/可信主张/边界/视觉身份/经验结论
model KnowledgeBase {
  id             Int    @id @default(autoincrement())
  userId         Int    @map("user_id")
  platformAccountId Int @map("platform_account_id")
  positioning    String @default("")    // 账号定位（一句话）
  toneStyle      String @map("tone_style") @default("")   // 口吻：亲切/专业/幽默/温暖
  credibleClaims String @map("credible_claims") @default("{}")  // 可信主张 JSON 数组
  contentBoundary String @map("content_boundary") @default("")  // 内容边界
  visualIdentity String @map("visual_identity") @default("{}")  // 视觉身份 JSON（品牌色/字体/封面风格）
  lessonsLearned Json? @map("lessons_learned")           // 闭环学习结论（A-06 写回）
  updatedAt      DateTime @map("updated_at")

  @@index([userId])
  @@map("knowledge_bases")
}

// 历史优质笔记（Few-shot 样本，C-07 风格模仿）
model FewShotNote {
  id                Int    @id @default(autoincrement())
  knowledgeBaseId   Int    @map("knowledge_base_id")
  noteId            Int?   @map("note_id")     // 关联 notes 表（可选）
  title             String @default("")
  body              String @default("")
  styleAnalysis     String @map("style_analysis") @default("")  // LLM 风格拆解：句式/用词/情绪基调
  sortOrder         Int    @map("sort_order") @default(0)
  createdAt         DateTime @map("created_at")

  @@index([knowledgeBaseId])
  @@map("few_shot_notes")
}
```

### 4.2 审校（R-01~R-06）

```prisma
// 审校任务（一条待审内容 = 一个任务）
model ReviewJob {
  id            Int    @id @default(autoincrement())
  userId        Int    @map("user_id")
  sourceDraftId Int?   @map("source_draft_id")   // 关联 ai_drafts
  title         String @default("")
  body          String @default("")
  status        String @default("pending")       // pending/passed/warning/rejected/fixed
  riskCount     Int    @map("risk_count") @default(0)
  createdAt     DateTime @map("created_at")
  updatedAt     DateTime @map("updated_at")

  findings ReviewFinding[]
  @@index([userId])
  @@map("review_jobs")
}

// 审校发现的风险点
model ReviewFinding {
  id          Int    @id @default(autoincrement())
  reviewJobId Int    @map("review_job_id")
  gate        String @default("compliance")      // 门禁：claim/originality/compliance
  riskType    String @map("risk_type")           // absolute_claim/medical_claim/fake_data/sensitive_word/inducement/copyright/duplicate
  riskLevel   String @map("risk_level") @default("warning")  // warning/error
  snippet     String @default("")                // 命中的原文片段
  suggestion  String @default("")                // 修复建议
  fixed       Boolean @default(false)
  fixAction   String @map("fix_action") @default("")   // 梯度动作：disclose/evidence/narrow/rewrite/remove
  fixedText   String @map("fixed_text") @default("")   // 修复后文本

  reviewJob ReviewJob @relation(fields: [reviewJobId], references: [id])
  @@index([reviewJobId])
  @@map("review_findings")
}

// 合规规则库（R-02 规则层，可后台配置）
model ComplianceRule {
  id         Int    @id @default(autoincrement())
  userId     Int    @map("user_id")
  ruleType   String @map("rule_type")    // sensitive_word/absolute_claim/medical_claim/inducement/fake_data_pattern
  pattern    String @default("")         // 关键词或正则
  isRegex    Boolean @map("is_regex") @default(false)
  riskLevel  String @map("risk_level") @default("warning")
  enabled    Boolean @default(true)
  createdAt  DateTime @map("created_at")

  @@index([userId])
  @@map("compliance_rules")
}
```

### 4.3 热点洞察（P-01/P-02/P-03）

```prisma
// 全站热点快照（每 30 分钟一条批次）
model HotTopic {
  id          Int    @id @default(autoincrement())
  userId      Int    @map("user_id")
  keyword     String @default("")
  category    String @default("")        // 美妆/穿搭/美食/旅行/家居/知识…
  heatScore   Int    @map("heat_score") @default(0)     // 热度分 = 搜索量×0.3+笔记增量×0.3+互动增量×0.4
  searchCount Int    @map("search_count") @default(0)   // 搜索结果数（近似搜索量）
  riseSpeed   Int    @map("rise_speed") @default(0)     // 环比上升百分比
  noteDelta   Int    @map("note_delta") @default(0)     // 笔记增量
  interactDelta Int  @map("interact_delta") @default(0) // 互动增量
  rank        Int    @default(0)         // 榜单名次（TOP50）
  snapAt      DateTime @map("snap_at")   // 批次时间

  @@index([userId, snapAt])
  @@map("hot_topics")
}

// 爆款拆解报告（P-02）
model ExplosionReport {
  id            Int    @id @default(autoincrement())
  userId        Int    @map("user_id")
  keyword       String @default("")
  rangeDays     Int    @map("range_days") @default(7)
  titlePatterns Json?  @map("title_patterns")    // 标题公式
  coverPatterns Json?  @map("cover_patterns")    // 封面要素
  bodyPatterns  Json?  @map("body_patterns")     // 正文框架
  engagePatterns Json? @map("engage_patterns")   // 互动引导
  sampleNotes   Json?  @map("sample_notes")      // 分析样本
  createdAt     DateTime @map("created_at")

  @@index([userId])
  @@map("explosion_reports")
}

// 选题（P-03）
model TopicSuggestion {
  id        Int    @id @default(autoincrement())
  userId    Int    @map("user_id")
  title     String @default("")
  direction String @default("")        // 内容方向
  predictedHeat Int @map("predicted_heat") @default(0)  // 预估热度
  tags      Json?                      // 关联话题标签
  source    String @default("")        // 生成依据：热点/爆款/知识库组合
  status    String @default("open")    // open/accepted/expired
  createdAt DateTime @map("created_at")

  @@index([userId])
  @@map("topic_suggestions")
}
```

### 4.4 排期与评论回复（D-01/D-05）

```prisma
// 智能排期推荐（D-01，每次生成一批）
model ScheduleSuggestion {
  id          Int    @id @default(autoincrement())
  userId      Int    @map("user_id")
  platformAccountId Int @map("platform_account_id")
  draftId     Int?   @map("draft_id")
  suggestedAt DateTime? @map("suggested_at")
  reason      String @default("")      // 推荐依据（时段统计/规则）
  accepted    Boolean @default(false)
  createdAt   DateTime @map("created_at")

  @@index([userId])
  @@map("schedule_suggestions")
}

// 评论自动回复（D-05）
model CommentReplyRule {
  id        Int    @id @default(autoincrement())
  userId    Int    @map("user_id")
  intent    String @default("question")  // question/praise/complaint/ad/other
  keywords  Json?                        // 触发关键词
  replyTemplate String @map("reply_template") @default("")  // 回复模板（可含变量）
  enabled   Boolean @default(true)
  createdAt DateTime @map("created_at")

  @@index([userId])
  @@map("comment_reply_rules")
}

model CommentReply {
  id         Int     @id @default(autoincrement())
  userId     Int     @map("user_id")
  noteId     Int     @map("note_id")
  commentId  String  @map("comment_id")
  intent     String  @default("other")
  replyContent String @map("reply_content") @default("")
  status     String  @default("pending")   // pending（待人工确认）/published/skipped
  createdAt  DateTime @map("created_at")

  @@index([userId])
  @@map("comment_replies")
}
```

### 4.5 工作流与用量（S-03/S-04/S-06，Phase 3）

```prisma
// 技能注册表
model SkillRegistry {
  id          Int    @id @default(autoincrement())
  userId      Int    @map("user_id")
  skillKey    String @map("skill_key") @unique   // 如 "content.copywriting"
  name        String @default("")
  description String @default("")
  paramsSchema Json? @map("params_schema")       // JSON Schema
  enabled     Boolean @default(true)
  createdAt   DateTime @map("created_at")
}

// 工作流定义（JSON 配置化）
model WorkflowDef {
  id        Int    @id @default(autoincrement())
  userId    Int    @map("user_id")
  name      String @default("")
  nodes     Json?  // [{id, skillKey, params, next}]
  enabled   Boolean @default(true)
  createdAt DateTime @map("created_at")
  @@index([userId])
}

// AI 用量统计
model ApiUsageLog {
  id        Int      @id @default(autoincrement())
  userId    Int      @map("user_id")
  modelConfigId Int? @map("model_config_id")
  modelName String   @map("model_name") @default("")
  usageType String   @map("usage_type") @default("text")  // text/image/embedding
  promptTokens   Int @map("prompt_tokens") @default(0)
  completionTokens Int @map("completion_tokens") @default(0)
  costCents Int     @map("cost_cents") @default(0)
  latencyMs Int     @map("latency_ms") @default(0)
  createdAt DateTime @map("created_at")
  @@index([userId, createdAt])
  @@map("api_usage_logs")
}
```

---

## 五、核心模块设计

### 5.1 热点洞察（P-01）

**数据源**（现有 SDK 能力内，无新逆向）：

- **搜索热词**：定时用 PC 搜索接口跑一组种子词（账号历史关键词 + 分类种子词），取搜索结果数（近似搜索量）与 Top 笔记互动数。
- **发现页推荐流**：PC 发现页接口抓取当前推荐流标题，词频统计增量话题。
- **增量计算**：与上一批次（30 分钟前）对比得出笔记增量/互动增量/上升速度。

**热度分**（按 PRD 公式落地）：`heatScore = searchCount×0.3 + noteDelta×0.3 + interactDelta×0.4`，榜单保留 TOP50。

**worker 新增任务**：

```
hot_topics_runner：node-cron */30 分钟，互斥锁防重叠（沿用现有 Mutex 模式）
→ 对每个已配置账号：跑种子词搜索（限流器内）→ 计算热度分 → 批量写入 hot_topics（snapAt=本批）
→ 清理 7 天前快照
```

**API**：`GET /api/xhs/analytics/hot-topics?category=&limit=`（改造现有接口，增加全站榜单来源；本地库统计保留为二级数据）。

### 5.2 内容创作（C-01/C-02/C-07）

**C-01 文案包**：新增 `POST /api/ai/generate-note-pack`，一次调用返回：

```json
{
  "titles": ["标题1", "标题2", "标题3"],
  "body": "正文（300-800字）",
  "tags": ["#秋冬穿搭"],
  "cta": ["关注我解锁更多穿搭技巧"]
}
```

实现：复用 `OpenAICompatibleTextClient.complete`，系统提示词注入知识库上下文（定位/口吻/可信主张/Few-shot 风格样本），要求输出 JSON（LLM 输出 JSON 失败时降级为现有非结构化解析）。写入 `ai_drafts` 草稿。

**C-02 去AI味**：`POST /api/ai/rewrite-note` 增加 `intensity: "light"|"medium"|"deep"`，返回 `{ original, rewritten, changes: [...] }`。改写规则（模板化开头删除、第一人称、口语化、去结构化连接词）写进系统提示词。

**C-07 风格模仿**：

```
首次配置：用户上传 ≥5 篇历史笔记（可勾选库内已抓笔记）
→ LLM 逐个分析（句式/用词偏好/情绪基调/常用开头结尾）→ 汇总为 styleAnalysis 存入 FewShotNote
→ 生成时从知识库取 2-3 篇样本拼入系统提示词（Few-shot）
```

**API**：`POST /api/knowledge-base/few-shot/analyze`、`POST /api/knowledge-base/few-shot`（增删）。

### 5.3 审校引擎与三道门禁（R-01~R-06）

**双层结构**：

```
第一层（规则，快）：compliance_rules 规则库（敏感词/绝对化/功效词/诱导词）
  → 命中即生成 ReviewFinding（riskLevel 按规则配置）
第二层（LLM，深）：系统提示词含小红书社区规范要点 + 六类检测维度
  → LLM 输出 JSON 风险点数组 → 落 ReviewFinding
```

**三道门禁**（发布前串行，`POST /api/review/gates`）：

| 门禁 | 实现 |
| ---- | ---- |
| ① 声明验证 | LLM 提取功效声明/数据引用 → 校验知识库可信主张与原文支撑；无来源 → finding(claim, warning) |
| ② 原创性检查 | 与 notes 库同关键词 Top 笔记比对：关键词 Jaccard 相似度 > 阈值（先 0.3）→ LLM 判定；Phase 2 升级 pgvector |
| ③ 合规检查 | §双层全量扫描；有 error 级 finding → 阻断 |

**R-05 梯度修复**：`POST /api/review/:jobId/auto-fix`，按 finding 顺序执行梯度（披露→证据→收窄断言→最小改写→删除/暂缓），每步 LLM 改写后**自动复检**，复检不通过进入下一步梯度；结果可人工确认（Human-in-the-Loop）。

**发布联动**：`publish_jobs` 新增 `gateStatus: "pending"|"passed"|"blocked"` 字段，三道门禁通过才允许 `publish` 端点执行；`send-to-publish` 流程前置审校。

### 5.4 发布运营（D-01/D-02）

**D-01 智能排期**（规则版，Phase 2 可加 LLM 解读）：

```
输入：账号历史 publish_jobs（publishedAt）+ 对应笔记互动数据
算法：按小时聚合互动均值 → 取 Top 时段 → 过滤已占用时段
约束：每日≤3 条 / 同类目间隔≥2h / 库存缓冲≥3 条（不足则提醒补产）
输出：ScheduleSuggestion 列表 + reason 说明
```

**API**：`POST /api/publish/schedules/recommend`、`GET /api/publish/schedules`。

**D-02 发布批准流**：`publish_jobs.status` 增加 `pending_approval`：定时发布到点先置为 `pending_approval` 并生成通知，用户确认（`POST /api/publish/jobs/:jobId/approve`）后由 worker 执行；支持 `auto_approve` 配置项（信任用户可开启）。

### 5.5 评论自动响应（D-05）

```
新评论到达（worker 60s 轮询已发布笔记评论，复用 comment 抓取）
→ LLM 意图分类（question/praise/complaint/ad/other）
→ 匹配 comment_reply_rules（关键词优先，LLM 模板兜底）
→ 生成回复 → 状态 pending（人工审核队列，可一键放行/跳过）
→ 人工确认后调 PC 接口 comment/post 发出（限流器 5 次/分/账号内）
```

**API**：`GET /api/xhs/comments/replies`（审核队列）、`POST /api/xhs/comments/replies/:id/approve`。

### 5.6 知识库与闭环学习（S-02/A-06）

**知识库管理 API**（REST）：

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET/PUT | `/api/knowledge-base` | 查询/更新知识库配置 |
| GET/POST/DELETE | `/api/knowledge-base/few-shot` | Few-shot 样本管理 |
| POST | `/api/knowledge-base/few-shot/analyze` | LLM 风格分析 |
| POST | `/api/knowledge-base/lessons` | 写入闭环学习结论 |

**生成时上下文装配**（`buildKbContext()` 服务函数，被所有生成类 Skill 调用）：

```
系统提示词 = 通用角色 + 账号定位 + 口吻风格 + 可信主张 + 内容边界 + 经验结论 + Few-shot 样本(≤3篇)
```

**A-06 闭环学习**：归因分析（A-02）输出结构化结论（如「标题带数字→点击率↑40%」）→ 用户点「写入知识库」→ 追加到 `knowledge_bases.lessons_learned` → 后续生成自动注入。

### 5.7 Agent 编排层（核心抽象）

```typescript
// src/lib/server/agent/runtime.ts（新增目录）
// 工具注册：把现有服务函数包装为 Agent 可调用工具
interface AgentTool {
  key: string;              // "content.generateNotePack"
  description: string;
  paramsSchema: object;     // zod schema
  execute(params): Promise<unknown>;
}

// 编排器：串行/条件执行工具，任务状态落 tasks 表（parent_task_id 表达步骤）
// 预置工作流（代码实现，Phase 3 转 workflow_defs JSON）：
//   标准生产流：选题→文案→审校→封面→排期→发布
//   热点追更流：热点→选题→快速产出→审校→发布
//   批量生产流：批量选题→批量文案→批量审校→批量排期
```

**新增目录结构**：

```
src/lib/server/agent/
  runtime.ts        // AgentRuntime（工具注册/执行/任务落库）
  tools.ts          // 工具定义（引用现有 service）
  workflows.ts      // 3 条预置工作流
src/lib/server/services/
  knowledge-base-service.ts   // 知识库装配/检索
  review-service.ts           // 审校引擎
  hot-topic-service.ts        // 热点采集与榜单
  exploration-service.ts      // 爆款拆解
  suggestion-service.ts       // 选题推荐
  schedule-service.ts         // 智能排期
  comment-reply-service.ts    // 评论响应
```

---

## 六、新增 API 清单（约 30 个端点）

| 分组 | 端点 |
| ---- | ---- |
| 知识库 | `GET/PUT /api/knowledge-base`、`GET/POST/DELETE /api/knowledge-base/few-shot`、`POST /api/knowledge-base/few-shot/analyze`、`POST /api/knowledge-base/lessons` |
| 审校 | `POST /api/review`（提交=双层检测+三道门禁，已实现）、`GET /api/review/:jobId`、`GET /api/review`（队列）、`POST /api/review/:jobId/auto-fix`、`POST /api/review/batch`、`CRUD /api/compliance-rules`（均已实现，详见 §12.5） |
| 热点 | `GET /api/xhs/analytics/hot-topics`（改造）、`GET /api/xhs/analytics/hot-topics/history`、`POST /api/xhs/analytics/explosions`、`GET /api/xhs/analytics/explosions/:id`、`POST /api/xhs/analytics/suggestions`、`GET /api/xhs/analytics/suggestions` |
| 创作 | `POST /api/ai/generate-note-pack`、`POST /api/ai/generate-script`（视频脚本）、`POST /api/ai/rewrite-note`（加 intensity，改造） |
| 发布 | `POST /api/publish/schedules/recommend`、`GET /api/publish/schedules`、`POST /api/publish/jobs/:jobId/approve`、`GET /api/publish/jobs/:jobId/gate-status` |
| 评论 | `GET /api/xhs/comments/replies`、`POST /api/xhs/comments/replies/:id/approve`、`CRUD /api/xhs/comments/reply-rules` |
| 工作流（P3） | `CRUD /api/workflows`、`POST /api/workflows/:id/run`、`GET /api/skills` |
| 用量（P3） | `GET /api/usage/summary` |

全部遵循现有 `handle()` 路由封装 + `getCurrentUser` 鉴权 + zod 校验模式（`src/lib/server/core/route.ts`）。

---

## 七、前端改造（新增 5 个工作台页面）

| 页面 | 路由（app/(protected)/platforms/xhs/ 下） | 要点 |
| ---- | ---- | ---- |
| 策划工作台 | `planner/` | 热点榜单卡片（复用 recharts 趋势图）、爆款拆解报告、选题卡片（一键入生产队列） |
| 创作工作台 | `studio/` | 文案包编辑（标题多选/正文/标签/CTA）、去AI味对比、封面/配图/脚本 Tab |
| 审校工作台 | `review/` | 待审队列（antd Table + Tag 状态）、审校报告（风险点列表+一键修复）、规则库管理 |
| 发布工作台 | 改造 `publish/` | 账号卡片（复用现有）、排期日历（antd Calendar）、待批准队列 |
| 数据看板 | 改造 `analytics/` + 新增 `analytics/attribution` | 归因报告、周报生成、闭环学习写入按钮 |
| 知识库管理 | 改造 `settings/` | 定位/口吻/可信主张/边界/视觉身份表单、Few-shot 上传 |

前端沿用现有 `useState/useEffect + axios 拦截器` 模式，不引入新状态库（与 REWRITE_PLAN 决策 4 一致）。

---

## 八、worker 新增调度任务

| 任务 | 周期 | 说明 |
| ---- | ---- | ---- |
| hot_topics_runner | 30 分钟 | 热点采集与榜单计算（§5.1） |
| analytics_sync_runner | 2 小时 | 已发布笔记互动数据同步（A-01） |
| comment_reply_runner | 60 秒 | 新评论检测 → 意图识别 → 回复生成（D-05） |
| publish_approval_reminder | 60 秒 | pending_approval 超时提醒（D-02） |

均沿用现有 `Mutex` + `schedule()` 模式注册（`src/worker/index.ts`）。

---

## 九、非功能需求实现

| PRD 需求 | 实现方案 |
| -------- | -------- |
| 文案生成 ≤15s / 封面 ≤30s | 现有客户端超时（60s/180s）已满足；加语义缓存（同参同 prompt 命中缓存，应对成本风险） |
| 热点榜单 ≤30 分钟 | worker 30 分钟任务，天然满足 |
| 数据同步 ≤2h | worker 2 小时任务 |
| 并发 ≥50 人 | 现有多用户架构 + PostgreSQL，无瓶颈；AI 调用限流（现有 rate-limiter 扩展） |
| 任务吞吐 ≥100/时 | worker 单次批量处理，远满足 |
| 账号 Token 加密 | 现有 Fernet 加密（`security.ts`）直接复用 |
| 操作审计 | api_logs + 关键业务写 Notification/审计记录 |
| 防注入 | zod 校验 + Prisma 参数化查询 + Next.js 默认 XSS 防护（现有） |
| 模型可插拔 | OpenAI 兼容协议（现有 model_configs）天然支持 |
| 任务断点续传 | 审校/拆解类长任务复用 tasks 表 + retryCount/maxRetries（现有） |
| 数据埋点 | AI 调用处埋 token 用量（api_usage_logs，§4.5） |

---

## 十、分阶段实施计划

> 以单人估算；每阶段结束可独立上线。

### Phase 1 — 审校闭环 MVP（对应 PRD Phase 1，约 3~4 周）

**目标：内容从生成到发布具备「人工确认」闭环，合规零发布。**

- [ ] 审校引擎：compliance_rules 规则库 + LLM 双层检测 + 三道门禁（R-01/R-02/R-03/R-04/R-06 规则版）
- [ ] R-05 梯度修复 + 复检
- [ ] 文案包扩展（C-01 结构化输出）+ 去AI味强度分级（C-02）
- [ ] 发布批准流（D-02 pending_approval）+ 审校工作台前端
- [ ] 知识库基础表 + 管理页（S-02 定位/口吻/可信主张）
- [ ] 测试：审校规则单测 + 三道门禁流程测试

**验收**：生成文案 → 审校报告正确命中六类风险 → 阻断/修复 → 人工批准发布全链路可用。

### Phase 2 — 洞察与创作增强（对应 PRD Phase 2，约 4~5 周）

- [ ] 热点采集 runner + 榜单 API/页面（P-01）
- [ ] 爆款拆解管线（P-02）+ 选题推荐（P-03）
- [ ] 风格模仿 Few-shot（C-07）+ 封面模板库（C-03）
- [ ] 智能排期规则版（D-01）+ 排期日历前端
- [ ] 数据分析：归因报告（A-02）+ 周报（A-04）+ 闭环学习（A-06）
- [ ] 知识库 RAG 升级（pgvector，原创性检查同用）

**验收**：热点榜单 30 分钟更新；爆款拆解报告结构化可用；排期推荐命中账号高峰时段。

### Phase 3 — 自动运营增强（对应 PRD Phase 3，约 4~5 周）

- [ ] 评论自动响应（D-05）：意图识别 + 审核队列 + 回复
- [ ] 工作流编排：workflow_defs + 3 条预置工作流可视化执行（S-04）
- [ ] 技能库管理（S-03）+ 视频脚本生成（C-05）
- [ ] 角色权限（S-01 admin/user 两级）+ 用量监控（S-06）
- [ ] 数据看板 A-03 账号健康诊断

### Phase 4 — 高级能力（对应 PRD Phase 4，约 2~3 周，可选）

- [ ] A/B 实验（A-05）、趋势预测（P-05）
- [ ] 多模型路由优化与语义缓存（成本优化）
- [ ] 私信自动回复（D-06）——**依赖平台接口评估结果，默认不做**

**合计约 13~17 周（单人）**，其中 Phase 1 为关键路径。

---

## 十一、风险清单

| # | 风险 | 等级 | 应对 |
| --- | --- | --- | --- |
| 1 | **逆向接口合规与封号风险**：PRD 依赖「小红书开放平台 API」，但开放平台需企业资质；现有方案为逆向 SDK，全站热点采集/高频发布会放大账号风险 | **高** | 严守现有限流（5 次/分/账号）；发布频次按平台容忍度（≤3 条/日/账号）；三道门禁强制；保留手动发布通道 |
| 2 | PRD 目标矛盾：**「日均 10-30 条自动化生产与发布」vs 排期规则「同账号每日不超过 3 条」** | 高 | ✅ **已确认（2026-09-01）**：按「多账号总量 10-30 条/日、单账号 ≤3 条」口径设计（§12 决策 1） |
| 3 | 全站热点无公开数据源，搜索热词/发现页采集为近似方案，热度分与平台真实热榜有偏差 | 中 | ✅ **已确认（2026-09-01）**：采用逆向采集估算，榜单标注「估算」；保留本地库统计作为补充；架构上预留第三方数据源可替换（§12 决策 2） |
| 4 | 评论自动回复触发风控（回复频率/内容判定） | 中 | 回复全部经人工审核队列；限流器内执行；差评类只标记不自动回复 |
| 5 | 私信接口不存在，强做需逆向新接口 | 高 | ✅ **已确认（2026-09-01）**：D-06 私信自动回复从本期范围移除，不做（§12 决策 3） |
| 6 | LLM 输出 JSON 不稳定（文案包/审校报告） | 中 | zod 校验 + 失败降级为文本解析；重要字段设默认值 |
| 7 | 审校规则库初期覆盖不全 | 低 | 规则库可后台配置；LLM 层兜底；持续沉淀 |
| 8 | 向量检索（pgvector）依赖 PG 扩展 | 低 | Phase 1 不用向量；升级前验证扩展可用性 |

---

## 十二点五、Phase 1 实现记录（2026-09-01）

### 已交付（对照 §10 Phase 1 清单）

| 交付项 | 说明 | 位置 |
| --- | --- | --- |
| 数据模型扩展 | 新增 5 张表（knowledge_bases / few_shot_notes / review_jobs / review_findings / compliance_rules）+ User.role 字段 + PublishJob.gateStatus | `prisma/schema.prisma` |
| 审校引擎服务 | 双层检测（默认规则库+自定义规则 / LLM 语义层）、三道门禁、梯度修复、原创性 Jaccard 检查 | `src/lib/server/services/review-service.ts` |
| 知识库服务 | 知识库 CRUD、Few-shot 风格分析、闭环学习写回、生成上下文装配 | `src/lib/server/services/knowledge-base-service.ts` |
| AI 能力扩展 | 文案包（generateNotePack 结构化输出 + 文本降级解析）、去AI味强度分级（light/medium/deep） | `src/lib/server/services/ai-service.ts` |
| 发布批准流 | 定时发布到点 → 三道门禁 → pending_approval + 通知 → 人工批准发布；auto_approve 直发；手动发布前强制门禁检查 | `scheduler-service.ts` / `approve/route.ts` / publish 路由 |
| API 路由 | /api/review（提交/队列/详情/auto-fix/batch）、/api/compliance-rules CRUD、/api/knowledge-base（配置/Few-shot/analyze/lessons）、/api/ai/generate-note-pack、/api/publish/jobs/:id/approve | `src/app/api/` |
| 前端 | 审校工作台（待审队列/报告/一键修复/规则管理）、设置页知识库管理、发布中心待批准操作、侧边栏导航 | `platforms/xhs/review/page.tsx` 等 |
| 测试 | 36 条 vitest 单测（规则引擎/相似度/文案包解析/修复应用），全绿 | `src/lib/server/services/*.test.ts` |

### 与设计文档的偏差

1. **三道门禁端点合并**：原计划独立 `POST /api/review/gates`，实现时合并进 `POST /api/review`（一次提交即完成双层检测+三道门禁并落库），发布时的门禁检查复用 `runReview`/`ensureJobGatesPassed`，无需额外端点。
2. **auto_approve 配置**：通过 `send-to-publish` 的 publish_options.auto_approve（JSON 内字段）控制，未新增独立开关页面（发布中心前端保留"发布"按钮即直发路径）。

### 运行时验证记录（dev 环境实测）

- 违规内容审校：命中 6 个风险点（绝对化×2 / 功效宣称 error / 诱导×2 / 虚假数据）→ rejected + blocked ✓
- 自定义规则联动：新增 sensitive_word 规则后，审校正确命中 → error 级阻断 ✓
- 知识库保存与闭环学习写回正常 ✓；auto-fix 未配置模型时明确报错（设计内行为）✓
- 非法正则 400 拦截 ✓
- `next build` 全量通过，36/36 单测通过 ✓

### 遗留说明

- 测试环境遗留 `review_test` 用户及其审校/规则数据（开发库，无副作用，可手动清理）
- LLM 层（语义审校/风格分析/文案包）需配置默认文本模型后启用；规则层与原创性检查不依赖模型

## 十二点六、Phase 2 实现记录（2026-09-01）

### 已交付（对照 §10 Phase 2 清单）

| 交付项 | 说明 | 位置 |
| --- | --- | --- |
| 数据模型扩展 | 新增 4 张表（hot_topics / explosion_reports / topic_suggestions / schedule_suggestions） | `prisma/schema.prisma` |
| P-01 热点采集 | 种子词（关键词组+上期榜单）→ PC 搜索 → 热度分（PRD 公式）→ TOP50 快照落库；worker `*/30` 分钟任务；榜单/历史/手动刷新 API | `hot-topic-service.ts` + `src/app/api/hot-topics/*` + worker `hot_topics_runner` |
| P-02 爆款拆解 | 搜索低粉高互动（赞藏评>1000）→ LLM 结构化拆解（标题/封面/正文/互动引导）→ 报告落库 | `exploration-service.ts` + `src/app/api/xhs/analytics/explosions/*` |
| P-03 选题推荐 | 知识库 + 热点 TOP10 + 最新爆款结构 → LLM 选题（5/10/20 条）；采纳一键生成草稿 | `suggestion-service.ts` + `src/app/api/xhs/analytics/suggestions/*` |
| D-01 智能排期 | 历史发布时段互动统计 → 高峰时段推荐；约束：单账号 ≤3 条/日、同日间隔 ≥2h、库存缓冲 ≥3；无历史时用默认时段 [20:00, 10:00] | `schedule-service.ts` + `src/app/api/publish/schedules/*` |
| A-02/A-04/A-06 | 归因分析（高/低表现 TOP5 对比 → LLM 结论）、运营周报（LLM 叙述）、结论写入知识库（复用 Phase 1 lessons API） | `attribution-service.ts` + `analytics/attribution`、`analytics/weekly-report` |
| 前端 | 策划工作台（热点榜单/爆款拆解/选题推荐）、发布中心「推荐排期」抽屉、数据洞察「归因分析/生成周报」 | `platforms/xhs/planner/page.tsx`、publish/analytics 页改造 |
| 测试 | 新增 30 条单测（热度分/分类/排期算法/爆款解析/选题解析/归因解析），累计 66 条全绿 | `src/lib/server/services/*.test.ts` |

### 与设计文档的偏差

1. **热点刷新端点**：`POST /api/hot-topics/refresh` 独立路由（设计文档为 POST /api/hot-topics），榜单 GET 保持原路径。
2. **爆款「低粉」维度**：搜索卡片通常不含粉丝数，实现为「原始数据含粉丝数且 ≥5000 时过滤，否则仅按互动量阈值筛选」（`EXPLOSION_FOLLOWER_THRESHOLD`）。
3. **pgvector RAG 升级**：Phase 2 未实施，原创性检查与知识库检索保持关键词/Jaccard/Few-shot 方案（原设计决策 4 的 Phase 2 部分顺延，见遗留说明）。
4. **排期算法纯函数化**：`aggregateHourScores` / `pickTopHours` 独立可测，占用时段与间隔约束在函数内保证。

### 运行时验证记录（dev 环境实测）

- 热点：无 PC 账号时 `refresh` 明确报错「未绑定 PC 账号，无法采集热点」✓；GET 空榜正常 ✓
- 排期：测试账号（无历史数据）推荐 3 个槽位（今日 20:00 + 明日 10:00/20:00，同日间隔 ≥2h，缓冲 3）✓；修复了 naive datetime 解析与时区偏移、跨天占用两个 bug
- 无模型配置时爆款/选题/归因明确报错（依赖文本模型）✓
- `next build` 全量通过（113 页），66/66 单测通过 ✓

### 遗留说明

- 热点/爆款采集依赖真实 PC 账号 Cookie，测试环境未验证真实搜索（限流 5 次/分/账号由现有 SDK 保证）
- pgvector RAG 与趋势预测（P-05）未纳入本期，建议 Phase 3 前置评估 PG 扩展可用性后再实施

## 十二点七、Phase 3 实现记录（2026-09-01）

### 已交付（对照 §10 Phase 3 清单）

| 交付项 | 说明 | 位置 |
| --- | --- | --- |
| 数据模型扩展 | 新增 5 张表（comment_reply_rules / comment_replies / skill_registry / workflow_defs / api_usage_logs） | `prisma/schema.prisma` |
| D-05 评论自动响应 | **底层新增 PC 评论发布接口**（`comment/post`，RAP 白名单已内置）；管线：已发布笔记新评论检测（worker 60s）→ LLM 意图分类（question/praise/complaint/ad/other）→ 回复生成 → 人工审核队列 → approve 发布；无模型时降级关键词规则匹配；差评/广告不自动回复 | `xhs/pc/api.ts` + `comment-reply-service.ts` + `/api/xhs/comments/*` + worker `comment_reply_runner` |
| S-04 工作流编排 | 3 条预置工作流（标准生产流/热点追更流/批量生产流），步骤=技能引用（支持 `{s1.字段}` 占位符），执行复用 tasks 表父子关系（父 workflow_run + 子 step），任一步失败即终止；执行记录查询 | `workflow-service.ts` + `/api/workflows`、`/api/workflows/run`、`/api/workflows/runs` |
| S-03 技能库 | 6 个技能注册表种子（hot.refresh/topic.generate/content.notePack/review.submit/script.generate/schedule.recommend），首次访问自动初始化 | `skill_registry` + `/api/skills` |
| C-05 视频脚本 | 分镜脚本生成（开场钩子→内容展开→结尾引导） | `ai-service.generateVideoScript` + `/api/ai/generate-script` + 草稿工坊按钮 |
| S-06 用量监控 | `complete()` 增加 onUsage 回调（响应 usage 字段）→ api_usage_logs 落库；已接入全部文本 AI 调用点（审校/修复/文案包/改写/选题/爆款/归因/周报/评论/工作流/脚本）；用量汇总按模型分组 | `usage-service.ts` + `/api/usage/summary` |
| S-01 角色权限 | User.role 两级：**首位注册用户为 admin**，其余 user；`requireAdmin` 辅助（403）；/auth/me 与登录/注册响应返回 role | `auth.ts` + register/login/me 路由 |
| A-03 账号健康 | 规则打分：Cookie 40 + 发布稳定性 30（近 30 天 ≥8 条满分）+ 互动水平 30；等级 healthy/normal/attention/risk + 诊断因素 | `account-health-service.ts` + `/api/xhs/analytics/health` |
| 前端 | 评论运营页（审核队列+回复规则管理）、工作流编排页（预置流执行/结果/运行记录/技能库）、设置页（用量统计表+账号健康诊断+角色展示）、草稿工坊「生成视频脚本」、侧边栏 2 个新导航 | `platforms/xhs/comment-reply`、`workflows`、settings、drafts 改造 |
| 测试 | 新增 24 条单测（意图解析/规则匹配/模板渲染/占位符解析/健康分），累计 90 条全绿 | `src/lib/server/services/*.test.ts` |

### 与设计文档的偏差

1. **工作流执行端点**：`POST /api/workflows/run` 独立路由（设计文档为 POST /api/workflows 携带 body），GET /api/workflows 仅返回预置流列表。
2. **评论回复接口**：PC SDK 原本只有评论抓取，本次补实现 `postComment`（`/api/sns/web/v1/comment/post`，复用 RAP 签名链路），回复必须人工确认（approve）后发出。
3. **S-01 角色**：仅实现两级 + requireAdmin 辅助与响应字段暴露；未做权限面板（单人多账号场景无实际管理需求，后续需要时补）。
4. **S-06 覆盖范围**：文本类 AI 调用全部接入用量采集；图片生成（generateImage）未接入（响应 usage 字段不标准，文档标注）。

### 运行时验证记录（dev 环境实测）

- 工作流：3 条预置流 + 技能种子初始化 ✓；未知工作流 400 ✓；无模型时步骤级优雅失败（「未配置文本模型，无法生成选题」）且执行记录可查 ✓
- 评论规则 CRUD 全通 ✓；回复队列空表正常 ✓
- 账号健康：无 Cookie 测试账号 0 分/风险，因素诊断正确 ✓
- 用量汇总空表正常；/auth/me 返回 role=user ✓
- `next build` 全量通过（123 页），90/90 单测通过 ✓

### 遗留说明

- 评论自动响应真实链路（抓取→分类→回复）需绑定 PC 账号并已发布笔记后才能实测；回复频率受 SDK 限流保护
- 图片生成用量未采集（S-06 偏差 4）；pgvector RAG 与 P-05 趋势预测仍顺延（同 §12.6）

## 十二、决策记录（已确认）

| # | 决策点 | 结论 | 确认日期 |
| --- | --- | --- | --- |
| 1 | 发布频次口径 | **多账号总量 10-30 条/日，单账号 ≤3 条/日**（PRD 目标矛盾按此口径收敛） | 2026-09-01 |
| 2 | 热点数据源 | **逆向采集估算**（搜索热词+发现页，标注「估算」），预留第三方数据源可替换 | 2026-09-01 |
| 3 | 私信自动回复（D-06） | **从本期范围移除**，不逆向新接口 | 2026-09-01 |
| 4 | 知识库 RAG 时机 | **分两阶段**：Phase 1 结构化配置 + Few-shot（零依赖），Phase 2 升级 pgvector（原创性检查同步升级） | 2026-09-01 |
| 5 | 角色权限（S-01） | ✅ **已确认（2026-09-01）**：先做「管理员/普通用户」两级（User.role 字段 + 中间件校验），后续如需审核人员角色再扩展 | 2026-09-01 |
