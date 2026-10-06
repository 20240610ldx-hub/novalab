# NovaLab 功能矩阵（真机证据版）

> 生成：2026-10-07 · L 线（交互状态画廊）
> 证据来源：
> ① 真机截图 —— `scripts/demo-gallery.mjs`（node + playwright chromium headless，bridge/novakernel 均为真进程；viewport 1440×900、暗色、fullPage；主列为内部滚动，内容溢出时脚本临时增高视口拍全后还原）。截图在本目录 `states/`，下表以 `states/xx.png` 相对链接引用；
> ② 测试 —— py：`uv run --directory py pytest`（101 例）；bridge：`pnpm --filter @novalab/bridge exec vitest run`（145 例）；app：`pnpm --filter @novalab/app exec vitest run`（116 例）；
> ③ 命令 —— `node scripts/integration-smoke.mjs`（bridge+kernel 端到端）、`node scripts/demo-gallery.mjs`（本画廊，幂等可重跑）。
> 判据：✅ 已实现（有真机或测试证据）· 🟡 部分实现（主链路可用，子项缺证据/未接线）· ⛔ 未实现（排期见文末专节，不许写成已做）。
> 计数：主表 40 行 = ✅ 27 · 🟡 8 · ⛔ 5。

## 1. Must 需求（intent §5 M1–M9）

| 功能 | spec/intent 锚点 | 状态 | 证据 |
|---|---|---|---|
| M1 反应式执行内核（AST defs/refs、失效传递闭包、级联、环检测） | intent §5 M1 · spec §5 | ✅ | `node scripts/integration-smoke.mjs`（cell.save→staleSet 含下游）；py/tests/test_dag.py（31 例）· test_runtime.py（24 例）；[states/02-stale.png](states/02-stale.png)（改上游→下游两格 stale 灰徽章） |
| M2 纯 .py 主存储（`# %% [cell-id]` + PEP723 头） | intent §5 M2 · spec §4 | ✅（marimo 转换器 ⛔ P3.6） | [states/01-open-idle.png](states/01-open-idle.png)；py/tests/test_serialize.py（14 例）+ tests/fixtures/marimo_*.py 宽容导入 |
| M3 单元格编辑器（CM6、行号、高亮、折叠 output、计数徽章） | intent §5 M3 · spec §10 | ✅ | [states/01-open-idle.png](states/01-open-idle.png)；偏差记录：高亮为逐行正则 overlay 而非 lezer TagSystem（plan P1.4 注） |
| M4 修错闭环（traceback→FixCard→行内 Diff→Tab 采纳） | intent §5 M4 · spec §9/§12 | 🟡 | UI 全链路真机：[states/03-error-fixcard.png](states/03-error-fixcard.png) + [states/04-diff-staged.png](states/04-diff-staged.png)；app diffLogic.test.ts（21 例）· notebook.test.ts（20 例）；Agent 提议段受 CORS 限制未真机（遗留 L-1） |
| M5 隐私边界（schema-only + 4KB 硬截断 + 发送审计） | intent §5 M5 · spec §8 | ✅ | bridge/src/preview.test.ts（7 例，含 1B–1MB fuzz 必 ≤4KB）；app payload.test.ts（12 例）；ContextChip 常驻"0 rows sent"见 [states/03-error-fixcard.png](states/03-error-fixcard.png) |
| M6 模型解耦（任意 provider；离线降级） | intent §5 M6 · ADR-008 | ✅（keychain 迁移 ⛔ P4） | [states/10-settings.png](states/10-settings.png)；app providers.test.ts（8 例）· openaiCompat.test.ts（6 例） |
| M7 内核状态栏 + 底部 REPL（元素 6/7） | intent §5 M7 | ✅ | [states/07-repl.png](states/07-repl.png)（[repl] cell 回灌 + 状态栏）；[states/01-open-idle.png](states/01-open-idle.png) |
| M8 工作区文件管理（树/新建/重命名/删除确认/越界拒绝） | intent §5 M8 | ✅ | [states/09-sidebar-actions.png](states/09-sidebar-actions.png)（菜单新建 notebook→入树）；[states/01-open-idle.png](states/01-open-idle.png)（树+面包屑）；bridge fs.test.ts（12 例，越界拒绝）· app sidebar/helpers.test.ts（13 例） |
| M9 会话管理（历史/只读/ended 态/截断横幅/cell 计数） | intent §5 M9 | ✅（.ipynb 导出 ⛔ P3 占位） | [states/08-readonly-session.png](states/08-readonly-session.png)（footer 原文+只读编辑器+下拉）；app session.test.ts（13 例）；bridge session-store.test.ts（10 例）· router.session.test.ts（15 例） |

## 2. 附录 A：Claude Science 复刻清单（intent §4 元素 1–10）

| # | 元素 | 状态 | 证据 |
|---|---|---|---|
| 1 | 多内核标签页 TabBar | ⛔ | P3.1；现为 SessionBar 单会话 pill（[states/01-open-idle.png](states/01-open-idle.png)）；见未实现节 |
| 2 | 右上 live 状态 pill + 下拉 | 🟡 | live 态 [states/01](states/01-open-idle.png)、只读切换 [states/08](states/08-readonly-session.png) 真机；kernel dead→restart 行仅测试证据（bridge supervisor.test.ts 8 例 + SessionBar 代码），未真机拍 |
| 3 | cell 头 `[n]` 计数 + python 语言 chip | ✅ | [states/02-stale.png](states/02-stale.png)（[1]+python+stale）；[states/07-repl.png](states/07-repl.png)（[repl] 琥珀徽章） |
| 4 | 暗色代码区（行号/高亮/块内横滚） | ✅ | [states/01-open-idle.png](states/01-open-idle.png) |
| 5 | `▶ output` 可折叠披露区 | ✅ | [states/06-writes-matplotlib.png](states/06-writes-matplotlib.png)·[states/07-repl.png](states/07-repl.png)（展开态）；折叠持久化 bridge ui-store.test.ts（12 例） |
| 6 | 底部 `Python kernel · shared with the agent` + 拖拽把手 + idle | ✅（拖出 inspector ⛔ P3.2） | [states/01-open-idle.png](states/01-open-idle.png)；把手仅视觉（代码注释声明） |
| 7 | REPL 行 `>>> run code in this kernel…` | ✅ | [states/07-repl.png](states/07-repl.png) |
| 8 | SessionModal（segments 折叠分组） | ⛔ | P3.4；见未实现节 |
| 9 | 分组头 + `.ipynb` ExportMenu | ⛔ | P3.4；见未实现节 |
| 10 | 整体暗色极简等宽视觉 tokens | ✅ | 全部 [states/*.png](states/)（styles.css 自建 tokens，clean-room ADR-004） |

## 3. 附录 A-2：第二批参考细节（spec §10 #11–18）

| # | 细节 | 状态 | 证据 |
|---|---|---|---|
| 11 | `error (line N)` 红徽章 + 编辑器出错行红底 | ✅ | [states/03-error-fixcard.png](states/03-error-fixcard.png)（line 3 徽章+红行）；app CellEditor.errorLine.test.ts（6 例） |
| 12 | ended 态 footer 原文 + `Ended HH:MM` pill + 只读浏览 | 🟡 | footer 原文/read-only 编辑器/历史下拉真机 [states/08-readonly-session.png](states/08-readonly-session.png)；`Ended HH:MM` 持续态（crash 后无新会话）未真机拍，endedLabel/viewOnlyFooter 单测 app session.test.ts |
| 13 | 左 pill 会话切换器（名称+cell 数+来源标签） | ✅ | [states/08-readonly-session.png](states/08-readonly-session.png)（`2026-10-07 01:38 read-only`）；下拉行含 N cells/read-only/agent 来源标签（SessionBar，demo 会话全为 local） |
| 14 | >500 cells 截断横幅 + 导出入口 | 🟡 | 逻辑与文案单测 app session.test.ts（truncationBanner/truncateHistory）；>500 场景未真机构造；横幅导出按钮接 export.ipynb 现回 -32600（P3 占位） |
| 15 | 输出下 `wrote <绝对路径>` 写通知行 | ✅ | [states/06-writes-matplotlib.png](states/06-writes-matplotlib.png)（to_csv 两行 wrote）；py test_write_notify.py（12 例：去重/封顶/绝对化/异常路径） |
| 16 | footer 右侧 cell 计数 | ✅ | [states/01-open-idle.png](states/01-open-idle.png)（`3 cells`）· [states/07-repl.png](states/07-repl.png)（`4 cells`） |
| 17 | matplotlib inline（run.mime image/png） | 🟡 | 链路真机 [states/06-writes-matplotlib.png](states/06-writes-matplotlib.png)（单图折线 PNG）；py test_matplotlib_mime.py（3 例）；参考图"多图/中文/对数坐标"未逐项真机 |
| 18 | 命名内核 tab（`Python — geo`）ended view-only | ⛔ | P3.1（与 #1 合并）；见未实现节 |

## 4. P2 能力（plan §3）

| 能力 | 锚点 | 状态 | 证据 |
|---|---|---|---|
| P2.1 AgentPanel 流式 + provider registry + 设置面板 | plan P2.1 | 🟡 | 设置面板/registry/dev 兜底 ✅ [states/10-settings.png](states/10-settings.png) + providers/openaiCompat 测试；浏览器直连流式 ⛔ CORS（遗留 L-1），降级 UX 真机 [states/11-agent-stream-degraded.png](states/11-agent-stream-degraded.png)（错误横幅+重试/打开设置） |
| P2.2 六工具单源 + Rulebook + propose AST 预检 | plan P2.2 · spec §7 | ✅ | bridge router.agent.test.ts（17 例）· mcp/server.test.ts（10 例）；app tools.test.ts（9 例）；编译预检=router.ts diffStage（真机 propose 段受 L-1 限制） |
| P2.3 行内 MergeView + 托盘 + Tab/Esc + edited-staged | plan P2.3 · spec §9 | ✅ | [states/04-diff-staged.png](states/04-diff-staged.png)（红绿 hunk+`1 pending`+✓/× 两级）；app diffLogic.test.ts（21 例，含 trayKeyAction Tab/Esc/EscEsc） |
| P2.4 stalePolicy（Owner mark-only）+ cascade 开关 | plan P2.4 | ✅（auto 档真机未验证） | [states/05-ask-dialog.png](states/05-ask-dialog.png)（ask 确认窗：下游清单+拓扑序）；app/src/kernel/stalePolicy.ts 冻结；resolveCascadeDecision 单测 diffLogic.test.ts |
| P2.5 One-click Fix 卡片 + ContextChip 审计 | plan P2.5 · spec §8 | 🟡 | [states/03-error-fixcard.png](states/03-error-fixcard.png)（FixCard 浮现+traceback 尾 3 行；schemas=0 见遗留 L-3）；ContextChip 常驻见各图 |
| P2.6 MCP stdio server + `novalab://` resources | plan P2.6 · spec §6.3 | ✅ | bridge mcp/server.test.ts（10 例）；docs/mcp-demo.md（Claude Code 实连命令+六工具表）；外部 Agent 真连演示未复现于本画廊 |
| P2.7 PreviewSerializer 硬截断 + 审计 UI | plan P2.7 · spec §8 | ✅ | bridge preview.test.ts（7 例 fuzz）；ContextChip（[states/03](states/03-error-fixcard.png)/[states/10](states/10-settings.png)） |
| P2.8 文件与会话管理（M8/M9，J 线） | plan P2.8 | ✅ | [states/08](states/08-readonly-session.png)/[states/09](states/09-sidebar-actions.png)；bridge fs/session-store/session-log/watch/ui-store 测试；app session.test.ts · sidebar/helpers.test.ts |
| P2.9 错误 UX 与写事件（K 线，A-2 #11/15/17） | plan P2.9 | ✅ | [states/03-error-fixcard.png](states/03-error-fixcard.png) + [states/06-writes-matplotlib.png](states/06-writes-matplotlib.png)；CellEditor.errorLine.test.ts；py test_write_notify.py · test_matplotlib_mime.py |
| D1/D2 阶段演示录屏（p1.gif/p2.gif） | plan D1/D2 | ⛔ | docs/demos 仅有 ui-2026-10-06-p2.png 与本 states/ 画廊；录屏未产出 |

## 5. 工程基座（P1/spike 补充）

| 项 | 锚点 | 状态 | 证据 |
|---|---|---|---|
| G1 门：路线 B（自研内核）裁决 | plan §1 · ADR-001 | ✅ | docs/adr/001-kernel-route.md · docs/spike-s1-memo.md；`node scripts/integration-smoke.mjs` |
| P1.7 Tauri 壳 devUrl 模式 | plan P1.7 | ✅（打包 ⛔ P4.1） | plan §2 P1.7 行闭环记录；app/src-tauri 存在；桌面打包未做 |
| P1.8 sidecar `.novalab/` + 热重载 + 崩溃恢复 | plan P1.8 | 🟡 | bridge watch.test.ts（28 例）· ui-store.test.ts（12 例）；崩溃横幅/dead-restart 行未真机拍 |

## 6. 未实现（P3/P4 排期）——诚实标注

| 项 | 排期 | 现状 |
|---|---|---|
| 多内核/多 tab（同屏多 Python 进程，A#1、A-2#18） | P3.1 | 单内核单文件；SessionBar 替代视觉位 |
| 变量 inspector（状态栏 ⠿⠿ 拖出） | P3.2 | 把手仅视觉占位 |
| 原生交互控件 slider/table/datepicker | P3.3（S4） | 无 |
| SessionModal + segments 折叠分组（A#8） | P3.4 | 无；会话数据已落 `.novalab/sessions/`（jsonl+snapshot） |
| 分组头 + ExportMenu（A#9） | P3.4 | 无 |
| .ipynb 导出实现 + 一次性导入转换 | P3.4 / M2 | `export.ipynb` 返回 -32600 "P3 feature"（router.ts）；入口按钮在 A-2#14 横幅 |
| schema 嗅探扩展 numpy/scipy/geopandas | P3.5 | 仅 pandas/基础类型（introspect.py） |
| marimo ↔ NovaLab .py 双向转换器 | P3.6 | 仅单向宽容导入 |
| App View（隐藏代码交互报告） | P4.2 | 无 |
| 打包流水线 + 签名 | P4.1 | 仅 devUrl 模式 |
| 亮色主题 + i18n 骨架 | P4.3 | 暗色单主题；UI 中英混排、无 i18n 框架（Q3 裁决 i18n 留 P4） |
| 首启引导（uv 环境自检/修复向导） | P4.4 | 无 |
| keychain/加密存储迁移 | P4 / ADR-008 | 现 localStorage 明文 + 设置面板常驻警告（[states/10-settings.png](states/10-settings.png)） |
| 公测发布页 + 开源整理 | P4.5 | 无 |
| wasm 纯前端预览（Could） | 未排期 | 无 |
| 多人协同 / 云同步 / 非 Python 内核 | Won't | 明确不做（intent §9） |

## 7. 遗留 bug 清单（L 线真机发现；按文件所有权未修）

| # | 现象 | 定位 | 证据 |
|---|---|---|---|
| L-1 | 浏览器直连 tokenplan（aliyuncs MaaS anthropic-compat）被 CORS preflight 拦截（无 `Access-Control-Allow-Origin`）；node 侧同请求 HTTP 200。P2.1/P2.5 的流式段在浏览器不可用 | 环境/端点缺 CORS 头；需 bridge 侧 LLM 代理或 vite dev proxy（涉 app/bridge src，待裁决） | [states/11-agent-stream-degraded.png](states/11-agent-stream-degraded.png)（降级错误横幅）；console: `blocked by CORS policy` |
| L-2 | 内核 `_cells_payload()` 上报 `sideEffect`（detect_side_effect 已接线），但 bridge `CellInfo`/`normalizeCells`（protocol.ts/router.ts）丢弃该字段 → CellHeader 与 CascadeAskDialog 的 `side-effect`/`⚡` 徽章恒不显示（spec §6.2 契约含该字段）；kernel 侧级联保护不受影响 | bridge/src/protocol.ts:53-59、router.ts normalizeCells | [states/05-ask-dialog.png](states/05-ask-dialog.png)（to_csv cell 无 ⚡ 徽章）；画廊运行备注 |
| L-3 | run 完成后前端不刷新 schemas（未调 `kernel.vars`、run.done 不携 schemas）→ FixCard"traceback+相关 schemas 自动附着"实际只附 traceback（P2.5 验收子项） | app/src/store/notebook.ts（schemas 仅来自 notebook.open） | [states/03-error-fixcard.png](states/03-error-fixcard.png) 按钮原文"修复（traceback + 0 schemas → Agent）" |
| L-4 | REPL/普通 cell 为纯 exec、无 displayhook：裸表达式（`df.shape`、`df`）不回显值，需 print 才有输出；与 Jupyter/marimo 的表达式回显范式不同 | py/novakernel/runtime.py `_run_cell`（compile "exec"） | [states/07-repl.png](states/07-repl.png)（[repl] cell 无输出区） |
| O-1 | 观察（非 bug）：`# %% [cell-id: …]` 要求 8 位 hex；非 hex id（如 `w1a2b3c4`）按 spec §4 宽容降级为整文件单 cell，静默换 id。画廊夹具首版触发过 | py/novakernel/serialize.py CELL_MARKER_RE | 画廊脚本注释（scripts/demo-gallery.mjs） |
