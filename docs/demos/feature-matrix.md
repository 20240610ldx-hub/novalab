# NovaLab 功能矩阵（真机证据版）

> 生成：2026-10-07 · L 线（交互状态画廊）· P3 扩拍刷新（states 12–15b，多 tab/inspector/控件/SessionModal+导出导入）· **Q 线 A-3/A-4 刷新**（全态暗色重拍 + 01/03/15 浅色版 `*-light.png`，双主题 + Files/Notebook 视图切换 + 输出分区/复制钮/完整会话卡）
> 证据来源：
> ① 真机截图 —— `scripts/demo-gallery.mjs`（node + playwright chromium headless，bridge/novakernel 均为真进程；viewport 1440×900、暗色默认、fullPage；主列为内部滚动，内容溢出时脚本临时增高视口拍全后还原；dev 服务已在跑复用、没跑自起自停；Q 线起 01 态附加 JetBrains Mono `document.fonts.check` 与复制钮 clipboard 读回断言）；截图在本目录 `states/`（浅色版 `*-light.png`），下表以 `states/xx.png` 相对链接引用；
> ② 测试 —— py：`uv run --directory py pytest`（179 例）；bridge：`pnpm --filter @novalab/bridge exec vitest run`（161 例）；app：`pnpm --filter @novalab/app exec vitest run`（201 例，Q 线 +17：输出分区 6 · ui 视图/主题 7 · 会话卡 selector 4）；
> ③ 命令 —— `node scripts/integration-smoke.mjs`（bridge+kernel 端到端）、`node scripts/demo-gallery.mjs`（本画廊，幂等可重跑）。
> 判据：✅ 已实现（有真机或测试证据）· 🟡 部分实现（主链路可用，子项缺证据/未接线）· ⛔ 未实现（排期见文末专节，不许写成已做）。
> 计数：主表 57 行 = ✅ 50 · 🟡 7 · ⛔ 0。（D 线录屏闭环：D1/D2 拆为两行并 ⛔→✅，产物 docs/demos/reels/，node scripts/demo-reels.mjs 幂等重录）

## 1. Must 需求（intent §5 M1–M9）

| 功能 | spec/intent 锚点 | 状态 | 证据 |
|---|---|---|---|
| M1 反应式执行内核（AST defs/refs、失效传递闭包、级联、环检测） | intent §5 M1 · spec §5 | ✅ | `node scripts/integration-smoke.mjs`（cell.save→staleSet 含下游）；py/tests/test_dag.py（31 例）· test_runtime.py（24 例）；[states/02-stale.png](states/02-stale.png)（改上游→下游两格 stale 灰徽章） |
| M2 纯 .py 主存储（`# %% [cell-id]` + PEP723 头） | intent §5 M2 · spec §4 | ✅（marimo 转换器 P3.6 ✅） | [states/01-open-idle.png](states/01-open-idle.png)；py/tests/test_serialize.py（14 例）+ tests/fixtures/marimo_*.py 宽容导入；双向转换器 py/novakernel/convert.py CLI（`python -m novakernel.convert {to-nova\|to-marimo} IN OUT`）py/tests/test_convert.py（18 例） |
| M3 单元格编辑器（CM6、行号、高亮、折叠 output、计数徽章） | intent §5 M3 · spec §10 | ✅ | [states/01-open-idle.png](states/01-open-idle.png)；偏差记录：高亮为逐行正则 overlay 而非 lezer TagSystem（plan P1.4 注） |
| M4 修错闭环（traceback→FixCard→行内 Diff→Tab 采纳） | intent §5 M4 · spec §9/§12 | ✅ | UI 全链路真机：[states/03-error-fixcard.png](states/03-error-fixcard.png) + [states/04-diff-staged.png](states/04-diff-staged.png)；app diffLogic.test.ts（21 例）· notebook.test.ts；L-1 闭环后 Agent 段真机可跑（[states/11-agent-stream.png](states/11-agent-stream.png)：agent 流式+工具推理段；propose→行内 Diff 全形态未单拍，bridge router.agent.test.ts 17 例覆盖） |
| M5 隐私边界（schema-only + 4KB 硬截断 + 发送审计） | intent §5 M5 · spec §8 | ✅ | bridge/src/preview.test.ts（7 例，含 1B–1MB fuzz 必 ≤4KB）；app payload.test.ts（12 例）；ContextChip 常驻"0 rows sent"见 [states/03-error-fixcard.png](states/03-error-fixcard.png) |
| M6 模型解耦（任意 provider；离线降级） | intent §5 M6 · ADR-008 | ✅（keychain 迁移 ⛔ P4） | [states/10-settings.png](states/10-settings.png)；app providers.test.ts（8 例）· openaiCompat.test.ts（6 例） |
| M7 内核状态栏 + 底部 REPL（元素 6/7） | intent §5 M7 | ✅ | [states/07-repl.png](states/07-repl.png)（[repl] cell 回灌 + 裸表达式回显 output 区，L-4 闭环）+ 状态栏；[states/01-open-idle.png](states/01-open-idle.png) |
| M8 工作区文件管理（树/新建/重命名/删除确认/越界拒绝） | intent §5 M8 | ✅ | [states/09-sidebar-actions.png](states/09-sidebar-actions.png)（菜单新建 notebook→入树）；[states/01-open-idle.png](states/01-open-idle.png)（树+面包屑）；bridge fs.test.ts（12 例，越界拒绝）· app sidebar/helpers.test.ts（13 例） |
| M9 会话管理（历史/只读/ended 态/截断横幅/cell 计数） | intent §5 M9 | ✅（.ipynb 导出/导入已接线 P3.4） | [states/08-readonly-session.png](states/08-readonly-session.png)（footer 原文+只读编辑器+下拉）；[states/15-session-modal.png](states/15-session-modal.png)+[states/15b-import-done.png](states/15b-import-done.png)（export.ipynb 落盘 .novalab/sessions/*.ipynb → import.ipynb 回转 .py 并开新 tab）；app session.test.ts（13 例）；bridge session-store.test.ts（10 例）· router.session.test.ts（15 例）· exporter.test.ts（14 例）· importer.test.ts（24 例） |

## 2. 附录 A：Claude Science 复刻清单（intent §4 元素 1–10）

| # | 元素 | 状态 | 证据 |
|---|---|---|---|
| 1 | 多内核标签页 TabBar | ✅ | [states/12-multi-tab.png](states/12-multi-tab.png)（demo.py + gallery-write.py 双 tab：内核状态点/× 关闭/+ 新建；切第二 tab 渲染其 cells）；bridge router.multi.test.ts（9 例）· app notebooks.test.ts（12 例）；遗留限制见 §7 N1 |
| 2 | 右上 live 状态 pill + 下拉 | 🟡 | live 态 [states/01](states/01-open-idle.png)、只读切换 [states/08](states/08-readonly-session.png) 真机；kernel dead→restart 行仅测试证据（bridge supervisor.test.ts 8 例 + SessionBar 代码），未真机拍 |
| 3 | cell 头 `[n]` 计数 + python 语言 chip | ✅ | [states/02-stale.png](states/02-stale.png)（[1]+python+stale）；[states/07-repl.png](states/07-repl.png)（[repl] 琥珀徽章） |
| 4 | 暗色代码区（行号/高亮/块内横滚） | ✅ | [states/01-open-idle.png](states/01-open-idle.png) |
| 5 | `▶ output` 可折叠披露区 | ✅ | [states/06-writes-matplotlib.png](states/06-writes-matplotlib.png)·[states/07-repl.png](states/07-repl.png)（展开态）；折叠持久化 bridge ui-store.test.ts（12 例） |
| 6 | 底部 `Python kernel · shared with the agent` + 拖拽把手 + idle | ✅（拖出/双击 inspector P3.2 已接线） | [states/01-open-idle.png](states/01-open-idle.png)；[states/13-inspector.png](states/13-inspector.png)（双击 ⠿ 把手展开抽屉：df/total 行 type/shape-len/preview + 过滤/排序钮）；app Inspector/helpers.test.ts（17 例） |
| 7 | REPL 行 `>>> run code in this kernel…` | ✅ | [states/07-repl.png](states/07-repl.png) |
| 8 | SessionModal（segments 折叠分组） | ✅ | [states/15-session-modal.png](states/15-session-modal.png)（`N sessions · M cells` 头部 + live/ended 段分组，展开段列只读 cell 行 `[n] + 首行代码 + 状态点`）；app SessionModal/store.test.ts（15 例）· selectors.test.ts（6 例） |
| 9 | 分组头 + `.ipynb` ExportMenu | ✅ | [states/15-session-modal.png](states/15-session-modal.png)（footer `.ipynb` 导出钮 + 顶部 import 路径输入）；[states/15b-import-done.png](states/15b-import-done.png)（导出落盘 → import 回转新 tab）；bridge exporter.test.ts（14 例）· importer.test.ts（24 例）· router.ipynb.test.ts（2 例）；历史会话导出仅文本输出见 §7 N2 |
| 10 | 整体暗色极简等宽视觉 tokens | ✅ | 全部 [states/*.png](states/)（styles.css 自建 tokens，clean-room ADR-004） |

## 3. 附录 A-2：第二批参考细节（spec §10 #11–18）

| # | 细节 | 状态 | 证据 |
|---|---|---|---|
| 11 | `error (line N)` 红徽章 + 编辑器出错行红底 | ✅ | [states/03-error-fixcard.png](states/03-error-fixcard.png)（line 3 徽章+红行）；app CellEditor.errorLine.test.ts（6 例） |
| 12 | ended 态 footer 原文 + `Ended HH:MM` pill + 只读浏览 | 🟡 | footer 原文/read-only 编辑器/历史下拉真机 [states/08-readonly-session.png](states/08-readonly-session.png)；`Ended HH:MM` 持续态（crash 后无新会话）未真机拍，endedLabel/viewOnlyFooter 单测 app session.test.ts |
| 13 | 左 pill 会话切换器（名称+cell 数+来源标签） | ✅ | [states/08-readonly-session.png](states/08-readonly-session.png)（`2026-10-07 01:38 read-only`）；下拉行含 N cells/read-only/agent 来源标签（SessionBar，demo 会话全为 local） |
| 14 | >500 cells 截断横幅 + 导出入口 | 🟡 | 逻辑与文案单测 app session.test.ts（truncationBanner/truncateHistory）；>500 场景未真机构造；横幅导出钮已接 export.ipynb（P3.4 接线，见 A#9/15 态证据） |
| 15 | 输出下 `wrote <绝对路径>` 写通知行 | ✅ | [states/06-writes-matplotlib.png](states/06-writes-matplotlib.png)（to_csv 两行 wrote）；py test_write_notify.py（12 例：去重/封顶/绝对化/异常路径） |
| 16 | footer 右侧 cell 计数 | ✅ | [states/01-open-idle.png](states/01-open-idle.png)（`3 cells`）· [states/07-repl.png](states/07-repl.png)（`4 cells`） |
| 17 | matplotlib inline（run.mime image/png） | 🟡 | 链路真机 [states/06-writes-matplotlib.png](states/06-writes-matplotlib.png)（单图折线 PNG）；py test_matplotlib_mime.py（3 例）；参考图"多图/中文/对数坐标"未逐项真机 |
| 18 | 命名内核 tab（`Python — geo`）ended view-only | ✅ | 与 A#1 同批（P3.1）：[states/12-multi-tab.png](states/12-multi-tab.png)（tab = 文件名 + 内核状态点；ended tab 灰化 + `ended` 徽章 + view-only 复用只读护栏，代码路径 bridge router.multi.test.ts · app notebooks.test.ts）；真机 ended tab 形态未单拍（本画廊会话均 live） |

## 3A. 附录 A-3：第三批参考细节（spec 附录 A-3 #19–24，Q 线）

| # | 细节 | 状态 | 证据 |
|---|---|---|---|
| 19 | JetBrains Mono 全界面（代码+UI 等宽） | ✅ | @fontsource/jetbrains-mono 400/500/700 离线打包（main.tsx import，styles.css --font-mono 首选生效）；画廊 01 态 `document.fonts.check('13px "JetBrains Mono"')` 断言 true（运行备注）；全部 states/ 重拍 |
| 20 | stderr/traceback/RuntimeWarning = 红左竖框+红粉字面板，与 stdout 中性面板按 run 序堆叠 | ✅ | OutputRenderer.deriveOutputSegments 分区纯函数 app OutputRenderer.segments.test.ts（6 例）；[states/03-error-fixcard.png](states/03-error-fixcard.png)（KeyError 红面板）·[states/06-writes-matplotlib.png](states/06-writes-matplotlib.png)（stdout 中性面板）；累积串形态限制逐 chunk 交错见 §7 N4 |
| 21 | 代码区右上复制按钮（clipboard 图标，hover 显现 + ✓ 反馈） | ✅ | 画廊 01 态 hover→点击→`navigator.clipboard.readText()` 读回与内核代码一致（运行备注）；CellEditor CopyButton 与 SessionModal 卡（#24）同源 |
| 22 | 长输出内部滚动（面板 max-height 420px + 细滚动条） | 🟡 | styles.css `.nl-out-panel`（420px/overflow-y/细滚动条）；面板形态真机见 [states/03](states/03-error-fixcard.png)/[states/06](states/06-writes-matplotlib.png)；>420px 长输出真机场景未构造 |
| 23 | 顶栏 `Files \| Notebook` 分段切换 + 左工作区标题 + Files 全幅文件视图（rail 移除） | ✅ | [states/01-open-idle.png](states/01-open-idle.png)（切换往返 + 树断言）·[states/09-sidebar-actions.png](states/09-sidebar-actions.png)（全幅 Files 视图新建动作 + 面包屑 + 最近打开右栏）；视图持久化 app store/ui.test.ts（7 例）；header 左 = fs.root 目录名 |
| 24 | SessionModal 完整只读 cell 卡（[n]/chip/error pill/右对齐内核名/红行代码/复制钮/输出面板/wrote 行） | ✅ | [states/15-session-modal.png](states/15-session-modal.png) + [states/15-session-modal-light.png](states/15-session-modal-light.png)（展开段完整卡）；快照 traceback→行号 app SessionModal/selectors.test.ts（+4 例）；折叠披露沿用 ▶/▼ output |

## 3B. A-4：浅色主题 + 结构细节（Owner 第三批四张浅色图，Q 线随 A-3 落地，P4.3 提前）

| # | 细节 | 状态 | 证据 |
|---|---|---|---|
| A4-1 | `▶/▼ output` 披露行获焦 2px 琥珀 focus ring | 🟡 | OutputDisclosure/会话卡披露钮 focus-visible outline 2px var(--accent-run)；焦点态未真机拍 |
| A4-2 | `wrote <path>` = muted 纯文本、输出面板外下方无边框 | ✅ | [states/06-writes-matplotlib.png](states/06-writes-matplotlib.png)（面板下方 muted 行） |
| A4-3 | 输出双面板：stdout 中性 / stderr·traceback 着色底+红左竖框+红系字 | ✅ | [states/03-error-fixcard.png](states/03-error-fixcard.png) + [states/03-error-fixcard-light.png](states/03-error-fixcard-light.png)（#fdeeee 底 #d4453f 左框 #b03a34 字） |
| A4-4 | 出错行高亮浅色 #f6d7d7 整行（暗色沿用 --diff-del 系） | ✅ | [states/03-error-fixcard-light.png](states/03-error-fixcard-light.png)（CM6 行 + 会话卡共用 --err-line） |
| A4-5 | cell 间全宽 1px 分隔线；代码面板与页面底色分层（浅 #ededed vs #fbfbfb）圆角无重边框 | ✅ | [states/01-open-idle-light.png](states/01-open-idle-light.png) · [states/02-stale.png](states/02-stale.png)（暗色分层） |
| A4-6 | tab pill：active 提亮底+1px 边框+微影；inactive 纯 muted；`Ended HH:MM` 同边框 pill | ✅ | [states/01-open-idle-light.png](states/01-open-idle-light.png)（#f3f3f3 条上白 pill）·[states/12-multi-tab.png](states/12-multi-tab.png)（暗色）；TabBar 禁改 → styles.css `div[role=tab]` 结构覆盖 |
| A4-7 | `[n]` 纯 muted 无框；语言 chip 中性 pill；`error (line N)` 实心红 pill 白字（双主题） | ✅ | [states/03-error-fixcard.png](states/03-error-fixcard.png)/[-light](states/03-error-fixcard-light.png)（实心红 pill）；CellHeader 禁改 → styles.css title 钩子覆盖 |
| A4-8 | 行号 muted（浅 #b0b0b0） | ✅ | [states/01-open-idle-light.png](states/01-open-idle-light.png)（--gutter-fg） |
| A4-T | 主题切换：header sun/moon 钮 → html[data-theme] + localStorage novalab.theme（默认 dark），模态/托盘随变量 | ✅ | 01/03 浅色版经 toggle 钮真点、15 浅色版 DOM 直达（画廊 shootLight/setTheme）；[states/15-session-modal-light.png](states/15-session-modal-light.png)；app store/ui.test.ts（theme 4 例） |

## 4. P2 能力（plan §3）

| 能力 | 锚点 | 状态 | 证据 |
|---|---|---|---|
| P2.1 AgentPanel 流式 + provider registry + 设置面板 | plan P2.1 | ✅ | 设置面板/registry/dev 兜底 [states/10-settings.png](states/10-settings.png) + providers/openaiCompat 测试；浏览器流式真机 [states/11-agent-stream.png](states/11-agent-stream.png)（L-1 闭环：dev 走 vite 同源代理 /llm，非降级）；降级 UX 历史证据已移除；用户自配 provider 直连 CORS 与生产代理遗留见 §6/§7 |
| P2.2 六工具单源 + Rulebook + propose AST 预检 | plan P2.2 · spec §7 | ✅ | bridge router.agent.test.ts（17 例）· mcp/server.test.ts（10 例）；app tools.test.ts（9 例）；编译预检=router.ts diffStage；L-1 闭环后 agent 工具循环真机见 [states/11-agent-stream.png](states/11-agent-stream.png)（propose 全形态未单拍） |
| P2.3 行内 MergeView + 托盘 + Tab/Esc + edited-staged | plan P2.3 · spec §9 | ✅ | [states/04-diff-staged.png](states/04-diff-staged.png)（红绿 hunk+`1 pending`+✓/× 两级）；app diffLogic.test.ts（21 例，含 trayKeyAction Tab/Esc/EscEsc） |
| P2.4 stalePolicy（Owner mark-only）+ cascade 开关 | plan P2.4 | ✅（auto 档真机未验证） | [states/05-ask-dialog.png](states/05-ask-dialog.png)（ask 确认窗：下游清单+拓扑序+⚡ side-effect 徽章，L-2 闭环后真机）；app/src/kernel/stalePolicy.ts 冻结；resolveCascadeDecision 单测 diffLogic.test.ts |
| P2.5 One-click Fix 卡片 + ContextChip 审计 | plan P2.5 · spec §8 | ✅ | [states/03-error-fixcard.png](states/03-error-fixcard.png)（FixCard 浮现+traceback 尾 3 行+`survey: DataFrame` schema chip，按钮"修复（traceback + 1 schemas → Agent）"，L-3 闭环）；[states/11-agent-stream.png](states/11-agent-stream.png)（payload 含 1 条 schema，ContextChip `1 schemas · 1 traceback`）；ContextChip 常驻见各图 |
| P2.6 MCP stdio server + `novalab://` resources | plan P2.6 · spec §6.3 | ✅ | bridge mcp/server.test.ts（10 例）；docs/mcp-demo.md（Claude Code 实连命令+六工具表）；外部 Agent 真连演示未复现于本画廊 |
| P2.7 PreviewSerializer 硬截断 + 审计 UI | plan P2.7 · spec §8 | ✅ | bridge preview.test.ts（7 例 fuzz）；ContextChip（[states/03](states/03-error-fixcard.png)/[states/10](states/10-settings.png)） |
| P2.8 文件与会话管理（M8/M9，J 线） | plan P2.8 | ✅ | [states/08](states/08-readonly-session.png)/[states/09](states/09-sidebar-actions.png)；bridge fs/session-store/session-log/watch/ui-store 测试；app session.test.ts · sidebar/helpers.test.ts |
| P2.9 错误 UX 与写事件（K 线，A-2 #11/15/17） | plan P2.9 | ✅ | [states/03-error-fixcard.png](states/03-error-fixcard.png) + [states/06-writes-matplotlib.png](states/06-writes-matplotlib.png)；CellEditor.errorLine.test.ts；py test_write_notify.py · test_matplotlib_mime.py |
| D1 阶段演示录屏（P1 全链路 reel） | plan D1 | ✅ | [reels/reel-d1-2026-10-07.webm](reels/reel-d1-2026-10-07.webm)（14s · open→首跑→键入改数→stale 灰徽章→cascade 转绿→REPL [repl] 回显→SessionModal .ipynb 导出落盘；node scripts/demo-reels.mjs 产出） |
| D2 阶段演示录屏（P2 修错闭环 reel） | plan D2 | ✅ | [reels/reel-d2-2026-10-07.webm](reels/reel-d2-2026-10-07.webm)（25s · 运行出错 error 徽章/红行/traceback/FixCard→点修复→Agent 流式→propose_code_change→行内 Diff 红绿→Tab 采纳→自动重跑转绿→托盘归零） |

## 5. 工程基座（P1/spike 补充）

| 项 | 锚点 | 状态 | 证据 |
|---|---|---|---|
| G1 门：路线 B（自研内核）裁决 | plan §1 · ADR-001 | ✅ | docs/adr/001-kernel-route.md · docs/spike-s1-memo.md；`node scripts/integration-smoke.mjs` |
| P1.7 Tauri 壳 devUrl 模式 | plan P1.7 | ✅（P4.1 打包已验收） | plan §2 P1.7 行闭环记录；GitHub Actions Release run `38066573600`：Windows NSIS/MSI + Linux AppImage/deb 均成功，并通过 packaged startup smoke |
| P1.8 sidecar `.novalab/` + 热重载 + 崩溃恢复 | plan P1.8 | 🟡 | bridge watch.test.ts（28 例）· ui-store.test.ts（12 例）；崩溃横幅/dead-restart 行未真机拍 |

## 6. 未实现（P3/P4 排期）——诚实标注

| 项 | 排期 | 现状 |
|---|---|---|
| schema 嗅探扩展 numpy/scipy/geopandas | P3.5 | 仅 pandas/基础类型（introspect.py） |
| App View（隐藏代码交互报告） | P4.2 | 无 |
| 打包流水线 + 签名 | P4.1 | 打包流水线 ✅；签名 ⏳（未配置证书/secrets） |
| 亮色主题（P4.3 提前，Q 线 A-4） | plan P4.3 | ✅ | [states/01-open-idle-light.png](states/01-open-idle-light.png)·[states/03-error-fixcard-light.png](states/03-error-fixcard-light.png)·[states/15-session-modal-light.png](states/15-session-modal-light.png)；styles.css `[data-theme='light']` token 集 + header sun/moon 钮（localStorage novalab.theme 默认 dark）；i18n 仍留 P4 见下行 |
| i18n 骨架 | P4 | 暗色/浅色双主题已落地（Q 线）；UI 中英混排、无 i18n 框架（Q3 裁决 i18n 留 P4） |
| 首启引导（uv 环境自检/修复向导） | P4.4 | 无 |
| keychain/加密存储迁移 | P4 / ADR-008 | 现 localStorage 明文 + 设置面板常驻警告（[states/10-settings.png](states/10-settings.png)） |
| LLM 代理（生产/Tauri CORS，L-1 尾段） | P4 | ✅ bridge `/llm/*` 代理 + token/origin 校验；前端生产/Tauri 通过 bridge 动态端口与 token 访问；dev 仍保留 vite 同源代理 `/llm` |
| 公测发布页 + 开源整理 | P4.5 | 无 |
| wasm 纯前端预览（Could） | 未排期 | 无 |
| 多人协同 / 云同步 / 非 Python 内核 | Won't | 明确不做（intent §9） |

## 7. 遗留清单（L 线真机发现的 bug：M 线 2026-10-07 修复；N = P3 设计遗留/非 bug 观察）

| # | 现象 | 根因 → 修法 | 修复证据 |
|---|---|---|---|
| L-1 ✅ | 浏览器直连 tokenplan（aliyuncs MaaS anthropic-compat）被 CORS preflight 拦截（无 `Access-Control-Allow-Origin`）；node 侧同请求 HTTP 200 | 端点无 CORS 头 → dev 加 vite 同源代理：`app/vite.config.ts` server.proxy `/llm`；生产/Tauri 由 bridge `/llm/*` 代理并执行 token/origin 校验，前端通过 `/bridge-info` 动态发现端口与 token | [states/11-agent-stream.png](states/11-agent-stream.png)；`packaged-startup-smoke.mjs` 覆盖 bridge discovery/auth 与真实启动链路 |
| L-2 ✅ | 内核 `_cells_payload()` 上报 `sideEffect`，但 bridge `CellInfo`/`normalizeCells`（protocol.ts/router.ts）丢弃 → CellHeader/CascadeAskDialog 的 `⚡ side-effect` 徽章恒不显示（违 spec §6.2 契约） | protocol.ts `CellInfo` 补 `sideEffect?: boolean` + router.ts `normalizeCells` 保留透传 | router.test.ts（notebook.open 响应 cells 含 sideEffect=true，夹具 cell 含 to_csv）；画廊备注"05: ⚡ side-effect 徽章已显示"+ [states/05-ask-dialog.png](states/05-ask-dialog.png) 重拍 |
| L-3 ✅ | run 完成后前端不刷新 schemas → FixCard"traceback+相关 schemas 自动附着"只附 traceback（恒 0 schemas） | bridge router 在 run.done 后自动 introspect 并广播新通知 `kernel.schemas {schemas}`（protocol.ts 增 KernelSchemasParams）；app store connectBridge 增 case 写 store.schemas | [states/03-error-fixcard.png](states/03-error-fixcard.png)（按钮"修复（traceback + 1 schemas → Agent）"+ survey chip）；双端单测（bridge run.done→introspect+广播；app 通知→store.schemas） |
| L-4 ✅ | REPL 纯 exec 无 displayhook：裸表达式（`df.shape`）不回显值，需 print 才有输出 | py runtime `exec_repl` displayhook：AST 拆分，末语句 Expr → eval 并发 run.mime {cellId:'repl', mime:'text/plain', data:repr}（repr 失败降级 str；None 不发；末句异常走 run.error 不回显） | [states/07-repl.png](states/07-repl.png)（[repl] cell 出现 output 披露区）；test_runtime.py 3 例（回显/赋值不回显/末句异常 run.error） |
| O-1 | 观察（非 bug）：`# %% [cell-id: …]` 要求 8 位 hex；非 hex id（如 `w1a2b3c4`）按 spec §4 宽容降级为整文件单 cell，静默换 id。画廊夹具首版触发过 | py/novakernel/serialize.py CELL_MARKER_RE | 画廊脚本注释（scripts/demo-gallery.mjs） |
| N1 | P3.1 多 tab 设计遗留（非 bug）：后台 tab 不实时流式——非焦点内核的 run.*/kernel.status 仅刷 bridge 侧缓存，notebook.switch 时随全量 state 回灌前端；文件 watcher 仅监听焦点单路径（切 tab 时 watcher.watch 转移）；rssMB 为近似水位（pid = `uv run` 包装进程而非 python 本体，Windows 无 /proc → null） | 设计取舍：单焦点 WS 事件通道 + 单 watcher，P3.1 冻结 | bridge router.ts（多 ctx 缓存/switch 回灌注释、watcher 转移）· supervisor.ts rssMB 注释；[states/12-multi-tab.png](states/12-multi-tab.png) |
| N2 | 历史会话 .ipynb 导出仅文本输出：snapshot 的 mime 只存键名（不含图像 base64），导出历史会话时 image/png 等 mime 数据丢失；live 会话导出走富缓存含 mime（画廊 15 态即 live 导出） | exporter 数据源 = snapshot 摘要（spec §11 快照形态） | bridge exporter.test.ts · router.ipynb.test.ts；画廊脚本 15 态导出断言 |
| N3 | 交互控件值不存盘（spec §15.5 明确不做）：control.set 仅 mutate 内核内存对象，重开 notebook 值回默认；控件级联绕过 mark-only（Owner 裁决），side-effect 下游仅标 stale | spec §15.5 排期外 | [states/14-controls.png](states/14-controls.png)+[states/14b-controls-cascade.png](states/14b-controls-cascade.png)（slider 42→77 级联：下游 [2] 重跑、旧输出无残留）；py tests/test_ui_controls.py（23 例）· app controls/logic.test.ts（20 例） |
| N4 | 输出分区粒度 = 流级（stdout → stderr → traceback → mime），非逐 chunk 交错：CellOutput 为累积串形态（store/notebook.ts 为 Q 线边界外文件），单次 run 内 stdout/stderr 交替片段无法还原；参考图 [76] 的"stdout 面板+红面板相继"由流级分区等价呈现 | 前端 store 边界（Q 线所有权不含 store/notebook.ts）；如需真交错需把 CellOutput 改为 segments 数组（reducer + bridge 契约联动，另立项） | app OutputRenderer.segments.test.ts（分区顺序断言）；[states/03](states/03-error-fixcard.png)/[states/06](states/06-writes-matplotlib.png) |
