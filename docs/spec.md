# NovaLab 技术规格（Spec）

> 状态：v0.1 · 2026-10-06 · 上游文档：[intent.md](intent.md) · 下游：[plan.md](plan.md)
> 约定：本文所有协议消息、工具 schema、语义规则均为**规范（normative）**；组件命名为建议。

---

## 1. 架构总览

```
+---------------------------------------------------------------------------+
|  Tauri 桌面壳 (Rust, P1-W2 接入 / P4 打包)                                  |
|  窗口 · 文件系统对话框 · keychain ·  spawn Bridge 子进程                     |
+-------------------------------------+-------------------------------------+
                                      | spawn + env
                                      v
+---------------------------------------------------------------------------+
|  React 19 前端 (app/)  —— 浏览器先行，Tauri WebView 复用同一构建             |
|  ├─ CellList / CellEditor(CodeMirror6 + @codemirror/merge 行内 Diff)       |
|  ├─ OutputRenderer (text/html/img/table/traceback)                        |
|  ├─ KernelStatusBar + InlineREPL + LivePill                               |
|  ├─ AgentPanel (Vercel AI SDK useChat 流式 + One-click Fix 卡片)           |
|  └─ Zustand store: cells / dag / staleSet / diffs / kernelStatus          |
+-------------------------------------+-------------------------------------+
                                      | WebSocket · JSON-RPC 2.0 (ws://127.0.0.1:7788)
                                      v
+---------------------------------------------------------------------------+
|  Bridge (bridge/, node TS 独立进程)                                        |
|  ├─ RPC router（前端指令 → 内核/文件系统）                                  |
|  ├─ KernelSupervisor（spawn/health/restart py 内核子进程，1 文件 = 1 进程）  |
|  ├─ SessionLogger（.novalab/session.jsonl 追加式事件日志）                  |
|  ├─ PreviewSerializer（隐私硬截断出口：schema / head(1)）                   |
|  └─ MCP Server (stdio)：对外暴露同一工具集给外部 Agent                      |
+-------------------------------------+-------------------------------------+
                                      | stdin/stdout JSON-lines 或 loopback WS
                                      v
+---------------------------------------------------------------------------+
|  novakernel (py/, Python 子进程)  —— ADR-001 路线 B；KernelAdapter 可切 A    |
|  ├─ dag.py        AST defs/refs 提取 · 拓扑排序 · 环检测                    |
|  ├─ runtime.py    共享 globals 按拓扑 exec · 失效传播 · 级联重跑             |
|  ├─ introspect.py 变量 schema 嗅探 (type/shape/columns/dtypes/head(1))     |
|  ├─ serialize.py  marimo 兼容 .py 读写                                      |
|  └─ server.py     消息循环 · stdout/stderr/MIME 捕获 · matplotlib inline    |
+---------------------------------------------------------------------------+
```

**进程不变量**：前端永不直接碰 Python；内核永不直接碰磁盘用户文件以外的东西；**所有出进程数据（给 LLM 的）必须经过 Bridge 的 PreviewSerializer**（ADR-006 的硬保证）。

---

## 2. 启动序列

1. Tauri（或 dev 脚本）spawn `bridge`（node），监听 `127.0.0.1:7788`（端口冲突自动 +1）。
2. 前端连接 WS，发 `notebook.open {path}`。
3. Bridge 读 .py → `serialize.parse` → cells[] → spawn novakernel 子进程（uv 管理的 `.venv`，见 plan 环境清单）→ 按拓扑序**静默回放**全部 cell（恢复状态）或按配置冷启动。
4. Bridge 回 `notebook.state {cells, dag, schemas, staleSet:[]}`；前端渲染，LivePill 转 `live`。

崩溃恢复：kernel 死 → LivePill `dead` + 横幅"内核已退出，重启将按 .py 拓扑回放恢复状态"→ 一键 restart（状态可重建是反应式模型的免费红利）。

---

## 3. 仓库布局（ADR-007）

```
Notebook Agent/
├─ docs/            intent.md · spec.md · plan.md · adr/
├─ refs/            marimo/ · codemirror-merge/ · vercel-ai/   (只读参考, gitignore)
├─ app/             React 前端 (pnpm workspace pkg @novalab/app)
│  └─ src/{components,kernel,agent,bridge,store,styles}
├─ bridge/          node TS 进程 (@novalab/bridge)
│  └─ src/{main,protocol,rpc,kernel-supervisor,session-log,preview,mcp}
├─ py/              novakernel Python 包 (uv)
│  ├─ novakernel/{dag,runtime,introspect,serialize,server}.py
│  └─ tests/
└─ pnpm-workspace.yaml
```

---

## 4. 文档模型与文件格式（M2）

主存储 = **自定 cell marker 格式**的纯 .py（原声称"marimo 兼容子集"，S1 侦察后修正）：

```python
# /// script
# requires-python = ">=3.11"
# dependencies = ["pandas", "matplotlib"]
# ///
# [novalab] width=compact | app_view=false | kernel_python="3.13"

import marimo_compatible_cell_marker  # 不：实际格式如下

# %% [cell-id: 8f3a2c]
import pandas as pd
df = pd.read_csv("data.csv")

# %% [cell-id: b19d04]
df.groupby("county").sum()
```

规则：
- 每 cell 一个 `# %% [cell-id: <8hex>]` 块；id 稳定、git-merge 友好（冲突粒度 = cell）。
- 文件头 PEP 723 script 块 + `# [novalab]` 配置行（未知键忽略，前向兼容）。
- **UI 状态（折叠、滚动、segment 命名）不进 .py**，存 sidecar `.novalab/ui.json`；执行事件存 `.novalab/session.jsonl`（ADR-002）。
- 解析器对"手写的不规范 .py"宽容降级：无 marker 的单文件 = 按空行启发式切分或整体单 cell（导入 marimo 文件时同理）。

**互操作修正（S1 侦察，2026-10-06，证据见 docs/spike-s1-memo.md）**：真 marimo .py 为 `@app.cell` 装饰器式、文件内无 cell id（运行时 4 字母重发），不能直读我们的 `# %% [cell-id]` 格式；marimo → NovaLab 为单向宽容导入（整文件单 cell 或启发式切分），NovaLab → marimo 经转换器（plan P3.6，2–4 人日，jupytext 作参考实现）。"兼容"卖点降级为"纯 .py、git 友好、可转换"。

---

## 5. 反应式内核语义（M1，规范）

定义（per kernel 进程）：
- `defs(c)` = cell c 顶层绑定/导入/`del` 的名字集合（AST：Assign/AnnAssign/AugAssign/For/With/Import/FunctionDef/ClassDef/match-as）。
- `refs(c)` = 顶层读取的名字 − 本 cell 局部先绑定的名字（保守近似：comprehension/lambda 作用域按 Python 语义处理）。
- 边：`c1 → c2` 当 `refs(c2) ∩ defs(c1) ≠ ∅`。**多重定义同一名字 = 编译错误**（marimo 规则；Agent Reactive Rulebook 同源约束）。
- 环检测：Kahn 拓扑排序失败 → 报错并高亮环上 cell，拒绝运行。

失效与执行：
- 编辑 c：`staleSet := 传递闭包(下游(c))`，UI 灰色 `stale` 徽章；**不自动运行**（科研场景副作用昂贵：API 调用、写文件）。
- 运行 c：exec c → 成功后按 `StalePolicy`（见 §9 钩子）处理 `下游(c) ∩ staleSet`：`auto-cascade`（拓扑序重跑，流式推送每格结果）| `mark-only`。**Owner 裁决（2026-10-06）：默认 `mark-only`**（`app/src/kernel/stalePolicy.ts` 已实现）；auto-cascade / ask 作为 P2 设置面板开关保留。
- exec 模型：单一共享 `globals` dict；运行 c 前**删除 c 的旧 defs 中不再被新代码定义的名字**，并重算下游——避免"改名后旧变量幽灵存活"（Jupyter 经典病）。
- 删除 c：其 defs 从 globals 移除 → 下游 stale + Bridge 提示"以下名字将未定义：…"。
- 副作用 cell（检测到 `open(...,'w')` / `requests.post` / `to_csv` 等启发式名单）默认**不进入 auto-cascade**，标 `side-effect` 徽章需手动确认（防重跑刷爆配额/重复写文件）。

introspect（M5 数据源）：对 globals 每名字产出
`{name, type, shape?, columns?+dtypes?, len?, preview: head(1).to_dict() | repr 截断 200 字符}`；
仅存内核内存，**仅经 Bridge PreviewSerializer 出进程**。

---

## 6. 通信协议

### 6.1 前端 ↔ Bridge（WS, JSON-RPC 2.0）

| method | 方向 | payload 摘要 |
|---|---|---|
| `notebook.open` | req | `{path}` |
| `notebook.state` | res | `{cells, dagEdges, schemas, staleSet, execCounts}` |
| `cell.save` | req | `{cellId, code}` → 重算 DAG → res `{dagEdges, staleSet, compileError?}` |
| `cell.run` | req | `{cellId, cascade: bool?}` |
| `run.started / run.stdout / run.stderr / run.mime / run.done / run.error` | notif | 流式；`run.done{cellId, execCount, cascaded:[ids], durationMs}`；`run.error{cellId, traceback, frames:[{file,line,fn,srcLine}]}` |
| `kernel.status` | notif | `{state: idle|busy|restarting|dead, queueDepth}` |
| `kernel.vars` | req/res | schemas 全量（本地 UI 用，不经截断——本地可信） |
| `kernel.repl` | req | `{code}` → 输出回灌为匿名 cell（`[repl]` 徽章） |
| `diff.stage/accept/reject` | req | 见 §9 |
| `session.tail` | req/res | 最近 N 条事件（SessionView, P3） |
| `export.ipynb` | req | `{path, target}` |

### 6.2 Bridge ↔ novakernel（子进程 stdout JSON-lines；P1.3 集成后冻结）
kernel 进程只说"执行语"，不含 diff 概念。方法与结果形状：
- `ping` → `{pong, version}`；**内核单线程同步，exec 期间无法应答；supervisor 仅 idle 时健康探测**
- `load_file {path}` → NotebookState `{cells:[{id,code,defs,refs,sideEffect}], dagEdges, schemas, staleSet, execCounts}`
- `save_file {path, cells}` → `{ok}`
- `set_cells {cells:[{id,code}]}` → `{cells(重算含 defs/refs/sideEffect), edges, staleSet, compileError?}`
- `exec_cell {cellId, cascade}` / `exec_repl {code}` → RunReport `{cellId, ok, cascaded, durationMs, traceback?}`
- `introspect {}` → `{schemas}`；`shutdown` → `{ok}`
通知：`run.started {cellId}` / `run.stdout {cellId,text}` / `run.stderr {cellId,text}` / `run.mime {cellId,mime,data}` / `run.error {cellId,traceback,frames}` / `run.done {cellId,execCount,cascaded,durationMs,defs,refs}`；repl 的 cellId 恒为 `"repl"`。
错误码：`-32000` 内核内部、`-32001` 未打开 notebook。

### 6.3 外部 Agent ↔ Bridge（MCP over stdio，ADR-003）
工具集见 §7；resource：`novalab://notebook/dag`、`novalab://cell/{id}`。外部 Agent 的 `propose_code_change` 同样只产生 staged diff（前端弹审阅），**不存在特权写入通道**。

---

## 7. Agent 工具集（规范 schema）

方案书 4 核心 + 2 只读辅助。zod schema 单一来源在 `bridge/src/mcp/tools.ts`，前端 in-process 工具与 MCP server 共用同一 execute 实现。

1. `get_notebook_context()` → `{dagEdges, schemas, focusCellId, staleSet}`（**无原始数据**）。
2. `get_cell_output(cellId)` → 最近一次 `{stdout, stderr, traceback, mimeKeys}`（截断 8KB）。
3. `propose_code_change(targetCellId, action: update|insert_below, newCode, rationale)` → staged diff id；**禁止直接覆盖**（system prompt + 工具层双保险）。
4. `execute_cell(cellId, cascade?)` → run 报告（含 cascaded ids 与每格成败）。
5. `list_cells()` → `[{id, execCount, status, firstLine, defs, refs}]`。
6. `get_cell_code(cellId)` → 源码原文。

Agent system prompt 注入 **Reactive Rulebook**（intent 风险章）：单赋值、禁重定义已有全局名、倾向函数式与新名字；Bridge 在 `propose_code_change` 入口做轻量 AST 校验（多重定义 → 拒绝并回 reason，让模型自纠）。

---

## 8. 隐私边界（M5 / ADR-006）

出进程白名单（唯一出口 `bridge/src/preview/serializer.ts`）：代码文本、traceback、DAG 边、schema 元信息、`head(1)`/repr≤200 字符预览、用户显式 attach 的文本。
黑名单硬截断：任何 >4KB 的字符串字段、DataFrame 全量、二进制、文件内容（除非用户显式 attach）。
UI：AgentPanel 顶部常驻 chip `context: 3 schemas · 1 traceback · 0 rows sent`，点击展开本次请求实际 payload 预览（可审计）。

---

## 9. Diff 审阅 UX 状态机（M4）

```
proposed ──(Tab / 点击 Accept)──> accepted ──> cell.save + 按策略 run
   │                                        (auto-cascade 见下)
   ├─(Esc / Reject)──> rejected (留痕于 session.jsonl, 供 Agent 学习拒绝率)
   └─(用户手改 diff 内任一行)──> edited-staged (重新进入 proposed, 标注 user-edited)
```
- 渲染：CodeMirror `@codemirror/merge` 的 `MergeView` 内嵌模式——原码灰底、新码绿底、删除行红底条纹；逐 hunk `✓/×` 与整格采纳两级粒度。
- **策略钩子（留给Owner的首个代码贡献点）**：`app/src/kernel/stalePolicy.ts → decideStalePolicy(ctx)` 决定 accepted 后与上游重跑后的下游处理（auto-cascade / mark-only / 副作用 cell 询问）。trade-off 见文件内注释。
- 多 diff 队列：Agent 一次提议多格 → 顶部 diff 托盘 `3 pending`，`Tab` 顺序推进，`Esc Esc` 全拒。

---

## 10. 前端组件树与视觉规格

```
<App>
├─ <TabBar>            文件/内核 tab + <LivePill state>
├─ <CellList virtualized>
│   └─ <Cell>
│       ├─ <CellHeader> [execCount] lang-chip stale-badge side-effect-badge ⋯menu
│       ├─ <CellEditor> CM6 (+ <InlineDiffOverlay> when staged)
│       └─ <OutputDisclosure> ▶ output → <OutputRenderer mime-bundle>
├─ <KernelStatusBar>   "Python kernel · shared with the agent" | drag-handle | idle
├─ <InlineREPL>        >>> run code in this kernel…
└─ <AgentPanel right>  <ContextChip/> <ChatStream/> <FixCard traceback+schema+Apply/>
    └─ <SessionModal>  (P3) segments 折叠分组 + export .ipynb
```

视觉 tokens（clean-room，ADR-004）：暗色底 `#0b0b0c` 系、面板 `#141416`、边框 1px `#26262a`、等宽 `JetBrains Mono / ui-monospace`、正文 UI sans；圆角 6-8px；无阴影渐变；状态色：run=amber、ok=green、err=red、stale=grey、diff-add=`#1f3b2a`/diff-del=`#3b1f24`。亮色主题 P4。

**附录 A：Claude Science 复刻核对清单**——见 [intent.md §4 表](intent.md)（10 项元素 → 组件映射 → 阶段），验收时逐项对照截图勾核。

**附录 A-2：第二批参考细节（2026-10-06 增补六图）**

| # | 参考图细节 | 我们的对应 | 阶段 |
|---|---|---|---|
| 11 | 错误 cell：语言 chip 旁 `error (line N)` 红徽章 + **编辑器内出错源码行红底高亮** | CellHeader 徽章 + CellEditor 行装饰（traceback.frames[0].line） | P2.9（K 线） |
| 12 | 会话结束态：footer `Python · ended 15:14 — view only; this kernel's namespace no longer exists`；`Ended HH:MM` pill 下拉 = 历史会话列表（N cells · read-only），点击进入只读浏览 | SessionBar + 只读模式（CM6 read-only + 运行禁用） | P2.8（J 线） |
| 13 | 左 pill 下拉 = 命名会话/Agent 切换器（名称 + cell 数 + 来源标签如 `· Claude Science`） | SessionBar 切换器（当前 + 历史 + 来源标签） | P2.8 |
| 14 | 截断横幅 `First 500 cells shown — full log in the session notebook's .ipynb download` | 只读会话视图 >500 cell 时横幅 + 导出入口 | P2.8 |
| 15 | 输出下 `wrote <绝对路径…>` 文件写入通知行 | 内核 sys.addaudithook('open') 写模式钩子 → run.notify → OutputRenderer 通知行 | P2.9（K 线） |
| 16 | footer 右侧 cell 计数（`19 cells` / `34 cells`） | KernelStatusBar 右侧 | P2.8 |
| 17 | 富 MIME：matplotlib 多图/中文/对数坐标图 inline | matplotlib 已入 venv；run.mime image/png 链路 P2.9 验证 | P2.9 |
| 18 | 命名内核 tab（`Python — geo`）ended 后 view-only | 与 S1/P3.1 多 tab 合并：tab 携带 ended 状态 | P3.1 |

**附录 A-3：第三批参考细节（2026-10-07 增补五图，Q 线）**

| # | 参考图细节 | 我们的对应 | 阶段 |
|---|---|---|---|
| 19 | **JetBrains Mono 全字体**（Owner 指定） | @fontsource/jetbrains-mono 打包（离线可用），styles.css 落实 400/500/700 | Q 线 |
| 20 | stderr/traceback/RuntimeWarning = **红左框+红字面板**，与 stdout 中性面板分离 | OutputRenderer 分区渲染 | Q 线 |
| 21 | 代码区右上**复制按钮**（clipboard 图标） | CellEditor overlay + SessionModal 同 | Q 线 |
| 22 | 长输出**内部滚动**（max-height + overflow-y，输出面板圆角细边框） | OutputRenderer | Q 线 |
| 23 | 顶栏**`Files \| Notebook` 分段视图切换** + 左工作区标题 + 右图标组 | ViewSwitcher；Files = 全幅文件视图（复用树组件） | Q 线 |
| 24 | 会话模态内**完整 cell 卡**：代码+输出+红行+复制钮+右对齐内核名+`wrote` 行 | SessionModal 行渲染升级 | Q 线 |

---

## 11. Session 日志与导出（S2, P3）

`.novalab/session.jsonl` 事件：`{ts, kind: run|error|diff_proposed|diff_accepted|diff_rejected|repl|agent_msg, actor: user|agent, cellId, payloadRef}`。
SessionModal = 该日志 + 当前 cells 的只读投影（segments = 按 >30min 间隔或显式命名切分）。
导出 .ipynb：cells→nbformat 4.5（output 取最近一次 MIME bundle）；导入 .ipynb：一次性转换生成 .py（输出丢弃、`%magic` 降级为注释警告）。

---

## 12. 错误处理

- 内核编译错（DAG 环/多重定义）：保存即报，cell 红框 + 原因行内提示，不进运行队列。
- 运行期异常：traceback 结构化（frames 带 srcLine）→ 存 cell + 触发 FixCard；内核进程存活（exec 隔离在 try/except，globals 不回滚但失败 cell 的 defs 不更新）。
- 内核进程死：§2 崩溃恢复；session.jsonl 保证审计连续。
- Bridge 死：Tauri watchdog 重启 + 前端重连带 session resume id。
- LLM  provider 错/离线：AgentPanel 降级横幅；**notebook 全部本地功能不受影响**（M6 脱网承诺）。

---

## 13. 非功能需求

冷启动<3s（Tauri+bridge+kernel spawn+回放 100 cell）；cell 附加开销<50ms；100 cell 60fps（虚拟化列表，CM6 视口外实例销毁重建）；bridge RSS<150MB；kernel RSS 不设限（用户数据）；WS 消息批量化（stdout 流 16ms coalesce）。

## 14. 测试策略

- py：pytest——dag 提取黄金集（含 comprehension/walrus/match 边角）、失效传递性、幽灵变量删除、serialize 往返（marimo 文件互操作样本放 `py/tests/fixtures/`，取自 refs/marimo 示例）。
- bridge：vitest——protocol 契约（TS/py 共享 JSON fixtures）、PreviewSerializer 截断断言（>4KB 必截）、MCP 工具 schema 快照。
- app：vitest+RTL——Diff 状态机（Tab/Esc/edited-staged）、stale 徽章派生；playwright e2e——intent §8 演示脚本全自动跑通。

---

## 15. 交互控件协议（P3.3）

> **Owner 裁决（2026-10-07）：同意控件级联绕过 mark-only 默认**——§15.3 第一条为最终语义。

目标：marimo `mo.ui` 风格的原生交互控件（slider / checkbox / text / date / table 选择），绑定即反应式重跑；同时是 P4.2 App View 的骨架。

### 15.1 内核侧（py/novakernel/ui.py，新模块）

- 控件工厂：`nk.ui.slider(start, stop, step?, value?, label?)`、`checkbox(value?)`、`text(value?)`、`date(value?)`、`table(df, selection?)`——返回 `Control` 实例（`.value` 属性为当前值）。
- `Control` 是**活对象**：驻留 cell 的 defs；内核持有 registry `{controlId: Control}`，controlId = `<cellId>::<变量名>`。
- cell 重跑 = 控件重建（值回 spec 默认；旧 controlId 注销）——简单可预测，文档声明。

### 15.2 渲染通道（复用 run.mime，不新增通知）

- cell 收尾表达式或显式 `control` 变量 → run.mime `application/vnd.novalab.control+json`：
  `{controlId, kind, spec:{...}, value}`；前端 `ControlRenderer` 按 kind 渲染交互部件（components/controls/，暗色 tokens）。
- 非收尾用法（控件赋值给变量但 cell 尾不返回）也发送：exec 后扫描本 cell 新 defs 中的 Control 实例统一上报（与 matplotlib figure 捕获同模式）。

### 15.3 值回传与级联语义（关键决策）

- 前端交互 → `control.set {controlId, value}`（bridge → 内核）：内核 mutate `Control.value`，**不发 run.mime 重绘**（前端已乐观更新），然后：
  - 下游传递闭包**自动级联重跑**——控件交互是显式用户意图，**绕过 mark-only 默认**（StalePolicy 仅约束代码编辑触发的级联）；
  - 例外：side-effect 下游 cell 不自动跑，标 stale + ⚡（与 cascade 开关 ask 档共用确认窗）；
  - `cascade: auto|mark-only` 设置对控件无效（文档声明），避免"拖 slider 没反应"的反直觉。
- 节流：slider 拖动按 80ms coalesce 发 control.set（bridge 侧），表格选择/checkbox 即时。

### 15.4 隐私与 Agent

- 控件值进入 schema（type=`Control[slider]`，value 过 PreviewSerializer）；Agent 可读值、**不可设值**（无 control.set 工具——写通道仅人类 UI）。
- App View（P4.2）= 隐藏代码区 + 仅渲染控件与输出，协议零改动。

### 15.5 不做（本阶段）

- 控件持久化进 .py（值不存盘，重开回默认）；跨 cell 共享同一 Control 实例（一 cell 一实例）；自定义控件 API。
