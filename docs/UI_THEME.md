# UI 主题规范（小红书创作平台浅色风格）

> 事实源：`html/xhs.html`（小红书创作服务平台页面，`:root` CSS 变量）。
> 约定：**项目仅保留浅色主题**，暗色模式与切换功能已于 2026-08-24 删除。

## 1. XHS 色板

| 角色 | 色值 | 备注 |
|---|---|---|
| 主色 primary | `#386bff` | hover `#2859e4` / pressing `#244bbc` / disabled `#b2c8ff` |
| 主色浅底 light | `#ecf0ff` | 选中项/未读通知底（hover `#f5f7ff`） |
| 品牌红 | `#ff2442` | 通知 Badge 红点（`Badge.colorError`） |
| 成功 | `#00ab46` | 原 antd 默认绿 `#52c41a` 在图表/徽标中保留 |
| 警告 | `#fd6321` | 图表/徽标中原 `#faad14` 保留 |
| 危险 | `#fb3367` | antd error token |
| 页面底 | `#f5f5f5` | `colorBgLayout` |
| 卡片/容器 | `#ffffff` | `colorBgContainer` |
| 次级容器 | `#fafafa` | 表格头、嵌套面板、指标条 |
| 图片占位底 | `#f2f2f2` | 封面/素材占位 |
| 边框 | `#e8e8e8` | `colorBorder` |
| 浅边框/分割 | `#f0f0f0` | `colorBorderSecondary` / `colorSplit` |
| 虚线边框 | `#d9d9d9` | 上传占位框 |
| 主文字 | `#1a1a1a` | `colorText` |
| 次文字 | `#3d3d3d` | `colorTextSecondary` |
| 弱文字 | `#8f8f8f` | `colorTextTertiary`；图标/弱说明 |
| 占位文字 | `#bfbfbf` / `#c8c8c8` | `colorTextQuaternary` |
| 圆角 | 8 / 12(LG) / 6(SM) | 卡片主圆角 8，登录 Card 16 |

字体栈：`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif`

## 2. 组件级 Token（src/components/providers.tsx）

- `Menu`：透明底、`#3d3d3d` 文字、hover `#f5f7ff`/`#386bff`、选中 `#ecf0ff` 底 + `#386bff` 字、itemHeight 40、radius 8
- `Table`：header `#fafafa`/`#3d3d3d`、rowHover `#f5f7ff`
- `Segmented`：track `#f2f2f2`、选中白底
- `Layout`：sider/header 白、body `#f5f5f5`
- `Badge`：colorError `#ff2442`

## 3. 颜色替换映射（暗色 → 浅色，2026-08-24 迁移）

| 原暗色值 | 浅色等价 | 场景 |
|---|---|---|
| `#1f1f1f` / `#1a1a1a`（主容器） | `#ffffff` | 卡片/容器 |
| `#1a1a1a`（图片磁贴）/ `#262626`（封面占位） | `#f2f2f2` | 图片/素材占位 |
| `#262626`（文字块底）/ `#141414`（指标条） | `#fafafa` | 嵌套面板 |
| `#303030` | `#e8e8e8` | 边框 |
| `#262626`（分割线） | `#f0f0f0` | 分隔线 |
| `#434343` / `#333` / `#444`（边框） | `#d9d9d9` / `#e8e8e8` | 虚线/细边框 |
| `#0a0a0a` / `#141414`（页面底） | `#f5f5f5` | 布局底 |
| `#1668dc`（含 8 位 alpha 后缀） | `#386bff` + 同后缀 | 主色 |
| `rgba(22,104,220,…)` | `#ecf0ff` | 选中/高亮底 |
| `rgba(255,255,255,0.88)` | `#1a1a1a` | 主文字 |
| `rgba(255,255,255,0.65~0.75)` | `#3d3d3d` | 次文字 |
| `rgba(255,255,255,0.45~0.55)` | `#8f8f8f` | 弱文字 |
| `rgba(255,255,255,0.35~0.4)` | `#bfbfbf` | 占位/折叠按钮 |
| `rgba(255,255,255,0.25~0.3)` | `#c8c8c8` | 空态图标 |
| `rgba(255,255,255,0.04)` | `#fafafa` | 悬停底 |
| `rgba(0,0,0,.6)` | 保留 | 图片删除角标底 |
| `#8c8c8c` / `#555` / `#666` | `#8f8f8f` | 灰阶 |
| `#434343`（文字） | `#3d3d3d` | 灰阶文字 |
| `#1a2332` | `#ffffff` | 改写结果卡 |
| `#52c41a`/`#faad14`/`#ff4d4f`/`#eb2f96`/`#722ed1`/`#13c2c2` | 保留 | 图表/徽标语义色 |
| `#111111`（src/app/api） | 保留 | 业务数据（标签默认色），非 UI |

## 4. 编写约定

1. 存量页面沿用硬编码浅色值（如 `#e8e8e8`、`#f5f5f5`）；新代码优先复用 antd token（`theme.useToken()`），避免再引入魔法色值。
2. 语义色命名空间：卡片边框用 `#e8e8e8`，分割线用 `#f0f0f0`，图片占位用 `#f2f2f2`，嵌套面板/表格头用 `#fafafa`。
3. 暗色模式已删除（providers.tsx 无 dark token、app-shell 无切换按钮），不要恢复。
4. 滚动条、表格 hover（`#f5f7ff`）、卡片 hover 阴影等全局效果见 `src/app/globals.css`。
