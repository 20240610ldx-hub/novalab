# Changelog

本文件记录 NovaLab 的所有重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。发布前的开发历史按阶段（P1/P2/P3 波次）从 git log 手工摘要而成。

## [Unreleased]

### 进行中（P4）

- Tauri 双平台打包流水线（`.github/workflows/release.yml`：Windows nsis+msi / Linux appimage+deb，tag 触发；签名 secrets 未配置时产物不签名）
- 凭据存储迁移：`.env.local` → keychain/加密配置（0600 权限文件，见 SECURITY.md 威胁模型）
- App View（隐藏代码的交互报告一键发布）
- UI i18n（当前英文 UI + 中文文档）
- 内核 dead→restart 等边缘态的真机画廊补拍（功能矩阵 🟡 项）

## [0.0.1] - 2026-10-07（开发期，未发布）

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

[Unreleased]: https://github.com/OWNER/novalab/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/OWNER/novalab/releases/tag/v0.0.1
