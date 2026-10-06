# Spike S1 Memo：marimo 后端复用（路线 A）可行性侦察

> 状态：**完成** · 2026-10-06 · 工作线：S1（plan.md §1）· 下游：[adr/001-kernel-route.md](adr/001-kernel-route.md)
> 侦察对象：`refs/marimo`（shallow clone，HEAD `5211139`，版本 **0.25.1**，pyproject.toml:7；git 历史仅 1 commit，历史变动频率结论以当前代码 + CI 配置为准）
> 纪律：只读侦察；所有证据为 path:line（相对 `refs/marimo/`）。三路并行侦察（协议面 / 稳定性+无头 / 格式+许可证）+ 主线直接验证交叉核对。
> 注：**S2（py/novakernel 原型）由并行工作线开发中，其测试结果待补**——本 memo 不等待；G1 决策时以 S2 黄金集结果为准。

## TL;DR

1. **路线 A 技术可行，但"说它的 WebSocket 协议"这个表述已过时**：0.25.1 的命令面（前端→后端）**全部是 HTTP POST**（`Marimo-Session-Id` 头路由），WS `/ws` 只做内核→前端**单向推送**（43 种 op，`{"op","data"}` 帧）；WS 入站文本仅当断连信号丢弃（ws_message_loop.py:147-151）。协议面总量 ≈ **100 个 HTTP 端点 + 43 个推送 op + 29 种内核命令 + 3 个 WS 端点（会话/RTC/终端）+ 1 个 SSE 替代传输**。
2. **稳定性双刃**：有完整的 msgspec→OpenAPI→TS 生成式类型流水线 + CI breaking-change 门禁（openapi-diff `--fail-on-incompatible`）；但**无 semver/稳定性承诺、无 CHANGELOG、全模块下划线私有、无版本协商**——marimo 的设计假设是"前后端永远同版本，漂移即整页 reload"（skew-protection token 机制）。0.x 高频 minor 演进；事实上命令面已经历过一次整体迁移（旧双向 WS op 全部改为 REST）。
3. **最小适配子集** ≈ 10 个 HTTP 端点 + 13 个推送 op，可复用其 api.yaml 生成 TS 客户端；适配层核心 **500–1500 行 TS**，路线 A 全量适配（含 Bridge MarimoAdapter、握手/认证、会话生命周期、契约测试）估 **12–20 人日** + 每次 minor 升级 2–4 人日维护税。
4. **重大发现：spec §4 声明的"marimo 兼容子集"不成立**。真 marimo 磁盘格式是 `@app.cell` 装饰器 + `def _(refs): ... return (defs,)` 函数体，**文件里不存任何 cell id**；我们的 `# %% [cell-id: 8hex]` + `# [novalab] ...` 是 percent 脚本风格，marimo 不能直接打开，只能经 `marimo convert`（jupytext）**单向导入且重发全部 id**。互操作 = 双向转换器（~2–4 人日），不是格式兼容。这同时削弱路线 A 的"格式天然兼容"卖点。
5. 无头路径中 `App.embed()` 不可用（仅限 marimo kernel 内部）、`create_asgi_app` 仅只读 RUN 模式——路线 A 唯一可行形态就是**当 marimo 协议的第二客户端**（REST + 最小 op 集 WS 订阅）。
6. 许可证：Apache-2.0 全文、**无 NOTICE 文件**、CLA 版权归 Marimo Inc。协议级集成（进程隔离）无开源义务外溢；vendor 片段需保留声明+标注修改；读码自研走 clean-room 纪律（含测试用例形状也要保守）。

---

## Q1 协议面：WS/HTTP 操作类型清单

### 1.1 连接拓扑与握手

| 通道 | 注册处 | 性质 |
|---|---|---|
| `WS /ws`（会话） | ws_endpoint.py:62 | 内核→前端单向推送；query 参数路由：`session_id`/`file`/`kiosk`（ws_connection_validator.py:19-21,47-96） |
| `GET /sse`（实验） | ws_endpoint.py:113 | `/ws` 的 SSE 等价替代（`server.transport="sse"`），同帧格式；控制仍走 HTTP |
| `WS /ws_sync`（实验 RTC） | ws_endpoint.py:162 | Loro CRDT 二进制帧（ws_rtc_handler.py:86-141）；`experimental.rtc_v2` 开关 |
| `WS /terminal/ws` | terminal.py:374 | 明文 PTY 双向 + resize JSON（terminal.py:266-345）；**Windows 不可用**（supports_terminal: terminal.py:361-371） |

握手序列（第三方客户端视角）：
1. **session_id 由客户端自生成**（`s_`+6 位 cuid2；frontend/src/core/kernel/session.ts:12-16），无需先抓页面。
2. **auth**：`access_token`（query/表单/Bearer/签名 cookie 四式，auth.py:30-69）；edit 模式默认随机 token（token_manager.py:33-52），认证后可 `GET /auth/token`（login.py:157）。
3. **skew protection**：所有 POST 须带 `Marimo-Server-Token` 头（middleware.py:111-172；豁免 /auth/login、/api/kernel/execute、/ws*）；token 注入 index HTML（_templates.py:329 `{{ server_token }}`）——第三方客户端要么从 HTML 提取，要么启动时关（CLI 有 skew_protection 开关 cli.py:466-468 等；`create_asgi_app` 默认 False，asgi.py:359）。
4. 连 `WS {base}/ws?session_id=...&file=<路径>`；服务端按 5 种连接类型接入（NEW/RECONNECT/RESUME/KIOSK/RTC_EXISTING，ws_session_connector.py:31-38,86-133），首推 `kernel-ready`（含全部 cellIds/codes/names/configs/layout，notification.py:420-453）。
5. EDIT 模式再 `POST /api/kernel/instantiate`（execution.py:139；body `{objectIds:[],values:[],autoRun:true,codes?}`，requests.py:11-28）；RUN 模式服务端自动 instantiate（ws_session_connector.py:233-273）。
6. 所有会话作用域 HTTP 请求带 `Marimo-Session-Id` 头（deps.py:135-145，缺失即 400）。

### 1.2 前端→后端（命令面 = HTTP POST；WS 入站 = 0 种消息）

传输层命令 union：29 种（msgspec tag union，commands.py:945-986；命令类共 31 个，commands.py:207-944）。HTTP 请求模型：models.py（358 行）+ requests.py（28 行）。代表性端点（全部 path:line 见 1.4）：

| 操作 | 端点 | 证据 |
|---|---|---|
| 执行 cell（含注册新 cell+代码） | `POST /api/kernel/run` `{cellIds[],codes[]}` | execution.py:232；models.py:265-278 |
| 初始化/回放 | `POST /api/kernel/instantiate` | execution.py:139 |
| 中断 | `POST /api/kernel/interrupt` | execution.py:205 |
| UI 元素赋值（触发反应式重跑） | `POST /api/kernel/set_ui_element_value` | execution.py:67 |
| 函数 RPC | `POST /api/kernel/function_call` | execution.py:176 |
| 编辑文档结构（增删移改 cell，7 种 tagged 变更） | `POST /api/document/transaction` | document.py:29；changes.py:18-116 |
| 保存 notebook | `POST /api/kernel/save`（4 等长数组+filename+layout） | files.py:152；models.py:287-313 |
| REPL/草稿 | `POST /api/kernel/scratchpad/run` | execution.py:421 |
| 重启/关闭/状态 | `restart_session` / `shutdown` / `GET status` | execution.py:508/552/271 |

### 1.3 后端→前端（推送面 = 43 种 op）

线格式 `{"op":"<name>","data":{...}}`（ws_formatter.py:18-30；WS/SSE 共用）。权威清单 = `NotificationMessage` union（notification.py:1088-1146），43 个成员，按用途：

- **内核控制/执行（~12）**：`kernel-ready`(:420)、`cell-op`(:87，含 output/console/status/**stale_inputs**/serialization)、`completed-run`(:333)、`interrupted`(:327)、`variables`(:701，name/declaredBy/usedBy 即 DAG)、`variable-values`(:712，name/value/datatype)、`function-call-result`(:153)、`remove-ui-elements`(:175)、`send-ui-element-message`(:188)、`model-lifecycle`(:291，anywidget comm 子 tag open/update/custom/close :236-284)、`consumer-capabilities`(:409)、`completion-result`(:456)
- **生命周期/告警（~10）**：`reconnected`(:607)、`reload`(:667)、`alert`(:471)、`banner`(:626)、`missing-package-alert`(:486)、`environment-state`(:579)、`environment-operation`(:587，子状态 running/succeeded/restart-required/failed/cancelled :522-544)、`startup-logs`(:613)、`startup-progress`(:643)、`kernel-startup-error`(:656)
- **数据/SQL/存储（~11）**：`datasets`(:723)、`data-column-preview`(:822)、`sql-table-preview`(:768)、`sql-table-list-preview`(:785)、`sql-schema-list-preview`(:839)、`data-source-connections`(:858)、`data-source-discovery-result`(:871)、`validate-sql-result`(:942)、`storage-namespaces`(:886)、`storage-entries`(:897)、`storage-download-ready`(:920)
- **其他（~10）**：query-params-set/append/delete/clear(:959-998)、`focus-cell`(:1004)、`active-line`(:1015)、`secret-keys-result`(:1032)、`cache-cleared`(:1045)、`cache-info`(:1056)、`notebook-document-transaction`(:1075)

输出载荷 `CellOutput{channel: output|stdout|stderr|media|stdin, mimetype, data, timestamp}`（cell_output.py:17-85；错误为 `application/vnd.marimo+error` :85）。

### 1.4 HTTP 端点全量（~100 路由；OpenAPI 收录 92 路径/303 schema，api.yaml 8417 行）

路由注册 router.py:41-90。分组（前缀 → 文件:行区间）：`/api/kernel` 执行 execution.py（14 端点，:67-603）；`/api/kernel` 编辑 editing.py（7，:39-224）；`/api/kernel` 文件 files.py（5，:45-261）；配置 config.py:41；`/api/document` document.py:29；`/api/files` 文件浏览器 file_explorer.py（11，:82-429）；cache.py（2）；datasources.py（6）；sql.py:19；storage.py（2）；ai.py（6，:112-526）；packages.py（7，:56-424）；secrets.py（3）；export.py（12，:117-769）；home.py（5，:47-259）；login.py（3，:77-157）；lsp.py（2，另有 LSP WS 代理 main.py:137-148）；health.py（8，:40-386）；documentation.py:25；assets.py（6，静态/前端页）。

### 1.5 分类汇总

| 类别 | HTTP 端点 | WS 推送 op | WS 端点 | 备注 |
|---|---|---|---|---|
| 内核控制 | ~22（execution 14 + editing 7 + document 1） | ~12 | — | 命令 29 种大多在此 |
| 文件读写 | ~18（files 5 + file_explorer 11 + save_app_config + document） | 2（notebook-document-transaction、reload） | — | |
| 终端 | 0 | 0 | 1（/terminal/ws，2 种非正式消息） | **Windows 不可用**（terminal.py:361-371） |
| 其他（AI/SQL/datasources/packages/LSP/export/home/login/secrets/storage/cache/health/assets） | ~59 | ~29 | 1（/ws_sync RTC，实验） | NovaLab 全部不需要 |
| **合计** | **~100** | **43** | **3 + 1 SSE** | 消息类型总数 ≈ **170+**（含命令 union 29） |

## Q2 协议稳定性信号

**正面信号**：
- 前后端**同仓库、单一版本号、同 wheel 发布**：pyproject.toml:7（0.25.1）；frontend/package.json:3 平时占位 `0.0.0-placeholder`，发布 CI 同步为 python 版本（release-prod.yml:63-72）；前端构建产物打进 wheel（MANIFEST.in:1 `marimo/_static`；buildfrontend.sh；assets.py:58-59 运行时伺服）。**耦合度 = 完全**：pip install marimo 即带同版本前端。
- **生成式类型全流水线**：msgspec 模型（~200 个，MODELS 清单 commands.py:252-483）→ `marimo development openapi` 导出 OpenAPI 3.1（_cli/development/commands.py:219,486-505；Makefile:121-126）→ `packages/openapi/api.yaml`（8417 行）→ openapi-typescript → `@marimo-team/marimo-api`（api.ts 7922 行）→ 前端类型全部来自它（frontend/src/core/kernel/messages.ts:2-4；REST 客户端 createMarimoClient = openapi-fetch）。另有 wire 消息独立 JSON schema：`marimo/_schemas/generated/{session,notebook,notifications}.yaml`（scripts/generate_schemas.py）。
- **CI breaking-change 门禁**：test_schemas.yaml:116 对 5 份 schema 跑 openapi-diff `--fail-on-incompatible`，破坏即 fail PR（:120-129）。

**负面信号**：
- **无任何书面稳定性/semver 承诺**：全仓 md 检索 `semver|backward-compat|stability` 零命中；无 CHANGELOG.md（release notes 由 commit 生成）。
- 服务端全部为**下划线私有模块**（`_server/_messaging/_runtime`）；公开 API 面只有 `marimo/__init__.py:31-35`（App、create_asgi_app、MarimoIslandGenerator）。
- **无协议版本协商**：WS 消息无版本字段（ws_connection_validator.py:25-33 只解析 session_id/file/kiosk）；版本不匹配的对策是 skew token 401 + `reload` 通知整页刷新（middleware.py:112-172；notification.py:667）——设计假设"前后端永远同版本"。
- schema 之外的**手工镜像面**：WS close code/reason 前端手抄（codes.py:15-21 注释明说）、kiosk 过滤集合（ws_message_loop.py:26-59）、query 参数语义、RTC 实验通道。
- CI 门禁基线 = main 分支本身：**故意的破坏性变更会合入并重置基线**；0.x 阶段 minor 即可含协议破坏。
- 事实上已发生过协议形态级重构：本版本命令面全在 REST、WS 入站清零（§1.1），旧式双向 WS op（instantiate/run/stop_session/write_code_cell/... 作为 WS 消息）在现行协议中已不存在。

**结论**：偶然性破坏概率低（类型生成+CI 门禁），**演进速率高、无兼容承诺**。第三方前端跟随主干 = 每个 minor 重新生成类型 + 跑 diff + 回归；锁版本可控，但维护税持续存在。plan §7"marimo 协议漂移（中概率/高影响）"的风险评级**成立**。

## Q3 嵌入式/无头使用路径

| 路径 | 证据 | 性质与限制 |
|---|---|---|
| `marimo edit/run` | cli.py:452/:1142；`--headless` 仅"不开浏览器"（cli.py:1004） | 完整 server + 自有前端照常伺服；run=只读会话（_session/model.py:19-25）。**不是** headless API server |
| `create_asgi_app()` | asgi.py:354-401；`marimo/__init__.py:34` 公开导出；docs/guides/deploying/programmatically.md | **仅 RUN 只读模式**（asgi.py:358 docstring 明言）；kernel 跑在同进程子线程、需粘性会话、不可水平扩展（programmatically.md:181-191）。不满足编辑器需求 |
| `App.run(defs)` | app.py:662 | 公开 API，一次性批执行，返回 (outputs, defs)；无增量输出/交互回路 |
| `App.embed()` | app.py:840-925；返回 AppEmbedResult{output,defs}（app.py:202-205） | **只能在 marimo kernel 内调用**（kernel_runner.py:79-81 无 KernelRuntimeContext 直接 RuntimeError）；"marimo 嵌 marimo"，不能作外部驱动 API |
| 直接驱动 `Kernel`/`SessionImpl` | runtime.py:498-522；无头样板 `_export/file.py:600 run_notebook()`（:607-661 自定义 SessionConsumer） | 技术可行的事实路径，但全私有、无契约；需自实现 streams 消费者 + control-request 泵 |
| Islands（Web Component） | _islands/_island_generator.py:239；npm `@marimo-team/islands`（release-prod.yml:82-99）；docs/guides/island_example.md:33-35 自述 "early feature / not stable" | Python 生成静态 HTML + 浏览器 Pyodide worker 执行；适合发布/文档嵌入，不适合做后端引擎 |
| WASM | frontend/src/core/wasm/（bridge.ts 内存实现整套传输面）；`marimo export html-wasm`（_cli/export/commands.py:1044） | **完整前端的浏览器版**，非可复用 runtime 库；传输抽象良好（useWebSocket.tsx:22-27 ws/sse/pyodide 三态同协议） |

**结论**：不存在"只跑 runtime 不带前端"的官方受支持路径。路线 A 唯一可行形态 = 启动完整 marimo server（edit 模式），NovaLab 前端/Bridge **当它的第二个客户端**：REST 命令面 + `/ws` 最小 op 集订阅。若要瘦身，可参考 `run_notebook()` 样板直接驱动 SessionImpl（私有 API，风险自担）。

## Q4 替换前端的最小消息子集与适配层量级

目标能力：打开 .py → 执行 cell → 收输出（含 stdout/stderr/MIME/traceback）→ 拿变量/DAG → 编辑 cell 并保持反应式。

**必实现 HTTP（~10）**：`instantiate`、`run`、`interrupt`、`set_ui_element_value`（有 mo.ui 才需）、`function_call`（UI on_change）、`save`（持久化）、`document/transaction`（结构化编辑，7 种变更 tag：create/delete/move/reorder/set-code/set-name/set-config，changes.py:18-96）、`stdin`（input() 场景）、`restart_session`/`shutdown`、`GET status`。全部浅层 camelCase JSON。

**必消费 WS op（~13）**：`kernel-ready`（初始 cells 全量）、`cell-op`（**核心**：output/console/status/stale_inputs）、`variables` + `variable-values`（每次执行后自动推，无需请求——DAG 边与变量表免费拿，hooks_post_execution.py:124-142）、`completed-run`、`interrupted`、`reconnected`、`reload`、`alert`/`banner`/`kernel-startup-error`、（用 UI 时）`remove-ui-elements`/`function-call-result`。

**量级**：请求模型 ~10 + 推送模型 ~12（对照全协议 303 schema）。适配层核心 **500–1500 行 TS**（WS 客户端参照 frontend/src/core/websocket/transports/ws.ts <100 行；HTTP 面可直接用 api.yaml + openapi-fetch 生成，零手写模型）；最大头是 CellOutput MIME bundle → 我们 OutputRenderer 的映射（text/html/img/json/error，只支持核心 MIME 可控制在 200–400 行）。

**语义映射与缺口**（Bridge MarimoAdapter 层）：
- `mark-only` stale 策略：marimo 有全局配置 `runtime.on_cell_change: lazy|autorun`（config.py:146,185,808，默认 autorun）——**lazy ≈ mark-only**（cell-op.stale_inputs 标记、不自动重跑），可经文件级 PEP 723 `[tool.marimo.runtime]` 或 .marimo.toml 配置；但 ask 模式与"副作用 cell 名单"无对应物，需 Bridge 侧模拟。
- REPL：`scratchpad/run`（execution.py:421）现成。
- introspect：`variables`/`variable-values`/`datasets` 给到 name/type/declaredBy/usedBy/value 级预览，但我们 spec §5 的 head(1)+dtypes schema 嗅探需在 notebook 内注入辅助函数绕行（PreviewSerializer 仍可在 Bridge 侧生效）。
- 幽灵变量删除、多重定义拒绝、环检测：marimo 内建（其编译期语义），A 路线免费。
- 多内核（P3.1）：N 个 marimo server 进程（每个含 uvicorn+LSP+file manager），比瘦内核重一个量级。

## Q5 .py 序列化格式确认（对照 spec §4）

**序列化实现**：写 = `_ast/codegen.py:566-610 generate_filecontents`（IR 入口 :509-533；cell 级 :302-391 `to_functiondef`）；读 = `_ast/parse.py:1077-1177 parse_notebook`；编辑器保存链 = `_session/notebook/file_manager.py:202-274` → `serializer.py:56-83`。官方文法（_schemas/serialization.py:106-117 docstring）：`notebook = header? + app + setup? + cells* + run_guard`。

**真 marimo 格式**（最小示例 examples/running_cells/basics.py）：

```python
# /// script                     ← PEP 723 可选（_tutorials/fileformat.py:2-7）
# requires-python = ">=3.12"
# dependencies = ["marimo"]
# ///
import marimo

__generated_with = "0.19.7"      ← 版本戳（codegen.py:599；缺失=软违规 parse.py:1185）
app = marimo.App(width="medium") ← 配置只在 App kwargs（见下表）

with app.setup:                  ← 可选 setup 块（parse.py:1060-1065）
    import random

@app.cell                        ← cell = 装饰器 + 函数；refs=参数，defs=return
def _():
    import marimo as mo
    return (mo,)

@app.cell(hide_code=True)        ← markdown cell = hide_code + mo.md(r"""...""")
def _(mo):
    mo.md("""# Title""")
    return

if __name__ == "__main__":       ← run guard 标准尾部（codegen.py:604-606）
    app.run()
```

- **装饰器 kwargs 仅 4 个**：`column/disabled/hide_code/expand_output`（app.py:362-371；CellConfig cell.py:35-53）；另有 `@app.function`、`@app.class_definition`、`app._unparsable_cell(r"""...""")`（parse.py:936-953,1017-1037）。
- **App() 配置键全集**（app_config.py:26-43）：`width`（默认 "compact"）、`app_title`、`layout_file`、`css_file`、`html_head_file`、`auto_download`、`sql_output`；未知键告警丢弃（app_config.py:50-66）。
- **cell id 从不落盘**：IR CellDef 无 id 字段（serialization.py:41-47）；运行时 id = **4 个随机 ASCII 字母**（cell_id.py:17-31），加载时按注册顺序 seed=42 确定性重发（cell_manager.py:85,251-278），跨保存的稳定性靠**代码相似度匹配** rekey（cell_manager.py:545-567）。`# %% [cell-id: xxx]` 在 marimo 中**不存在**（全库 grep 无此格式）。
- 运行时配置（theme/autosave）不进 .py：用户级 `.marimo.toml`（_config/utils.py:13,68-121）、项目级 `pyproject.toml [tool.marimo]`（reader.py:22-29）、文件级 PEP 723 `[tool.marimo.*]` 白名单键（manager.py:498-572,541-551）。

**与 spec §4 我们格式的差异点**（决定互操作成本）：

| # | 维度 | NovaLab（spec §4） | 真 marimo | 影响 |
|---|---|---|---|---|
| 1 | cell marker | `# %% [cell-id: 8hex]` | `@app.cell` + `def _(...)` 函数包装 | marimo 解析在 `import marimo` 检查即失败（parse.py:583-606 → NON_MARIMO_PYTHON_SCRIPT_VIOLATION :1199）；**不能直读** |
| 2 | 数据流契约 | 无（裸代码块，全局命名空间） | refs=函数参数、defs=return（codegen.py:319-391） | percent 转过来后 marimo 需自行重推导 defs/refs（转换后经 compile 重建，语义可恢复但依赖其编译器） |
| 3 | cell id | 8hex 持久 id，git-merge 友好 | 不落盘，运行时 4 字母重发 + 相似度匹配 | **我们的核心卖点（冲突粒度=cell）marimo 没有**；经 marimo 往返 id 全丢 |
| 4 | 配置 | `# [novalab] width=...` 注释行 | `App(width=...)` kwargs + `[tool.marimo]` PEP 723 | 我们的配置行对 marimo 是普通注释/代码，不被识别 |
| 5 | import 头 | 无强制 | `import marimo` + `__generated_with` + `app = marimo.App(...)` 必须（缺失抛 MarimoFileError parse.py:1142-1143） | |
| 6 | 尾部 | 无 | run guard 标准（软强制，保存自动补） | |
| 7 | 互操作路径 | — | 导入：`marimo convert` 检出 `# %%` 走 jupytext py:percent（non_marimo_python_script.py:83-85；需 jupytext 依赖，convert/commands.py:119-131）；导出：`marimo export script` 产 `# %%` 扁平脚本（_convert/script.py:47-67，单向不可再编辑） | **双向都要转换器**；`marimo edit` 对我们文件直接拒绝并提示 convert（_cli/utils.py:147-158） |

**结论**：spec §4 的"marimo 兼容子集"应改述为"**percent-script 风格自有格式 + marimo 单向导入兼容**"。P1.2 serialize.py 需内置转换器（我们→marimo 真格式、marimo→我们，含 id 映射策略），估 **2–4 人日**；若 G1 走路线 A，此转换器**仍然需要**（marimo server 不吃我们的 .py）——"格式天然兼容"不构成 A 的差异化收益。

## Q6 许可证合规（Apache-2.0）

**仓库材料**：LICENSE = Apache-2.0 标准全文（版权行为模板占位符）；**无 NOTICE 文件**（Apache-2.0 不强制）；pyproject.toml:61-62 `license = "Apache-2.0"`；第三方清单 third_party.txt / third_party_licenses.txt（前端 npm 依赖，随 wheel 分发 MANIFEST.in:5-6）；Python 侧少量 "adapted from" 文件（tokens.py:7 starlette、log_formatter.py:2 tornado 等，均带头部声明）。CLA：CONTRIBUTING.md:16,362——贡献需签署，**版权归 Marimo Inc**（GOVERNANCE.md:192-194）；仅影响向上游贡献，不影响我们复用。

**三种做法的义务**：
1. **Vendor 代码片段**（复制其源码进 NovaLab）：触发 §4 义务——保留版权与许可证声明、**标注修改**（§4(b)）、附带 Apache-2.0 文本；上游无 NOTICE 故无 §4(d) 附加归属要求。§3 专利授权随之获得，但**对其发起专利诉讼即终止授权**（§3 末段）。实操：逐文件 provenance 头 + 项目级 THIRD-PARTY 清单。
2. **协议级集成**（路线 A：子进程跑 marimo，只说 HTTP/WS）：两个独立程序经网络协议通信，**不构成衍生作品**——NovaLab 代码无 Apache 义务外溢，闭源/换许可证均自由；需在依赖清单声明 marimo（Apache-2.0）；§6 商标条款：**产品名/宣传不得使用 marimo 商标**（NovaLab 命名 OK，"marimo-powered" 之类表述需谨慎）。
3. **读代码自研**（路线 B 现行纪律）：思想/算法/文法不受版权保护，clean-room 合规；但**具体表达**（代码文本、测试断言的逐字形状）受保护——plan §6"抄测试用例形状"应从严解释为"依据文法与行为描述自写断言"；Apache-2.0 §3 的明示专利授权只覆盖"使用 marimo 作品"，B 路线不使用其代码，理论上不受该授权保护（现实专利风险低：marimo 无已知软件专利主张，且 Apache 许可表明生态友好姿态）。

**对 G1 的含义**：无论 A（协议集成）还是 B（读码自研），合规负担都低；vendor 是三者中义务最重的，除非必要不做。

---

## 路线 A 适配工作量估计

前提：`KernelAdapter` 接口已冻结（spec §6.2），前端/Bridge 对前端协议零改动；工作全部落在 Bridge 新增 `MarimoAdapter`。

| 工作项 | 估计 | 依据 |
|---|---|---|
| 握手/认证/会话生命周期（spawn server、skew token 获取或关闭、session_id 管理、5 种连接类型中的 NEW/RECONNECT、reload 处理） | 2–3 人日 | §1.1；ws_session_connector.py |
| REST 命令面客户端（~10 端点，openapi-fetch 生成 + 薄封装） | 1–2 人日 | §4；api.yaml 现成 |
| WS 订阅与 13 op → spec §6.1 消息翻译（cell-op→run.* 流、variables→kernel.vars、kernel-ready→notebook.state） | 3–5 人日 | §4；最大头是 CellOutput MIME 映射 |
| 语义缺口桥接（lazy 模式配置注入、ask/副作用策略模拟、REPL→scratchpad、introspect 补深） | 2–4 人日 | §4 缺口清单 |
| .py 双向转换器（路线 A 也需要，见 Q5） | 2–4 人日 | §5 |
| 契约测试 + 版本 pin 基线（消息 fixture 快照 + openapi-diff 接入） | 2–3 人日 | §2 |
| **合计（MVP 级）** | **12–20 人日** | 不含 UI 元素渲染、终端、RTC |
| **持续维护税** | 每次 minor 升级 +2–4 人日 | §2 结论 |

对照：路线 B 的 S2（2d spike）+ P1.2（排期内 ~5–8 人日）合计 **7–10 人日**且无外部漂移。**A 不比 B 便宜**，A 的真实价值是"反应式语义确定性交付"（B 的边角 bug 风险对冲），代价是长期维护税与产品差异化受限。

## 风险清单（路线 A）

| # | 风险 | 概率/影响 | 证据 | 缓解 |
|---|---|---|---|---|
| R1 | 协议漂移：0.x 高频 minor、无兼容承诺、已发生过命令面 WS→REST 整体迁移 | 高/高 | §2；ws_message_loop.py:147-151 | 版本 pin + CI openapi-diff + 消息 fixture 契约测试（用他们自己的门禁工具链） |
| R2 | 私有 API 无契约（全下划线模块，公开面仅 3 个符号） | 高/中 | marimo/__init__.py:31-35 | 只依赖 schema 门禁覆盖的 REST+op 核心，不碰 Kernel/SessionImpl 内部 |
| R3 | "格式天然兼容"不成立：我们的 `# %%` 子集 marimo 不能直读，转换器两路线都要写 | 确定/中 | §5（parse.py:1199、_cli/utils.py:147-158） | 修正 spec §4 表述；P1.2 serialize.py 内置双向转换（2–4 人日，已计入两路线） |
| R4 | 语义缺口：ask 策略、副作用 cell 名单、PreviewSerializer head(1) schema 嗅探在 marimo 模型无对应物 | 中/中 | §4 缺口清单 | Bridge 侧模拟 + notebook 内注入辅助函数；接受功能降级 |
| R5 | 会话/认证复杂度（双 token、capability 协商、kiosk/resume/RTC 分支） | 中/中 | §1.1 | 只用 NEW/RECONNECT 两种连接类型；关 skew（本地单用户场景可接受） |
| R6 | 多内核 = N 个完整 marimo server（uvicorn+LSP+文件管理），P3.1 内存/启动成本超瘦内核一个量级 | 中/中 | §4；programmatically.md:181-191 | P3.1 前重估；或降级为单内核多 tab |
| R7 | 终端在 Windows 不可用（Owner 主力环境） | 低/低 | terminal.py:361-371 | NovaLab 本就未规划终端，忽略 |
| R8 | 升级即"整页 reload"设计假设被第二客户端打破（无版本协商） | 中/高 | middleware.py:112-172；notification.py:667 | Adapter 启动时校验 /api/version（health.py:119）与 pin 值，不匹配拒绝启动 |

## 证据表（关键索引）

| 主题 | 证据 |
|---|---|
| 版本/HEAD | pyproject.toml:7（0.25.1）；git HEAD 52111396d1d1 |
| WS 单向 + 命令走 REST | ws_endpoint.py:62；ws_message_loop.py:147-151；execution.py:67-603；deps.py:135-145 |
| 推送 op 43 种 | notification.py:1088-1146（union）；线格式 ws_formatter.py:18-30 |
| 握手/双 token | session.ts:12-16（session_id 自生成）；auth.py:30-69；middleware.py:111-172；_templates.py:329；asgi.py:359 |
| 类型生成流水线 | _cli/development/commands.py:219,252-483；Makefile:121-126；packages/openapi/package.json:14-17；messages.ts:2-4 |
| CI 门禁 | .github/workflows/test_schemas.yaml:116-129 |
| 无稳定性承诺 | 全仓 md 检索 semver/stability 零命中；无 CHANGELOG；codes.py:15-21（手工镜像注释） |
| embed 限制 | app.py:840；kernel_runner.py:79-81（RuntimeError） |
| create_asgi_app 只读 | asgi.py:354-401（:358 docstring）；programmatically.md:181-191 |
| 无头样板 | _export/file.py:600-661（run_notebook） |
| .py 文法/序列化 | serialization.py:106-117；codegen.py:566-610,302-391；parse.py:1077-1177；app_config.py:26-43 |
| cell id 不落盘 | serialization.py:41-47；cell_id.py:17-31；cell_manager.py:85,545-567 |
| percent 转换路径 | non_marimo_python_script.py:83-85；_convert/script.py:47-67；_cli/utils.py:147-158 |
| lazy/autorun | config.py:146,185,808 |
| 终端 Windows 禁用 | terminal.py:361-371 |
| 许可证 | LICENSE（Apache-2.0 全文）；无 NOTICE；pyproject.toml:61-62；CONTRIBUTING.md:362；GOVERNANCE.md:192-194 |
