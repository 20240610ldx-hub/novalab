# NovaLab 实施计划（Plan）

> 状态：v0.1 · 2026-10-06 · 上游：[intent.md](intent.md) · [spec.md](spec.md)
> 周期口径：1 周 = 5 个工作日；W1 从开工日算起。任务 id：`P<阶段>.<序号>`，spike `S< n>`，门 `G<n>`。

---

## 0. 本次会话已完成的准备（2026-10-06）

| 项 | 状态 |
|---|---|
| 工具链探测 | git 2.52 / node 24.19 / pnpm 10.33 / python 3.13.13 / uv 0.11.15 / cargo 1.94.1 ✅ |
| 参考仓库（只读，`refs/`，已 gitignore） | `refs/marimo`（反应式内核+ .py 格式原型）· `refs/codemirror-merge`（行内 Diff）· `refs/vercel-ai`（AI SDK/MCP 示例）✅ shallow clone |
| 文档 | intent / spec / plan 三件套 ✅ |
| 工程骨架 | pnpm workspace（app + bridge）+ py/novakernel 包骨架 + 依赖安装 ✅（见 §9 环境清单） |
| 首个Owner代码贡献点 | ✅ Owner 裁决 mark-only（2026-10-06），`stalePolicy.ts` 已实现；P2 补开关 UI |
| Owner 开放问题裁决 | 2026-10-06：Q1–Q6 采纳 intent 倾向；Q7 = cc-switch tokenplan（值待 Owner 填 `app/.env.local`）✅ |
| 骨架类型检查 | `app` / `bridge` tsc --noEmit 双绿（ai v7 / zod v4 / TS 7 生态）✅ |

---

## 1. Spike 与 Go/No-Go 门（W1 前半，ADR-001）

- **S1（1d）marimo 协议摸底**：跑通 `refs/marimo` 的 server，用裸 WS 客户端驱动一次 cell 执行；产出：协议稳定性评估 memo（`docs/adr/001-kernel-route.md` 素材）。回答："若切路线 A，我们的前端要适配多少内部协议？"
- **S2（2d）自研内核原型**：`py/novakernel` 的 `dag.py` + `runtime.py` 最小闭环——AST defs/refs、拓扑 exec、编辑后失效传递闭包、幽灵变量删除； pytest 黄金集 20 例全绿。
- **G1 门（W1 末）**：S2 达标（级联+失效正确、无 P0 边角 bug）→ 路线 B；否则切 A（marimo 后端 + `KernelAdapter` 实现替换，前端零改动——接口在 P1.3 就冻结）。
  决策人：Owner（默认采纳我的建议：B）。

---

## 2. 阶段 1 · MVP 核心链路（W1–W4）

| id | 任务 | 交付物 / 验收 | 依赖 |
|---|---|---|---|
| P1.1 | 骨架落地：workspace、vite+tailwind v4、tsconfig strict、eslint | `pnpm dev` 起空壳三栏 | — |
| P1.2 | `py/novakernel`：dag + runtime + introspect + serialize（marimo 子集读写）+ server 消息循环；pytest ≥60 例 | S2 扩展版全绿；`fixtures/` 往返无损 | G1 |
| P1.3 | `bridge`：WS JSON-RPC router + KernelSupervisor（spawn/health/restart）+ 端口自愈；**冻结 KernelAdapter 接口** | 契约测试过；kill kernel 后一键恢复 | P1.2 |
| P1.4 | 前端 CellList/CellHeader/CellEditor(CM6)/OutputDisclosure/OutputRenderer(text+traceback) | 100 cell 虚拟列表 60fps；折叠 output 复刻截图元素 3-5 | P1.3 |
| P1.5 | 反应式 UI 联动：stale 徽章、级联运行流式刷新、编译错行内提示 | intent §8 演示脚本前半段 | P1.4 |
| P1.6 | KernelStatusBar + InlineREPL + LivePill（截图元素 2/6/7） | REPL 输出回灌匿名 cell | P1.4 |
| P1.7 | Tauri 壳 devUrl 模式接入（spawn bridge、窗口、图标占位） | 双击桌面图标 = 浏览器同等体验 | P1.5 |
| P1.8 | .py 打开/保存/新建 + sidecar `.novalab/` + 崩溃恢复横幅 | 改文件外部→热重载提示 | P1.5 |
| **D1** | **阶段演示**：intent §8 脚本除 Agent 段外全通（断网） | 录屏存档 `docs/demos/p1.gif` | 全部 |

## 3. 阶段 2 · Agent 闭环与 Diff（W5–W7）

| id | 任务 | 交付物 / 验收 |
|---|---|---|
| P2.1 | AgentPanel：useChat 流式 + provider registry（anthropic/openai/deepseek/ollama）+ 设置面板 key 存储（dev：env；Tauri：keychain） | 四 provider 冒烟全绿；断网降级横幅 |
| P2.2 | 工具集 6 个（spec §7）单源实现 + Reactive Rulebook 注入 + propose 入口 AST 校验 | 多重定义提议被拒且模型自纠 e2e |
| P2.3 | 行内 Diff：MergeView 内嵌 + hunk/整格两级采纳 + diff 托盘 + Tab/Esc/edited-staged 状态机 | 状态机单测全绿；快捷键无焦点陷阱 |
| P2.4 | `app/src/kernel/stalePolicy.ts → decideStalePolicy()`——**Owner 裁决：一律 mark-only**（2026-10-06，已实现）；P2 补设置面板开关（auto-cascade/ask）与策略 e2e | 已实现 ✅ + 开关/e2e 待 P2 |
| P2.5 | One-click Fix 卡片：traceback+相关 schemas 自动附着、ContextChip 审计展开 | intent §8 全脚本通网版 |
| P2.6 | MCP server (stdio) 对外暴露 + `novalab://` resources；Claude Code 实连演示 | 外部 Agent 提议 → 前端弹审阅 |
| P2.7 | PreviewSerializer 硬截断 + 发送审计 UI | >4KB  fuzz 必截单测 |
| **D2** | 阶段演示：报错→Fix→Diff→Tab→级联绿 全闭环 | `docs/demos/p2.gif` |

## 4. 阶段 3 · 上下文深潜与多内核（W8–W10）

P3.1 多 Tab 多内核（S1）：KernelSupervisor N 进程 + tab 切换 + 内存水位提示；
P3.2 变量 inspector（状态栏拖出，S3）；
P3.3 交互控件 mo 风格子集（slider/table → 绑定即重跑，S4）；
P3.4 SessionModal + segments + .ipynb 导出/一次性导入（S2，截图元素 8/9）；
P3.5 schema 嗅探扩展：numpy/scipy/geopandas 类型表；
**D3** 演示：双内核同屏 + session 模态 + 导出 ipynb 在 JupyterLab 打开无误。

## 5. 阶段 4 · 产品化（W11–W12）

P4.1 CI/CD：tauri-action 双平台产物 + 签名占位；P4.2 App View 模式；P4.3 亮色主题 + i18n 骨架（Q3）；P4.4 首启引导（uv 环境自检/修复向导，intent 风险章）；P4.5 公测发布页 + 开源仓库整理（Q4 许可证落定）。

---

## 6. 参考仓库阅读地图（refs/，只读）

| 仓库 | 必读路径 | 学什么 |
|---|---|---|
| `refs/marimo` | `_ast/compiler.py`、`_ast/visitor.py`（defs/refs 提取边角）；`_runtime/runner`、`_runtime/graph`（失效/级联/glitch-free）；`_server/api` + `websockets`（协议形态，S1 用）；`examples/`（serialize fixtures 来源） | 路线 A/B 共同的知识源；**读思路，抄测试用例形状，不抄代码**（Q4 许可证落定前） |
| `refs/codemirror-merge` | `src/merge.ts`、examples/inline | MergeView 内嵌模式、hunk API、装饰器样式 hook（P2.3） |
| `refs/vercel-ai` | `examples/ai-sdk-*`、`packages/ai/src/mcp` | useChat 流式、tool zod 单源、MCP client/server 装配（P2.1/P2.6） |

## 7. 风险登记（继承方案书 + 新增）

| 风险 | 概率/影响 | 缓解 |
|---|---|---|
| LLM 写非反应式代码（重定义全局） | 高/中 | Rulebook + propose 入口 AST 拒收 + 拒绝率进 session 日志迭代 prompt |
| 自研内核边角（walrus/match/comprehension 作用域） | 中/高 | S2 黄金集前置；G1 门；兜底切路线 A |
| 用户 Python 环境碎片化 | 高/中 | uv 项目级 venv 唯一支持路径 + 首启自检向导；系统 python 仅只读探测 |
| marimo 协议漂移（若切 A） | 中/高 | KernelAdapter 隔离 + 版本 pin + 契约测试 |
| CM6 多实例内存 | 中/中 | 视口外销毁重建（P1.4 验收含 100 cell 指标） |
| 复刻越界成抄袭（ADR-004） | 低/高 | clean-room 纪律：只对照截图自绘 tokens；review checklist |
| 副作用 cell 被级联重跑（刷 API/覆写文件） | 中/高 | §5 语义：副作用启发式名单 + 默认不级联 + P2.4 策略钩子显式化 |

## 8. 工程约定

分支：`main` + 每阶段 `p<n>/<topic>`；commit conventional（`feat(kernel): …`）；每 D-演示打 tag `demo-p<n>`。
依赖纪律：app 不 import bridge 运行时（仅类型）；py 零第三方硬依赖起步（websockets 除外），pandas 等进 introspect 可选 extras。
环境清单（已装/待装）：node deps 见 `app|bridge/package.json`；py venv `.venv`（uv）：`websockets, pytest`，extras：`pandas, marimo(spike 参考)`。

## 9. 下一步（Owner 裁决后即刻可开工）

1. ~~回答 intent §7 的 Q1–Q7~~ ✅ 2026-10-06 已裁决（Q7 的值待 Owner 填入 `app/.env.local`）；
2. 我按 G1 流程跑 S1+S2 并出 `docs/adr/001-kernel-route.md` 终稿；
3. ~~`decideStalePolicy()`~~ ✅ Owner 裁决 mark-only，已实现（P2 补开关 UI 与 e2e）。
