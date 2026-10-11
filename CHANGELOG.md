# Changelog

本文件记录 NovaLab 的所有重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。发布前的开发历史按阶段（P1/P2/P3 波次）从 git log 手工摘要而成。

## [Unreleased] - v0.1.1

### Security

- Bridge 通道鉴权（Origin 白名单 + 启动 token 两层）：Bridge 的 loopback HTTP/WS 服务只接受本机前端 Origin（缺 Origin 也拒绝）；`GET /bridge-info` 下发每次启动随机 token，WS 首条消息必须是 `bridge.auth {token}`，LLM 代理校验同一 token。此前任意网页都能连 `ws://127.0.0.1:7788` 执行 `kernel.repl`（任意 Python）与 `fs.*`。前端与脚本经 `/bridge-info` 发现实际端口（7788–7798）。

### Privacy

- `get_cell_output` 只返回 `{traceback, mimeKeys}`：cell 的 stdout/stderr（`print(df)` 即原始数据行）与写入路径不再穿过 Agent / MCP 出口。
- 审计 chip 改为如实记账：首条消息逐段 + 每次工具返回（工具名 / 字节数 / 是否带输出原文 / 预览）；移除写死的 "0 rows sent"。

### Changed

- 工作台布局改为 VS Code / JupyterLab 式（Owner 裁决）：顶部细栏、左侧活动栏 + 可缩放侧栏（资源管理器 / 会话 / 变量）、编辑区（Welcome + notebook tabs）、可缩放 Agent 栏、底部状态栏；`Ctrl+B` / `Ctrl+Alt+B` 开合。原顶栏 `Files | Notebook` 切换移除，文件树回到侧栏。
- 首启引导模态并入 Welcome 页（JupyterLab Welcome 样式：Start / Recent / Environment / Keyboard）；环境自检常驻，未打开 notebook / 工作区时显示"待检查"而非误报失败。
- Session notebook 模态按 Claude Science 参考图重做：标题 + notebook chip + 计数、可折叠会话分组行、`NOTEBOOK python · N cells` 段头、带行号与语法着色的代码、`▶ output` 披露、`wrote` 行、右下 `⤓ .ipynb`；live 会话内联富输出（图像/表格）。

### Added

- RPC `bridge.mcpLaunch`：回报以 MCP 模式启动本 bridge 的命令行（Welcome「Connect…」展示）。
- `scripts/bench.mjs`：intent §8 量化指标首次可重复测量（冷启动、cell 附加开销、bridge RSS、100 cell 滚动帧率）。
- 普通 cell 收尾裸表达式回显（L-5）：`df` 这类末行表达式发 `text/plain`，对象有 `_repr_html_()` 时再发 `text/html`；不绑定 `_`、不进 defs。
- 前端把内核 `text/html` 渲染为真表格（ADR-011，提案待裁决）：DOMParser 解析后白名单重建，不写回 HTML 串、无带 URL 属性；非表格型回落 `text/plain`。
- live 会话 `.ipynb` 导出包含 `text/html`。

### Fixed

- CI 画廊连续失败：i18n 默认 en 后脚本仍按中文文案定位（08/10/15 态）；画廊改为钉 en 并新增 Welcome 态。
- Session notebook 被标题栏 transform 容器截断（改为 portal 渲染）。

## [0.1.0] - 2026-10-07

首个公开发布。四平台产物：Windows NSIS / MSI，Linux deb / AppImage（**未签名**）。

### Added（P4 产品化）

- Tauri 打包流水线（`release.yml`，tag 触发）与 sidecar：node 跑 bridge 单文件 bundle，uv 首启安装 Python 与依赖（需联网，约 450MB）。
- 凭据加密存储（AES-256-GCM，`<dataDir>/providers.json` 0600）+ 本机 LLM 代理 `127.0.0.1:7789`（浏览器不持有 key）。
- App View（隐藏代码的只读交互报告，`?view=app`）、浅色主题、i18n 骨架（en / zh）、首启环境自检。
- operon 可复现性 bundle 作为 showcase；内核 cwd 跟随 notebook 目录。

### Known limitations

- 安装包未签名；首启需联网下载运行时；部分界面文案尚未进入 i18n 字典。

## [0.0.1] - 2026-10-07（开发期，未发布、未打 tag）

### P3 波次（2026-10-07）

#### Added

- 多 Tab 多内核：一个 tab = 一个 .py = 一个内核进程，焦点路由（P3.1，`router.multi` / `notebooks` 套件）
- 变量 inspector 抽屉：状态栏拖出/双击展开，type/shape/len/preview + 过滤排序；duck-typed schema 扩展（P3.2/P3.5）
- marimo ↔ NovaLab 双向 .py 转换器 CLI：`python -m novakernel.convert {to-nova|to-marimo}`（P3.6，18 例测试）
- Session 汇总模态（segments 分组、只读 cell 行）+ nbformat 4.5 `.ipynb` 导出/导入闭环（P3.4，exporter 14 例 + importer 24 例）
- 原生交互控件 slider/datepicker/table，绑定即反应式重跑，端到端（P3.3）
- 画廊状态 12–15b 真机截图；功能矩阵刷新至 40 行 = ✅34 · 🟡5 · ⛔1

#### Changed

- spec 新增 §15 交互控件协议（Owner 裁决）

#### Fixed

- TabBar 刷新以 bridge 连接为门（消除启动期 console 噪音）

### P2 波次（2026-10-06 ~ 10-07）

#### Added

- Agent 闭环：AgentPanel（Vercel AI SDK 流式）、provider registry（Anthropic/OpenAI 兼容/DeepSeek/Ollama）、One-click Fix 卡片、"本次发送了什么"审计 chip（P2.1/P2.5）
- 行内 Diff：CodeMirror MergeView 红绿对照、`Tab` 采纳自动重跑 / `Esc` 拒绝、cascade 策略开关（P2.3/P2.4）
- Bridge MCP stdio server：六工具 + 2 resources，`propose_code_change` 入队前编译预检（多重定义/环 → 拒绝并回 reason）（P2.6/P2.7）
- 工作区文件管理：文件树、新建/重命名/删除确认、路径越界拒绝（M8）；会话管理：历史列表、只读浏览、ended 态、截断横幅、写事件与错误 UX（M9/P2.8/P2.9）
- L 线交互状态画廊：`scripts/demo-gallery.mjs`（playwright chromium，真进程），功能矩阵首版（真机证据判据）

#### Fixed

- 画廊发现 bug L-1..L-4（REPL 回灌、Fix 卡片闭环等 M 线问题）

### P1 波次（2026-10-06）

#### Added

- `novakernel` 反应式 Python 内核（S2 spike → G1 门通过，ADR-001 路线 B）：AST defs/refs 提取、Kahn 拓扑、失效传播、环检测、introspect schema 嗅探、matplotlib inline
- Bridge：WS JSON-RPC 2.0 router、KernelSupervisor（1 文件=1 进程）、SessionLogger（`.novalab/session.jsonl`）、PreviewSerializer 隐私硬截断（P1.3）
- 前端：CM6 单元格编辑器、MIME output 渲染、内核状态栏、底部 InlineREPL、LivePill（P1.4/P1.6）
- Tauri v2 devUrl 桌面壳 scaffold + bridge spawn hook（P1.7）、图标集
- 外部热重载 watcher + UI sidecar（P1.8）、UI 状态水合与折叠持久化
- pnpm workspace + uv 环境、集成冒烟脚本、demo notebook

#### Fixed

- shell 构建 pin rust-lld 链接器，规避 Git coreutils `link.exe` 同名遮蔽

### 奠基（2026-10-06）

#### Added

- monorepo scaffold（app/bridge/py/docs/refs 骨架）
- intent/spec/plan 文档三件套、S1 marimo 侦察备忘（互操作性修正：`@app.cell` 与本格式互不直读 → 转换器方案）、G1 决策记录（路线 B）

[Unreleased]: https://github.com/20240610ldx-hub/novalab/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/20240610ldx-hub/novalab/releases/tag/v0.1.0
