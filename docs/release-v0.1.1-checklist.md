# NovaLab v0.1.1 验收清单与阻塞项

> 整理日期：2026-10-13 · 更新：2026-10-14 · 状态：工程门、O-2、可信入口、保存/关闭、执行队列与原子保存/外部冲突子包已验收，**不是完整验收通过或发布批准**。
> 代码基线：`e45a04a82ce2e6cef2d913a4da42de1a3700a4c3` **加本工作树未提交修改**（2026-10-14 fetch 后 HEAD 与 origin/main 一致）；提交 SHA 尚不能单独代表本轮受测代码。
> 上游：[Intent](intent.md) · [Spec](spec.md) · [Plan（§5b）](plan.md) · [功能矩阵](demos/feature-matrix.md) · [Changelog](../CHANGELOG.md)。
> **已执行**：A01 类型检查与三套单测、A02 集成、A03 无 Agent 画廊；2026-10-14 先后补 O-2、可信入口/纯预检与保存/关闭修复，独立工作树集成验收、真实浏览器磁盘验证及受影响构建/画廊，证据见 §9。
> **未执行**：候选安装包及 Tauri 窗口安装验收、真实 provider/MCP 客户端、当前基准与 Owner 真实科研任务。历史性能数不能替代本轮证据。

## 1. 验收范围与放行原则

### 1.1 本版本已有实现，接下来验证而非重做

| 范围 | 实现/约定来源 | 本轮验收重点 |
|---|---|---|
| H1 通道鉴权 | intent ADR-009；bridge/src/main.ts | discovery、Origin、首条 token 认证、未认证连接隔离、动态端口 |
| H2 Agent 隐私与审计 | intent M5；bridge/src/router.agent.test.ts；app/src/agent/payload.test.ts | stdout/stderr/写路径与 MIME 正文不从工具输出外发；逐次返回如实审计 |
| H3–H6 工作台与 Welcome、Session notebook | intent ADR-010；spec §10/附录 A-5 | 布局持久化、连接与环境状态、只读/富输出、双主题、键盘交互 |
| H7 文档同步 | plan §5b；本清单 | 需求、实现状态、证据、版本和发布说明口径一致 |
| H8 基准脚本 | scripts/bench.mjs；intent §8 | 当前鉴权基线上重测，补安装版与真实窗口测量 |
| H9 尾表达式、HTML 表格、live .ipynb 富输出 | intent ADR-011（**待裁决**）；py/tests/test_runtime.py；app/src/components/htmlSanitize.test.ts；bridge/src/exporter.test.ts | 表达式回显、安全降级、显示上限、富输出导出 |

这些功能已有实现不代表无回归。v0.1.0 核心链路（编辑/执行/文件/会话/控件/导出/Agent）也须回归。多人协同、云同步、非 Python 内核、.ipynb 双向同步不在本次范围。

### 1.2 三类事项，不能混写

- **阻塞项 B**：在建议的候选版/正式发布门下，目前缺少决策、修复或可追溯证据。证据未跑不等于发现代码失败。
- **验收项 A**：有具体操作、预期和证据要求；只有对当前候选 SHA/产物实际执行后才能勾选。
- **后续项 F / 已知限制 K**：可以另排期；若本版保留，必须在发布说明中披露并由 Owner 确认接受。不可擅自把它们变成新承诺，也不可默认已经获准延期。

**建议放行规则（待 Owner 确认）**：B 项全部关闭；适用 A 项对同一候选代码/产物通过；无未处置的安全、隐私、数据丢失或核心功能回归；性能未达既定目标时须有明确裁决；F/K 保留项明确披露。`--skip-agent`、测试替身和 headless 截图不能替代真实 provider、stdio、桌面窗口或安装版验收。公开发布、打 tag、上传附件另需 Owner 明确授权。

## 2. 当前阻塞项

下表的优先级是本次收口建议，不新增产品决策；除已明确的实现/配置缺口外，均不能读成“测试失败”。

| ID | 类型 / 当前事实 | 为什么阻塞 | 关闭条件 | 执行方 / 状态 |
|---|---|---|---|---|
| B01 | **决策缺口**：ADR-011 仍为提案，HTML 表格实现已合入 | 本版富输出范围未正式批准 | Owner 接受“白名单表格、丢样式、非表格回落”的边界并更新 ADR；或明确要求修改/暂不发布该能力 | Owner 裁决；开发执行 / 待裁决 |
| B02 | **已关闭（本工作树工程/脚本门）**：A01/A02/A03 复测通过；skip 已接线；O-2 已先复现再修复，内容断言通过 | 无 Agent 画廊与真实 Agent 结果分开记录 | 16/16、无页面 console 错误；后台投影/导入归属/不串 cells 通过，11 明确 skipped。真实 Agent 仍由 B05/A09–A11 验收 | 开发 / 2026-10-14 关闭；提交后关联受测代码版本 |
| B03 | **版本与发布联动缺口**：Changelog 为 Unreleased；多个版本出口未明确联动 | 候选包可能沿用旧版名，无法可靠追溯到 v0.1.1 | 明确产品/内部包版本策略；核对 §4 所有出口；候选构建与最终 tag/安装显示一致，有防错校验 | 开发；Owner 确认策略 / 待处理 |
| B04 | **产物证据缺口**：没有本轮候选安装包与实际桌面安装验收记录；现有 packaged smoke 不等于安装后窗口测试 | 源码可运行不能证明最终分发产物能安装、启动和恢复 | Windows NSIS/MSI、Linux AppImage/deb 构建可追溯；逐种产物安装/启动；覆盖只读安装目录、首次依赖准备及已初始化后断网本地链路 | 开发/平台验收者 / 待执行 |
| B05 | **Agent/MCP 证据缺口**：11 态截图为旧布局；MCP 单测用 InMemoryTransport，非真实 stdio 共享会话验收 | 本版鉴权和工作台变更后，N2/N3 与外部审阅闭环未重新证明 | A09–A11：真实 provider 的 Fix→Diff→采纳与多格重构；无凭据降级；真实 stdio 客户端确认目标 notebook/内核与前端审阅队列一致、提议不静默改文件 | Owner 手动配置端点；开发/验收者执行 / 待验证 |
| B06 | **产品证据缺口**：N1–N4 尚无本版真实科研任务记录 | demo 通过不能代替个人科研自用验收 | 在候选安装版完成一份本地人口预测或 POI 清洗任务，记录步骤、实际卡点、结果一致性；外发步骤先确认数据范围 | Owner / 待验收 |
| B07 | **指标缺口/已有不达标记录**：旧 dev 数不含 Tauri 窗口；滚动 57.9fps 需复核；v0.1.0 NSIS 37MB 超过 <20MB 目标 | intent/spec 的指标不能用旧形态、负载异常或静默改阈值放行 | §6 在空闲机器与候选包上重测；达标或 Owner 书面调整目标/接受本版例外（附影响），不把例外写成达标 | 开发测量；Owner 裁决 / 待重测、待裁决 |

B05 需要特别核定“同一会话”：当前 `bridge/src/main.ts` 的 `--mcp` 分支只启动 stdio MCP，**不启动 WS 或 LLM 代理**。仅证明工具注册成功，不足以证明它接入了桌面正在使用的内核/审阅队列。此处是待验收问题，不先判定为已确认 bug；若真实验收发现独立内核或前端看不到提议，再建复现用例并处理。

## 3. 可执行验收清单

A01–A05 的已执行结果见 §9；A07/A08 已补专项子项，尚未完整关闭；其余待执行。不适用项记 `N/A + 理由 + 确认人`；缺凭据/平台记 `阻塞 + 缺少条件`，不能记通过。每项证据按 §8 记录。

### 3.1 工程门

- [x] **A01 类型与单测**：app/bridge 类型检查、两包 vitest、Python pytest 全部执行；可选依赖测试不得因 importorskip 大面积跳过而写成完整通过。保留各包汇总与跳过原因；命令见 §5。
- [x] **A02 真 bridge+kernel 集成**：现有 integration smoke 成功，包含 discovery/auth、打开/列表、三格执行、尾表达式 plain/html、工具 MIME 键名边界、schema 与保存后的 stale 传递；核对连接的是此次进程而非本机旧服务。该脚本不覆盖 Diff 审阅、REPL 与级联策略的完整交互，它们分别由专项测试/画廊或 Agent 验收记录支持。
- [x] **A03 UI 画廊**：无 LLM 的状态在当前基线上重拍，Welcome/工作台/Session/双主题/输出/布局无回归；保存运行日志。11 态未跑时保持缺证据标记，不覆盖为通过；真实 Agent 另走 A09。**初次发现 O-2，已补回归修复；最终画廊结果见 §9。**

### 3.2 安全、隐私与写入纪律（本机合成夹具）

- [x] **A04 通道鉴权负例**：非白名单或缺 Origin 的 `/bridge-info` 与 WS upgrade 被拒；白名单 WS 的错误 token、首条非 auth、3 秒超时被关闭；未认证客户端收不到广播。正确认证可工作，bridge 重启后 discovery 能获取新 token；测试不得固定生产 token、泄露 token 到证据。
- [x] **A05 LLM 代理**：缺失/错误 token 请求被拒；外部 Origin 被拒；白名单预检与合法调用可工作；本地 token/占位认证头不转发给上游；错误端点/不可达服务不拖垮 notebook。负例先使用本机上游替身；真实外发另需授权。
- [ ] **A06 工具隐私与审计**：在合成 stdout/stderr、写路径、text/plain/html/png 中放唯一哨兵，检查 app 工具与外部 MCP `get_cell_output` 仅回 `{traceback, mimeKeys}`，其他工具结果不意外夹带 MIME 正文；检查每次工具返回审计。另验证 schema/preview 截断，不把 traceback 的 8KB 规则误写成全字段 4KB。
- [ ] **A07 staged-only 与工作区边界**：Agent 更新/插入代码在人工采纳前不改变 notebook 源码/文件；多重定义/环提议被静态预检拒绝；Tab/Esc、逐 hunk、手改 staged、多 diff 队列均正确。`fs.*` 路径越界被拒；删除仅对独立临时工作区测试。
- [ ] **A08 HTML 输出边界**：DataFrame 表格继承双主题并替代 plain；非表格/无可渲染文本回落 plain 且提示未渲染 MIME；带 script/img/iframe/svg/form/on*/URL/style 的合成 repr 不产生脚本执行或额外外链请求（检查真实浏览器解析及渲染全过程，不只白名单树）；20 000 节点预算与内核显示上限有可见降级，长/宽表可滚动。原样导出的 HTML 按 Jupyter 信任模型披露，不能声称导出也已消毒。

隐私验收边界：代码、traceback、DAG 与有限 schema/preview 本来就在发送白名单内，**不是“零数据发送”**。敏感字段可能出现在代码、报错栈、列名或 head(1)；真实任务接入远端模型前须确认这些允许发送。不得自动探索 cc-switch、系统凭据或其他工作树的 `.env.local`，不得把 key/token、数据明细或含敏感路径的截图提交进仓库。

### 3.3 Agent 与真实科研工作流

- [ ] **A09 N2 修错循环（真实 provider）**：合成数据制造 KeyError；FixCard 附 traceback/schema；真实流式返回、工具调用、Diff 显示；人工 Tab 采纳后运行正常、审计逐次准确。记录 provider 类型/模型/部署方式，不记录 key。覆盖候选 Tauri 的生产代理路径，而不只 Vite 开发代理。
- [ ] **A10 N3 多格重构与离线降级**：对三格请求参数函数重构，逐格审阅后 DAG 重连、结果一致；非法提议可拒绝/自纠。分别记录有实际条件的 provider 组合；未测组合不写“四 provider 通过”。缺 key、provider 不可达时显示降级，本地编辑、执行、保存、导出不受影响。
- [ ] **A11 外部 MCP 真 stdio**：客户端从 Welcome 给出的启动信息接入；列出六工具与 resources；读取预期 notebook 的 cell id/执行状态；提议出现在该前端队列，拒绝不改文件、采纳后前后端一致。若另起独立 notebook/内核或无可见队列，记失败并保留复现步骤，不用 InMemoryTransport 结果替代。
- [ ] **A12 N1 本地探索分析**：候选安装版用 Owner 本地样本完成读取→清洗→统计/图表；编辑上游使下游 stale，默认 mark-only 不偷跑；显式级联结果与基准计算一致。重定义、环、改名/删除不留下幽灵变量。先在合成样本演练，私有结果保存在本机。
- [ ] **A13 N4 交付与互操作**：纯 .py 保存后重开保留 cell id/代码；App View 隐藏代码并保留控件/输出；live .ipynb 包含 plain/html/png 与执行计数，在 Jupyter 可打开；一次性导入生成可运行 .py 并明确 magic/输出降级；历史导出限制见 K2。

### 3.4 桌面、恢复与边界场景

- [ ] **A14 四种最终产物**：Windows NSIS/MSI、Linux AppImage/deb 安装/解包与真实窗口启动；从实际安装目录打开 notebook、运行、保存、导出。检查只读资源复制到可写运行目录；首次依赖安装错误有可理解提示/恢复路径；初始化后断网可跑本地链路。开发目录或 CI 已准备环境不算“全新机器首启”。
- [ ] **A15 崩溃/重启与外部修改**：已验 clean dead/ended notebook 的 owner-addressed 冷重启、同 notebook FIFO、重复请求拒绝、失败保留 dead/session、旧 outputs/Diff/REPL 清理与 A→B owner 隔离；dirty dead 草稿保留并阻止重启。bridge 死亡→桌面重连已验（2026-10-16 第六轮，Windows-only）：断线结算 pending、允许编辑、新一代 tab 保留为 bridge-lost、clean 点击冷重开、dirty 保留草稿；D4 补充（同日 Owner 批准）：dirty tab 重开时以跨代 `baselineSha256` 核对磁盘，未变则续存草稿、已变或未知则进入冲突流程不覆盖；跨应用草稿恢复仍待独立包；外部编辑文件的冲突提示不丢未保存内容。副作用重放须在临时文件夹/合成任务中验证，不对真实研究目录杀进程试验。
- [ ] **A16 多 tab、历史与 >500 cells**：前后台切换状态不串；后台刷新行为按 K1；历史 ended 只读；构造 501+ cell 会话，显示前 500 与截断说明，导出包含完整会话而非截断投影。
- [ ] **A17 长输出、控件与布局**：>420px 输出内部滚动不撑坏编辑区，宽表横滚，折叠/复制/焦点样式有效；布局缩放、Ctrl+B/Ctrl+Alt+B、重开持久化、Welcome 状态和两主题正常。slider 交互按 spec §15 自动级联，但副作用下游只标 stale；重开控件值回默认需提示/文档一致。
- [ ] **A18 性能与体积**：按 §6 记录真实数字、环境与统计口径；安装版窗口计时和首次运行时准备分开，不以 dev/headless 数替代全部桌面指标。

## 4. 版本与产物核对表（B03）

不是要求所有内部包机械同号；**先明确哪些是产品版本、哪些独立版本**，再建立可验证映射。本轮不修改这些值。

| 出口 | 整理时状态 | 放行前要核对 |
|---|---|---|
| CHANGELOG.md | `[Unreleased] - v0.1.1` | 正式发布时才改日期/发布段落，保留 compare/release 链接 |
| app/src-tauri/tauri.conf.json | 产品版本 `0.1.0` | 窗口/安装程序/包文件名与目标产品版本一致 |
| app/src-tauri/Cargo.toml 与 Cargo.lock | Cargo.toml 的 Rust 包版本 `0.0.1`；lock 待联动核对 | 若作为产品版本更新须同步 lock，否则记录映射 |
| package.json、app/package.json、bridge/package.json 与 pnpm-lock.yaml | 三个 package.json 均为 `0.1.0`；lock 待联动核对 | 确定内部独立版本还是随产品联动；同步相关锁文件 |
| py/pyproject.toml、py/uv.lock | pyproject.toml 的 Python 包版本 `0.0.1`；lock 待联动核对 | 包元数据/锁文件与所选策略一致 |
| py/novakernel/__init__.py | `__version__ = "0.0.1"`，server ping 使用它 | 运行时上报与包元数据一致；不伪装成产品版本 |
| bridge/src/main.ts | manifest `version: '0.1.0'` | 明确含义并避免 v0.1.1 产物误报旧产品版本 |
| .github/workflows/release.yml | `v*` tag 或手动触发；未见 tag/产品版本一致性门 | 补版本防错或执行明确核对；关联相同 SHA 的 CI 测试门、构建来源和附件版本；构建成功不代表获准发布 |

Windows / Linux 是两个平台，NSIS/MSI/AppImage/deb 是四种产物；不写成“四平台”。每个最终产物记录 SHA256、体积、构建 SHA、工具链、安装/启动结论。本轮不生成、不上传。

## 5. 执行准备与工程命令

### 5.1 前置纪律

- 在负责验收的工作树内执行；开工与候选集成前核对 origin/main，记录候选 SHA。验证后若运行时代码、依赖或构建配置变动，受影响项重跑。
- node/pnpm、uv/Python、Rust 与各平台 Tauri 构建依赖齐备；JS 使用冻结锁文件，Python 包含测试与 data extras；Playwright 需 Chromium。本工作树已完成 JS/Python 依赖准备；平台安装包构建依赖仍需单列核对。
- 集成与保存/关闭浏览器 smoke 使用私有临时 notebook/data 目录、OS 分配端口与本次 manifest，核验 PID/token/精确 loopback URL 后直连；不扫描现有 bridge。画廊的无参数客户端仍扫描 7788–7798 首个有效 bridge，须核对归属；packaged smoke 已改为私有 manifest 核验后的精确直连，见 §5.3。基准后端通过私有运行清单连接自身进程，但 `--ui` 仍访问指定 dev 页面。只停止本次负责的服务，不杀其他会话/用户进程；无法隔离记环境阻塞。
- UI 预览使用项目启动配置；画廊自行起停测试服务。画廊可能覆写截图、临时夹具及状态，执行前记录已有修改，执行后审查产物。
- 安装/崩溃/文件操作使用独立临时工作区和测试用户数据目录，不读取或修改真实 provider 存储。真实 LLM 凭据由 Owner 手动设置；发送内容与预算先确认。

### 5.2 基础测试门（每条独立记录结果）

```bash
pnpm --filter @novalab/bridge exec tsc --noEmit
```

```bash
pnpm --filter @novalab/app exec tsc --noEmit
```

```bash
pnpm --filter @novalab/bridge exec vitest run
```

```bash
pnpm --filter @novalab/app exec vitest run
```

```bash
uv run --directory py pytest
```

```bash
node scripts/integration-smoke.mjs
```

**无 LLM 画廊使用已接线的 skip 开关**（17 个状态 id 中排除 11，执行 16 态）：

```bash
node scripts/demo-gallery.mjs --skip-agent
```

2026-10-14 已将 `--skip-agent` 接入状态循环：11 态函数不执行，并打印明确的 skipped 记录。11 态仍为 optional；完整脚本的 Agent 失败/未回复不影响必选状态退出码，**不能凭整条退出码认定 Agent 通过**。真实 Agent 画廊须先授权外发与配置，再检查 11 态实际结果；A09–A11 的业务断言不能只靠截图替代。

### 5.3 基准与构建目录 sidecar smoke

依赖准备（JS/Python 已执行；Chromium 已存在；以下为可复现命令）：

```bash
pnpm install --frozen-lockfile
```

```bash
uv sync --directory py --all-extras
```

```bash
pnpm exec playwright install chromium
```

后端基准（自行启动测试 bridge，保存 JSON 到本轮工作目录）：

```bash
node scripts/bench.mjs --runs 100 --json bench-v0.1.1.json
```

UI 基准需当前工作树的 dev bridge 与 Vite 页面已就绪；这里只量浏览器页面，不量安装版 Tauri 窗口：

```bash
node scripts/bench.mjs --runs 100 --ui --app http://127.0.0.1:5199/ --json bench-v0.1.1-ui.json
```

构建目录 sidecar 前置（需本平台 node/uv 工具链；不是最终安装包构建）：

```bash
node scripts/build-bridge.mjs
```

```bash
node scripts/sync-py-resources.mjs
```

已有 uv 项目准备好后执行：

```bash
node scripts/packaged-startup-smoke.mjs
```

该脚本没有 CLI 参数；`NOVALAB_SMOKE_PY_DIR` 选择现有运行项目，`NOVALAB_SMOKE_PY_SOURCE_DIR` 可指定源目录，默认根 `py/`。release 工作流预先 `uv sync` 并复用该环境。它以 `NOVALAB_PACKAGED=1` 启动构建目录中的 bundled node/uv/bridge，复用私有临时目录、随机 token、OS 分配端口与 manifest PID/token/精确 URL 核对，`BridgeClient.connect(info)` 直连；ping 后仅打开临时合成 notebook，真实 Python 校验 packaged 环境并计算 `42`。Windows 启动前 Job / POSIX 独立进程组负责整树回收，成功标记在进程树退出与临时文件删除后输出。**不覆盖最终安装器、Tauri 窗口、无缓存首次下载、BYO 路径、真实 LLM**。打印 `llmPort` 也不等于调用模型。

构建后另运行 packaged 专用真实进程回归（需要 7788 空闲来建立本套件的 decoy；若被其他服务占用则失败，不停止该服务；不要与集成进程隔离套件并行运行）：

```bash
node --test --test-timeout=70000 scripts/packaged-startup-smoke.acceptance.mjs
```

### 5.4 CI / release 与本清单的差别

- `ci.yml`：Windows/Linux 执行 tsc + 两包 vitest、脚本客户端与真实 integration/进程隔离；Linux 执行 pytest、gallery。没有 Rust 构建、基准或 packaged smoke 门。
- `release.yml`：构建前端、sidecar、py resources，复用已初始化环境做 packaged smoke 与 packaged 进程归属回归，然后打包；Windows 校验 bundle payload，Linux 检查 AppImage/deb 存在且非空。**不等于最终安装后的窗口启动测试，也不复跑全部 CI 测试门。**
- 因此放行时必须关联同一候选 SHA 的 CI 结果、release 构建结果与 A14 的最终产物验收；不能仅凭某一个 workflow 绿灯放行。签名环境注入目前全部注释，填 secrets 本身不会完成签名接线。

## 6. 量化验收口径（B07 / A18）

来源：intent §8、spec §13；阈值是既定目标，不在本清单中自行放宽。

| 指标 | 目标 | 现有证据及缺口 | 本次记录方式 |
|---|---|---|---|
| 冷启动（已完成首次环境准备） | 双击→可编辑 <3s | 旧 dev spawn→WS→open 100 cell 为 1.3–1.4s，不含窗口 | 候选安装版真实窗口，固定 100 cell 夹具；分开记录“可编辑”与内核/回放就绪，不以其中一个冒充另一个 |
| cell 运行附加开销 | <50ms | 旧 dev 中位数 0.9ms / p95 1.7ms，不是当前候选实测 | 保留样本数、中位数/p95/最大值及测量定义，与用户代码运行时间区分 |
| 100 cell 滚动 | 60fps | 旧 headless 57.9fps，需真机复核 | 固定窗口、刷新率与滚动场景；桌面 GPU/真实窗口记录帧率和长帧；大输出场景另记 |
| Bridge 常驻 RSS | <150MB | 旧 dev ≈100MB；包装进程/内核需区分 | 记录真正 bridge PID/RSS、空闲/运行时刻；Python 用户数据内存不混入 |
| 安装包体积 | <20MB | v0.1.0 NSIS 37MB / MSI 55MB 已超过目标 | 候选四种产物逐项实际字节与 SHA256；说明是否包含 Python/WebView2/首次下载 |
| 首次环境准备 | 记录耗时/下载/失败恢复，未定阈值 | v0.1.0 首启需联网下载约 450MB 运行时（历史值） | 干净测试环境单独计时；不要将首次联网安装混入已初始化冷启动，也不要宣称全新机器可离线首启 |

建议同一空闲机器重复至少 5 次，保留原始测量与汇总，注明 CPU/RAM/OS/GPU/显示刷新率、是否缓存、负载、构建形态。该重复次数是本轮测量建议，不是已有产品承诺；异常负载样本保留并注明，不挑最好一次做结论。

## 7. 后续项与保留限制（须明确接受，不自动阻塞全部发版）

### 7.1 后续项 F

| ID | 当前缺口 | 本版保留时必须说明 | 升为阻塞的条件 |
|---|---|---|---|
| F01 首启镜像/离线依赖包 | bootstrap 仍联网安装；Windows WebView2 默认安装路径也可能联网 | “已初始化后离线可用”与“全新机器离线首启”区分；列运行时下载及失败恢复要求 | 目标用户无法完成首启，或 Owner 将全新离线首启列为本版必需 |
| F02 i18n 深度迁移 | 字典骨架已落地；侧栏/Agent/Fix 仍有硬编码中文 | 不宣称完整双语；功能可用与文案完整度分别验收 | 硬编码造成理解/操作阻碍，或 Owner 要求完整英文 UI 才发布 |
| F03 Tauri CSP | 当前 `csp: null` | CSP 未加固如实披露；ADR-011 不等于 CSP 已完成 | 发现可执行脚本/外链访问越权，或 Owner 将 CSP 纳入本版发布门；安全回归不能凭延期跳过 |
| F04 代码签名 | workflow 仅有占位，未完整接线 | 未签名、SmartScreen/发行者提示；证书由 Owner 提供 | Owner 要求可信分发/企业安装；updater 签名与代码签名另分范围 |
| F05 真实 scipy/geopandas 嗅探 | 实现已有；扩展测试中的 scipy/geopandas 为 fake/duck-typing，numpy/pandas 有真实库用例 | 不再写“未实现”，但不能写成真实 GIS/稀疏库兼容性已验收 | 本次 POI/GeoJSON 任务依赖这些真实库而失败 |

### 7.2 已知设计限制 K（不是新增开发待办）

| ID | 限制 | 验收/发布说明要求 |
|---|---|---|
| K1 多 tab | 非焦点内核不实时流式，切回时全量回灌；watcher 仅监听焦点文件 | 不串状态、不丢回灌；不宣称所有后台文件实时热更新 |
| K2 历史富输出 | 历史快照只保存 MIME 键名，历史 .ipynb 导出无法恢复图像/HTML 正文；live 导出含富缓存 | 明确 live/历史区别；N4 若要求历史富输出完整交付，由 Owner 决定提升范围 |
| K3 控件值 | 只在内核内存，重开/重跑回默认；交互自动级联绕过 mark-only，副作用例外 | 按 spec §15 验证；不得默认为持久化已实现 |
| K4 输出顺序 | 按 stdout/stderr/traceback/mime 流级分区，不能还原逐 chunk 交错 | 保证内容不丢；不承诺时间顺序精确还原 |
| K5 富 HTML | 丢样式与脚本型 repr；非表格回落 plain；导出原样 HTML | 随 ADR-011 裁决，不能把 Styler/plotly 保真列为已支持 |
| K6 Notebook 信任模型 | Python 内核以用户权限执行，不是恶意代码沙箱 | 仅打开可信 notebook；“HTML 消毒”不代表“Python 安全沙箱” |

## 8. 证据与最终放行记录

原始敏感数据、凭据、token、真实路径与 provider 请求体保存在本机私有位置；仓库只提交脱敏摘要、合成夹具和可公开截图。没有实际证据文件时不要建立假链接。

每项填写以下模板；历史矩阵/截图只能放“参考”，不能填入本轮结果替代执行：

| 字段 | 填写内容 |
|---|---|
| 验收 ID / 执行人 / 日期 | Axx 或 Bxx；实际执行者与时间 |
| 代码与产物 | 完整 SHA、候选版本、平台、产物名/SHA256（若适用） |
| 前置 | 环境、依赖、数据夹具、缓存/网络、provider 部署类型（无 key） |
| 操作/命令 | 可复现步骤或精确命令 |
| 预期 / 实际 | 输出摘要、数值、退出码、截图/日志（脱敏） |
| 结论 | 通过 / 失败 / 阻塞 / N/A；跳过须列原因，不能算通过 |
| 处置 | 复现用例、修复 SHA 与复测结果；或 Owner 例外裁决及影响 |

## 9. 已执行证据（2026-10-13 初次；2026-10-14 O-2 复测）

### A01 类型与单测（通过）

| 项 | 结果 |
|---|---|
| 基线 | `e45a04a82ce2e6cef2d913a4da42de1a3700a4c3`；初次为该基线，后续 O-2 验证含工作树未提交修改 |
| 前置 | Node v24.19.0 / pnpm 10.33.2 / uv 0.11.15；`pnpm install --frozen-lockfile`（195 包，锁文件一致）、`uv sync --directory py --all-extras`；端口 7788–7798 无残留监听 |
| bridge tsc | 退出码 0 |
| app tsc | 退出码 0 |
| bridge vitest | 19 文件 / 236 通过，退出码 0 |
| app vitest | 24 文件 / 260 通过，退出码 0 |
| Python pytest | Python 3.12.13，191 通过（无跳过），退出码 0 |
| 说明 | 测试日志含 teardown/ping 超时/bootstrap 回落信息；套件结果均通过。未从这些警告推定真实安装版启动成功或失败；`rssMB=null` 是 Windows 无 `/proc` 的现有限制 |

### A02 集成冒烟（通过，输出 `INTEGRATION_SMOKE_OK`）

| 项 | 结果 |
|---|---|
| 前置 | 端口 7788–7798 预先确认无监听，脚本自起 bridge，连接本次进程 |
| 鉴权与发现 | discovery 返回实际端口；WS 首条 `bridge.auth` 认证成功 |
| open / list | `cells=3 edges=2`、`n=1 kernelState=idle` |
| 尾表达式与隐私 | `c1=[text/html,text/plain]`、`c2=[text/plain]`；`agent mimeKeys=text/plain,text/html`，无单元格值泄漏 |
| schema / 反应式 | `df shape=4,3 columns=3`；改上游后 `staleSet=3` |
| 结论 | 退出码 0；覆盖 discovery/auth、打开、执行、尾表达式、隐私键名、stale 传递 |

### A03 初次无凭据画廊（16/16；含 O-2 观察，已复测修复）

| 项 | 结果 |
|---|---|
| 命令 | `node scripts/demo-gallery.mjs 01 02 03 04 05 06 07 08 09 10 12 13 14 15 16 00`（显式状态白名单，未跑 11 Agent） |
| 前置 | Chromium 已装；脚本自起 dev:bridge 与 dev:app（vite 备用端口 5299），退出时自停 |
| 结果 | `states ok=16/16`，退出码 0 |
| 关键证据 | 01 JetBrains Mono `fonts.check=true` 且复制钮 clipboard 读回一致；05 `⚡ side-effect` 徽章显示；15 导出 `.ipynb` 落盘 `demos/.novalab/sessions/`；15b import 回转 `.py` 开新 tab；00 Welcome 与 Connect 命令回报 |
| 控制台错误 | 1 条：`session.open（SessionModal 快照）失败: unknown sessionId: s-20261013T143800-d02a` → 初次登记为 **O-2**，处置见下方 O-2 记录 |

**初次记录时 A04–A18 均未执行；2026-10-14 后续已补 A04/A05 和 A07/A08 子项，见下方可信性加固记录。** 以上工程门与开发浏览器 UI 结果不证明候选安装包、真实 provider、真实 stdio MCP 或 Tauri 窗口验收通过。

### O-2 会话归属与后台 live 投影（2026-10-14 已复现、修复并完整复测）

**影响与定级**：会话内容读取/归属的功能回归。原后台 live 会话可能无法展开；仅把所有未结束段都当作当前 live 渲染，又会把当前 notebook 的 cells 显示在旧会话下。列为本次工程修复必过项；未发现 notebook 源码丢失。

**已验证的成因**：导入新 notebook 后，原内核仍存活，结束前没有磁盘 snapshot。旧 `session.open` 只检查焦点内核，后台 live id 因而落到磁盘分支并返回 `unknown sessionId`。同时，同目录 index 未区分 notebook；异步旧列表可能在切换后覆盖新列表。此前关于“嵌套目录导致快照错位”的解释不成立，已撤回；默认导出路径保持 `.novalab/sessions/`。

**复现证据**：新增后台 live、旧历史兼容、元数据路径与延迟响应用例先运行：bridge 3 个失败、app 2 个失败。修复后专项 bridge 40/40、app 32/32 通过；随后完整套件与构建通过（下方补录最终数）。

**修复**：router 按请求 notebook 的 context 投影 live，后台查询不切焦点；SessionModal 只有匹配当前会话/路径且非只读视图时使用编辑区富输出，其余查询所属投影。列表保留归属并丢弃过时响应，路径提交后补刷新。旧 index 从 snapshot 恢复归属；无法恢复的条目保持可见，不用“出现新记录就隐藏旧记录”的猜测。Windows 路径忽略大小写，其他平台保留大小写区别（本轮只在 Windows 运行，Linux 仍由对应平台验证）。

**范围**：新增回归验证后台投影、同目录隔离、原历史可见与列表竞态；画廊 15 增加真实进程与页面内容断言。真实 provider、stdio 共享审阅和安装版仍需各自验收。

### 2026-10-14 完整工程复测与构建

| 项 | 结果 |
|---|---|
| 代码 | 上述 HEAD + O-2 工作树修改，未提交；2026-10-14 fetch 确认与 origin/main 无新增差异 |
| 类型 | bridge `tsc --noEmit` 通过；app `tsc -b` 通过 |
| 单测 | bridge 19 文件 / 242 通过；app 24 文件 / 266 通过；Python 191 通过、无跳过 |
| 集成 | `INTEGRATION_SMOKE_OK`，退出码 0；运行前 7788–7798 无监听，脚本连接自起进程 |
| 生产前端 | `pnpm --filter @novalab/app build` 成功；主 JS chunk 1,354.47 kB（gzip 395.88 kB），有 >500 kB 提示，未据此声称性能达标 |
| bridge bundle | 275 modules / 1.6 MB；Node sidecar v24.19.0 / 88.5 MB（未压缩） |
| Python 资源 | 29 files / 0.7 MB；uv sidecar 0.11.15 / 63.5 MB（未压缩） |
| 最终画廊 | `node scripts/demo-gallery.mjs --skip-agent` → 16/16，退出码 0；11 明确 skipped；无页面 console 错误；15 态后台 live 投影/导入归属/不串执行 cells 全部通过 |
| 构建目录启动 | `PACKAGED_STARTUP_SMOKE_OK triple=x86_64-pc-windows-msvc`，退出码 0；运行前端口无监听，bundled node/uv/bridge 成功鉴权、打开 demo 并执行首格；使用同步 Python 资源为 source、现有 `py/` 环境为 runtime，非干净机器首启 |
| 日志 | 本机 `demos/.novalab/validation-20261014/`（gitignore）：types/build/tests/integration 输出；tsc 成功时无 stdout，结果在执行记录中。管道使用 pipefail；`manifest.json` 记录未提交源码与 sidecar 的 SHA256，避免把基线 SHA 冒充完整受测代码 |
| 限制 | 构建目录产物不等于候选安装包；产品版本仍为 0.1.0，版本与发布联动 B03 未关闭 |

第一次完整画廊复测在 15 态后被 bridge watcher 重启中断（执行期间改动了 bridge 文件）；在途 RPC 没有超时，任务由本会话停止。该次不记完整通过，保留 `gallery.log`。画廊自起 bridge 已改为 `start`（无 watcher），完整复跑另存 `gallery-final.log`。

### 2026-10-14 科研需求路线第一轮：可信入口与提议隔离

需求证据与阶段工作包见 [科研自动化迭代路线](research-iteration-roadmap.md)。本轮基线仍是上述 HEAD 加未提交修改；前一轮 bundle/完整画廊记录是其受测版本，不能用来替代随后源码变更的复测。

| 项 | 操作 / 实际结果 |
|---|---|
| A04 鉴权负例 | `pnpm --filter @novalab/bridge exec vitest run --config vitest.acceptance.config.ts`；真实子进程与私有 `NOVALAB_DATA_DIR`，从 manifest 核对 PID 后连接。缺/foreign Origin discovery 与 WS 均拒绝；错误 token/首条方法/坏 JSON/非对象值 1008 关闭，正确认证可工作；未认证客户端无 notebook 广播并到期关闭；重启 token 轮换，旧 token 失效。源码形态本机合成验收通过 |
| 新发现与修复 | `null` 为合法 JSON，但旧 WS 入口直接读取 `req.method` 导致真实 bridge 退出，负例扩展后 3 项失败；添加非空对象/非数组守卫后复测通过。覆盖认证前及认证后，正常连接仍可 ping |
| A05 本机代理 | 同一真实 bridge 使用隔离 provider 目录与无凭据本机上游；缺/错 token 401、foreign Origin 403、预检 204、正确调用 200；local token/占位 authorization/x-api-key/cookie/origin 不转发；上游关闭后 502，bridge 正常。未调用真实 provider |
| A07 纯预检子项 | 旧 `set_cells(candidate)` 再回滚留下 stale；真实 Runtime/stdio 复现并有失败回归。现为单次 `validate_cells`，无执行/文件写入；合法修改/插入和语法/重定义拒绝不改变控件/变量身份与值、源码/DAG/计数/stale；采纳才提交。hunk/手改/完整 fs 边界专项仍待执行，A07 不整项关闭 |
| A08 浏览器子项 | `node scripts/html-output-smoke.mjs http://127.0.0.1:5299/` → `HTML_OUTPUT_SMOKE_OK`；真实 Chromium 解析并渲染 OutputRenderer。表格替代 plain、fallback、span、双主题、20 000 节点注记、长/宽滚动与深输入通过；脚本执行 0、外链请求尝试 0、页面错误 0。内核显示上限已有测试，最终 Tauri WebView/原样 HTML 导出说明另验收，A08 不整项关闭 |
| 最终测试门 | bridge 默认 19 文件/242 通过；真实进程验收 2 文件/6 通过；Python 219 通过、无跳过；bridge tsc 通过。app 运行逻辑未变化（仅收紧 HTML 注释中的浏览器断言），沿用该轮 266 测试与此前构建证据，HTML 子项新增浏览器实测 |
| RPC 工作树验收 / 集成 | 读实际 diff 并独立复测；首版13项通过，反馈补 open/restart 环境准备长期限与坏响应清理，最终22项通过。已集成client/test/spec/CI；主线 `pnpm test:scripts` 22/22，真实 `INTEGRATION_SMOKE_OK`。默认普通期限20s，长操作可单独配置；超时只结束等待，不取消执行。精确进程发现另由独立任务处理 |
| 构建复测 | bridge bundle重新构建 275 modules/1.6MB；Python资源更新30files/0.7MB；Node/uv sidecar不变。集成后的构建目录 `PACKAGED_STARTUP_SMOKE_OK`，退出码0，仍不是最终安装包 |
| CI 入口 | 默认 Node job加入22项脚本回归，不执行需 Python 的 `.acceptance.ts`；integration job 在 uv sync 后显式运行独立验收配置；gallery job增加真实 HTML 浏览器检查。这里只验证本机命令，未声称远端 CI 已运行 |
| UI 补测 | `node scripts/demo-gallery.mjs 04 15 --skip-agent` → 2/2，退出码 0；Diff 提议与 Session 后台 live / 导入归属 / 不串执行 cells 断言通过；无页面 console 错误，已检查暗色 Diff / Session 与导入后截图。11 明确 skipped，未调用 provider |
| 证据 | gitignored `demos/.novalab/validation-20261014/` 中 `staged-only-*final*.log`、`html-output-final.log`、`rpc-client-integrated-final.log`、`integration-trust-final.log`、`packaged-trust-final.log` 和 `gallery-trust-affected-final.log`。本轮另存 `manifest-trust-round1.json` / `results-trust-round1.json`，保留此前 O-2 的 manifest/results；记录 HEAD 加未提交源码、构建与日志 SHA256。无 token/真实请求体/研究数据写入公开证据 |

### 2026-10-14 第二轮：保存与关闭可靠性（本包通过）

从 E04 的撤回/恢复需求与 intent M2/M8 出发，先在真实前端 store 上注入延迟 RPC 响应复现：旧保存 ACK 把更晚的草稿标 clean；切 tab 后 A 的 ACK 改写 B 的 dirty/DAG/stale；随后关闭会清空从未发送的新代码。该证据是内存客户端状态验证，不能扩大为最终安装版磁盘验收。

Bridge 新增 5 个受控用例先失败，修复后补第 6 个 Diff 队列用例；主线最终默认 248 项、真实进程 8 项与类型检查通过，另独立复测多 tab 16 项和真实持久化 2 项。显式 notebookId 保存、同本写入排队、关闭等待、失败保留内核/会话/草稿、恢复路径后重试均通过；不同 notebook 使用相同 cell ID 不串文件。前端最初 11 项交错回归在旧实现上均失败；最终共 22 项保存/关闭回归，全套 app 24 文件/288 项与生产构建通过。

| 项 | 操作 / 实际结果 |
|---|---|
| 保存 ACK / 归属 | notebook/cell/revision 绑定；旧 ACK 不清更晚草稿或其他 cell；后台 ACK 不覆盖当前 tab；延迟保存归属原 notebook。历史只读投影时只更新 live 缓存，返回 live 使用最新确认状态 |
| 关闭 / 失败 | 关闭前同步冻结该 tab 新编辑并 flush 所有草稿，等全部队列结算；保存或关闭失败保留 tab/cache/草稿与 role=alert + Retry；dirty ended 仍为未保存。失败队列不阻塞后续重试 |
| 真实浏览器 / 磁盘 | `node scripts/save-lifecycle-smoke.mjs http://127.0.0.1:5299/` → `SAVE_LIFECYCLE_SMOKE_OK`，退出码 0。真实 Chromium + 私有 bridge/kernel/文件：延迟 ACK 后继续编辑、同 ID 双文件、后台关闭 flush、CodeMirror 编辑后立即 UI close，文件正文正确。临时文件路径替换为目录造成写盘失败后，tab/草稿/可见错误保留；恢复路径并实际点击 Retry，最新代码落盘后关闭。页面运行错误 0；自身进程退出、临时目录删除 |
| 首轮脚本失败 | 初次两轮等待打开状态超时；诊断页面已打开两格，Vite 热更新后动态导入拿到另一 store 实例。重启本次预览服务后，同产品源码通过。保留 first/diagnostic 失败日志，不计为通过 |
| 独立工作树验收 | 已读隔离运行时/Windows launcher/main/client 实际 diff，按 hunk 集成；客户端原 22 项加显式连接 2 项，共 24/24。真实 Windows 进程先 12/12；主线补 LLM listener 端口占用回归，复现入口不退出后修复，最终 13/13。已有默认端口合成服务请求 0 且存活；自身 PID 全退出、临时目录移除、demo 字节不变 |
| 进程 / 平台边界 | Windows Job Object 在 bridge 执行前建立归属，bridge 提前死亡仍回收 kernel 后代；POSIX 独立进程组实现待 Linux CI 运行。信号用例验证 `process.emit` 处理器路径，不代表外部 OS 信号投递已测。无 Python Node job 仅跑 `.test.mjs`，真实 `.acceptance.mjs` 在 uv sync 后显式执行 |
| 受影响 UI | `node scripts/demo-gallery.mjs 02 04 08 12 15 --skip-agent` → 5/5，退出码 0；无页面 console 错误，O-2 内容断言通过；已查看多 tab/历史只读截图。HTML 浏览器复测通过（脚本执行 0、外链尝试 0、页面错误 0）。完整 16 态仍对应旧 O-2 轮；11 未执行 |
| 构建 / 集成 | 主线独立生产前端构建通过（主 JS 1,358.84 kB / gzip 397.04 kB，仍有 >500 kB 提示）；bridge 重建 275 modules / 1.6 MB。私有集成 CLI 在清理后输出 `INTEGRATION_SMOKE_OK`；构建目录 `PACKAGED_STARTUP_SMOKE_OK`，现有 Python 环境，无最终安装窗口验收 |
| 证据 | gitignored `demos/.novalab/validation-20261014/stage2-*.log`；另存 `manifest-save-round2.json` / `results-save-round2.json`，记录未提交源码、构建、资源与日志指纹。Python 本轮未改源码，沿用第一轮 219 项并核对同步资源；第一轮封存不覆盖。远端 CI 未运行 |

本包不包含原子写入、外部冲突或跨应用重启草稿恢复；也未处理完整崩溃/重启与执行队列，A15 保持未勾选。

### 2026-10-14 第三轮：执行队列生命周期（本包通过）

| 项 | 操作 / 实际结果 |
|---|---|
| 失败复现 | 真 stdio stop/restart 两项先红：run.started 与 queueDepth=2 通过，旧调用结算超过 3 秒。受控 transport 新增 12 项中 11 failed / 1 passed，既有 22 项未选中；复现旧执行跨代发送、旧 finally 放行和迟到通知污染 |
| 有界修复 | 停止/崩溃/重启拒绝普通 pending、active 与 queued；generation + active 身份保护发送/finally，transport 身份隔离迟到消息，load_file 续体不修改新核。busy 不 ping、FIFO、冷加载无自动执行保持 |
| 主线独立复测 | 默认 bridge 19 文件/260 项、真实验收 4 文件/11 项、tsc 均通过。真实生命周期 3 项直接运行 Python：stop/restart/终止自身子进程后，旧请求全拒绝，新核仅 load_file、计数 0，旧写哨兵不存在，新 REPL 可用；等全部自身 child close 后删临时目录 |
| 构建 / 集成 | bridge bundle 重建；私有目录、精确进程归属的集成 smoke 单列记录。本包未改前端/Python 运行逻辑，不把第二轮 UI 结果扩大到重启入口 |
| 证据 | 本机 gitignored `stage3-queue-*.log`；另存 `manifest-queue-round3.json` / `results-queue-round3.json`，保留红例与首次测试预期修正日志，不覆盖第一/二轮封存 |
| 新发现的证据限制 | `scripts/packaged-startup-smoke.mjs` 仍通过默认端口扫描连接，未核验自身 PID，成功标记早于后代清理。已登记独立修复；历史结果不删除，本轮无新的 packaged 运行放行 |

仅关闭 A15 的 supervisor 队列结算/代次隔离子项；dead/ended 前端重启、旧输出展示、未保存草稿恢复、bridge 重连与外部修改仍待独立验收，A15 保持未勾选。本机真实生命周期为 Windows 证据，不能外推 Linux 或最终 Tauri 安装版。

### 2026-10-14 Windows 构建目录 packaged smoke：进程归属与清理

本轮单列当前 packaged 验收；第二轮 `stage2-*`、`manifest-save-round2.json` / `results-save-round2.json` 与第三轮历史结论保持原样。长任务开工与集成前均 fetch 对比 `origin/main`，仍为 `e45a04a`；结果对应该 HEAD 加本工作树未提交内容，不能只凭 HEAD 复现。

| 项 | 操作 / 实际结果 |
|---|---|
| 有界修改 | packaged smoke 复用 `withSmokeBridge`，仅增加 launch 描述（node/main/cwd/env、可选 loader）；Windows Job launcher 无 loader 时直接执行 bundled bridge。临时合成 notebook 校验 `NOVALAB_PACKAGED=1`、绝对 uv 路径并计算 `42`，不打开 demos |
| 归属 / 清理 | 私有临时 data、32 字节随机 token、双端口 `0`；清单 PID/token/精确 loopback URL 核对后 `connect(info)`。保留 Windows 执行前 Job 与 POSIX 独立进程组；整树退出和临时目录删除后才输出成功 |
| 构建与真实执行 | `node scripts/build-bridge.mjs`、`node scripts/sync-py-resources.mjs` 均退出 0；275 modules / 1.6 MB、Python 32 files / 0.7 MB。本机 Windows 11 x64 / Node v24.19.0 / uv 0.11.15，复用 worktree `py/.venv`；进程表核对实际运行本工作树 bundled node/uv 与 Python；CLI 输出 `PACKAGED_STARTUP_SMOKE_OK`，退出 0 |
| 兼容回归 | 修改后客户端 `.test.mjs` 24/24、原共享 `integration-smoke.acceptance.mjs` 13/13，退出 0；既有归属/失败/信号处理器/并发场景保持 |
| packaged 专用回归 | `node --test --test-timeout=70000 scripts/packaged-startup-smoke.acceptance.mjs` 最终 12/12、无跳过。覆盖真实成功、已有 7788 discovery decoy 请求 0 且存活、HTTP discovery 调用 0、连接/打开后回调失败、WS/LLM 端口冲突、错误计算结果、RPC/总超时、bridge 死亡、SIGINT/SIGTERM/SIGHUP 处理器。每项核验已观测自身 PID 全退出、临时目录删除、失败无成功标记；成功标记输出时再次核验 PID/目录 |
| 首次失败保留 | 首轮 7 passed / 5 failed：总超时用例期间 decoy 收到 2 个请求，累计影响后 4 项；当轮没有来源元数据，归因未知，不能计为通过。增加无认证信息的请求元数据诊断后复跑 12/12、请求 0；最终再加独立禁止 fetch discovery 断言后 12/12、请求 0。原失败日志/results 独立保留，未弱化零请求断言 |
| CLI 失败负例 | 不存在的 source pyproject 路径 → `PACKAGED_STARTUP_SMOKE_FAIL`，退出 1，无成功标记，未启动 child |
| 历史 / 文件保护 | 新证据位于 gitignored `.novalab/packaged-ownership-win-20261014/`，包括初次 results/日志、诊断复跑、`manifest-final.json` / `results-final.json`。SHA256 核对 demos 全部非隐藏输入/产物、第二轮 manifest/results/`stage2-packaged-final.log`、第三轮 manifest/results 前后相同；未覆盖旧封存 |
| 平台 / 发布边界 | 只有本机 Windows 构建目录及现成 Python 环境证据。POSIX 进程组/Linux 真实运行待 Release CI；信号使用 `process.emit`，非外部 OS 投递。未验安装器/Tauri 窗口、干净机器首启/下载、BYO 或真实 provider；不关闭 A14，不扩充 A15 或正式发布范围。Release 已加入专用回归入口，远端 CI 本轮未运行 |

### 2026-10-14 第四轮：原子保存与外部冲突

| 项 | 操作 / 实际结果 |
|---|---|
| 原子保存失败复现 | 原先直接截断写入，部分 write / 编码 / close 失败可破坏原字节；改同目录临时文件、flush/fsync/关闭后 replace，失败保留目标且不截断回退。父专项 36 通过、4 项 POSIX 权限检查在 Windows 跳过 |
| 真实内容冲突复现 | 无 watcher 的后台 A 被外部增加/修改 cells 后，save 与 clean close 两项均静默覆盖；保留 soft 字节断言和错误码失败日志。修复为基线字节比较、`-32002` 与本地候选副本；删除也拒绝覆盖，副本失败仍拒绝写盘 |
| 协调与归属 | watcher 只通知；前端暂停所属 tab 自动保存、保留可编辑草稿；显式备份后冷加载与 save/accept/close 同队列。旧 ACK 不清冲突，后台/历史 ACK 只更新所属 live cache，备份或加载失败不提交新会话 |
| 新开文件隔离 | 真浏览器发现 B 继承 A 的临时 REPL；补 2 failed / 1 passed 红例后修复，再补 A→B→A 往返用例。新 owner 初始化干净缓存，重开已有 owner 恢复自身未发送草稿及运行切片 |
| 主线独立工程门 | bridge 默认 20 文件/269 通过、真实进程 5 文件/13 通过、tsc 通过；Python 258 通过、5 项 POSIX 权限检查跳过；客户端 24 通过；app 最终 25 文件/312 通过，生产构建通过（仍有 >500 kB chunk 提示） |
| 真浏览器冲突 | `node scripts/file-conflict-smoke.mjs http://127.0.0.1:5299/` → `FILE_CONFLICT_SMOKE_OK`；后台关闭拒绝覆盖、保留本地副本/草稿和 B 会话；显式后台加载不抢焦点，冷状态无旧输出/REPL；watcher 只提示；CodeMirror 编辑后加载失败保留，恢复路径后显式重试成功；副本再次打开保持持久 cell IDs/代码、计数 0 |
| 相邻链路复测 | 保存/关闭浏览器 `SAVE_LIFECYCLE_SMOKE_OK`；HTML 浏览器 `HTML_OUTPUT_SMOKE_OK`，脚本执行/外链尝试/页面错误均 0；私有 source integration 清理后 `INTEGRATION_SMOKE_OK`。Python resources 32 文件逐字节与源码一致；bridge 重建 275 modules / 1.6 MB；前端主 JS 1364.89 kB / gzip 398.53 kB，>500 kB 提示保留 |
| 打包并行交付父验收 | 已读实际 diff，独立串行 source 13/13、packaged 12/12 均退出 0、无跳过；默认端口诱饵请求 0 且存活，各项自身 PID 退出、临时目录删除通过。父首轮端口占用未进入正文、次轮额外请求失败均保留；停止预览后最终复测通过，额外请求的来源仍未确证 |
| 受影响画廊 | `node scripts/demo-gallery.mjs 02 04 08 12 15 --skip-agent` → 5/5，退出 0；O-2 后台 live / 导入归属 / 不串 cells 通过，无页面 console 错误；已看多 tab、历史只读、Diff、Session 与导入截图。11 明确 skipped，未调用 provider；完整 16 态仍是旧 O-2 轮。运行前备份夹具/索引/截图，旧诊断图和自建文件改可恢复归档 |
| 边界 | 副本只含持久 notebook 源码及未发送草稿，不恢复临时 REPL/变量/输出。POSIX 0600 与 Windows 目录继承 ACL 不等价；内容比较后替换仍有跨进程竞态，不是 CAS；不保证全部断电恢复。dead/ended 重启、bridge 重连与跨应用草稿恢复仍未验收 |

本轮原始日志为 gitignored `demos/.novalab/validation-20261014/stage4-*.log`；独立封存 `manifest-conflict-round4.json` / `results-conflict-round4.json` 记录未提交源码、最新前端产物、3 个 sidecar 与 32 个 Python resources 的 SHA256。保留修复前失败、测试夹具修正与环境阻塞日志。画廊原命令因删除动作被自动审批拒绝，两次均未执行；改备份/归档后通过。首次 owned 预览超时完成 Job/目录清理；最终 preview_stop 后 PID 已退出但临时目录仍在，父核对归属后清理，单列 `stage4-conflict-gallery-control.json`，不声称预览停止自动完整清理。之前三轮封存保持独立，不用新结果覆盖历史失败或扩大平台范围。A15 仍未整体关闭。

### 2026-10-16 第五轮：dead/ended 前端冷重启（Windows-only）

Owner 策略：clean dead/ended notebook 可显式冷重启；dirty dead/ended 一律拒绝、保留草稿、不覆盖磁盘、不新增自动恢复协议。基线 `e45a04a` 加未提交修改，fetch 后 `HEAD...origin/main = 0 0`；工作树由交接工作树逐字节复制（tracked diff 哈希相同、untracked 集合相同）后仅修一处 smoke 脚本缺陷，不能只凭 HEAD 复现。

| 项 | 操作 / 实际结果 |
|---|---|
| 实现范围 | `kernel.restart {notebookId}` 按 owner 寻址，进入同 notebook FIFO；`restartInFlight` 拒绝重复与 save/Diff/reload/close；成功只替换原 owner cache（outputs/Diff/`needsPersist`/计数/临时 REPL 清空，旧 session 结束、新 session 开），失败保留 dead 与旧状态可重试；冷加载只 `load_file`，不执行 cell、不重放 REPL/副作用 |
| 真实 Chromium UI | `node scripts/kernel-restart-smoke.mjs http://127.0.0.1:5299/` → `KERNEL_RESTART_SMOKE_OK`，退出 0（约 15 s）。真实 bridge/kernel/临时文件；按 PID 杀自身 A 内核 → tab `ended`/`dead`、只读；实际点击 SessionBar 状态与「Restart kernel」；重启在途切到 B，B 可见 cells 不变；放行后 A cache 冷加载为磁盘 `x = 1`，`kernel.restart` 恰 1 次，生成替换内核；A 改为 dirty 后再杀内核，点击重启被拒绝（调用数不变、草稿 `x = 99` 保留、`error.operation = restart`）；页面错误 0。Vite 进程表核对来自本工作树 |
| 首次失败保留 | 首跑全部业务断言通过后，脚本末尾 Node 上下文残留 `window.setTimeout;` 抛 `ReferenceError`，退出 1；改为在页面内恢复计时器并再次断言页面错误 0。第二跑虽输出成功标记，但 5299 实际由交接工作树的孤儿 Vite 提供（后台 shell 停止未结束 pnpm→cmd→node 链，本树 Vite 因端口占用退出），**判为无效、不计证据**；按 PID 结束该自身孤儿树、确认端口空闲后从本树重启 Vite 复跑为最终结果 |
| 真实 stdio router | `router.restart.acceptance.ts` 1/1：首次仅 `load_file`；崩溃后旧 active/queued 按 `-32000` 结算且不写禁止文件；restart 仅新增 `load_file`、计数归零、旧 output/Diff 清空；旧会话可 `session.open`；外改致保存失败后再 restart 被拒、外部字节保留、未新增子进程 |
| 工程门 | bridge/app 类型检查通过；app 生产构建通过（主 JS 1367.09 kB / gzip 399.08 kB，>500 kB 提示保留）；bridge 20 文件/274、app 25 文件/316；Python 258 通过、5 项 POSIX 权限/NTFS DACL 检查在 Windows 跳过；`pnpm test:scripts` 24/24 |
| 集成 / 构建目录 | `INTEGRATION_SMOKE_OK`；bridge 重建 275 modules / 1.6 MB，Python resources 32 文件与源码逐字节一致；`PACKAGED_STARTUP_SMOKE_OK triple=x86_64-pc-windows-msvc`，仅为构建目录回归，不是安装器验收 |
| 归属 / 清理 | 每个 smoke 均报告自身进程树退出、临时目录删除；最终复跑后无残留 `novakernel.server` 进程与 `novalab-integration-smoke-*` 目录；两个 Vite 进程树均按根 PID `taskkill /T` 结束并确认 5299 无监听。未停止任何非本包进程 |
| 证据 | gitignored `demos/.novalab/validation-20261014/stage5-restart-*.log`（复制时以 `<home>`/`<worktree>` 脱敏）与 `manifest-restart-round5.json` / `results-restart-round5.json`：270 个源码、3 个 sidecar、前端 dist 30 文件、32 个 Python resources 的 SHA256，平台/toolchain（win32/x64、Node v24.19.0、pnpm 10.33.2、uv 0.11.15、内核 Python 3.12.13、Playwright 1.63.0），命令与结果、失败/无效运行、owned PID 与清理；前四轮 manifest/results 指纹核对未变。无 token/凭据/真实研究数据 |
| 边界 | Windows-only；Chromium + Vite dev，非 Tauri WebView/安装器；内核死亡仅由自身 taskkill 诱发；dirty dead 只拒绝、不恢复。bridge 死亡→桌面重连、watchdog/session resume、跨应用或有界草稿恢复、macOS/Linux 未验证 |

本轮关闭 A15 的「clean dead/ended 前端显式冷重启 + dirty 拒绝保留草稿」子项（仅 Windows）；bridge 重连、草稿恢复与跨平台仍缺，**A15 保持未勾选**。

### 2026-10-16 第六轮：bridge 死亡→桌面重连（Windows-only）

Owner 裁决（2026-10-16）：D1 新一代 bridge 上线后 clean tab **等用户点击**才冷重开；D2 bridge 自动重启 **60 s 内最多 3 次**；D3 **断线期间允许继续编辑**。D4（跨代基线指纹 `baselineSha256` 协议字段）**未裁决、未实现**。基线 `bce0c2d`（第 1–5 轮）加未提交修改，分支 `claude/novalab-bridge-reconnect`；设计见 `docs/proposal-bridge-reconnect.md`。

| 项 | 操作 / 实际结果 |
|---|---|
| 实现范围 | 前端 `BridgeClient` 状态机 idle/connected/reconnecting/down：已认证连接关闭即以 `BridgeDisconnectedError` 结算全部 pending，每次重连都重新 discovery + `bridge.auth`（新 token → generation+1），有界退避后 down，「重试连接」重置预算；断线/down 期间新 RPC 立即失败，不排队、不重放。store：断线时运行中 cell 标 stale、保存定时器暂停、编辑只留草稿；新一代上线所有 tab 标 `bridgeLost`（`notebook.list` 合并不再抹 tab，同 path 新条目隐藏），只在用户点击后 `notebook.open` 冷重开并改键到新 id，不执行、不重放；dirty bridgeLost tab 拒绝重开/保存/关闭并保留草稿；同一实例重连补发草稿。Tauri：`RestartPolicy`（60 s 窗口 / 3 次 / 退避 1·2·4 s）+ 监督线程（`try_wait` 轮询，退出时先置 shutting_down 不误重启）+ `restart_bridge` 命令重置额度 |
| 先红后绿 | 新增 app `client.test.ts` 7 例与 `bridgeRecovery.test.ts` 13 例，实现前 18 失败 / 2 通过；Rust `RestartPolicy` 5 例 `todo!()` 桩 5 失败（首次因新工作树缺 sidecar 无法构建，生成后重跑）。两处测试自身缺陷已修并记录（初始 connected 事件被当成第一条；fixture 的 `notebook.list` 空响应异步抹 tab），产品逻辑未因此改动 |
| 真实 Chromium | `node scripts/bridge-reconnect-smoke.mjs http://127.0.0.1:5299/` → `BRIDGE_RECONNECT_SMOKE_OK`，退出 0。两代自有 bridge（Job Object 启动器）与真实内核/临时文件：A 长 cell 运行中按 PID 只杀 gen-1 bridge（非内核）→ 重连横幅出现、pending `cell.run` 以 `BridgeDisconnectedError` 结算、cell 标 stale；断线中切到 B 编辑成功（dirty），未发任何 save/run/notebook 写；断线期间外部改写 b.py；gen-1 Job 空、bridge 与两内核均消失，页面持续重新 discovery；harness 拉起 gen-2（新 token/端口）→ 页面重新认证，两 tab 保留为 bridge-lost 且可编辑，**无自动 `notebook.open`、gen-2 内核数 0**；点击 A「重新打开」→ 恰 1 次 `notebook.open`、改键、冷 cell（无计数/旧输出）、之后无 run/repl/restart/diff，gen-2 内核 1，中断 cell 未被重放（标记文件不存在）；B 重开被拒（`error.operation = reopen`）、草稿保留、磁盘保持外部字节；页面错误 0；自有 PID 18 个全部退出（按创建时间核对），临时目录删除 |
| 内核 EOF 探针 | 同脚本内单独启动自有内核：空闲内核在 stdin 关闭后约 16 ms 退出；忙内核执行完当前 3 s cell 后（约 2.7 s）才退出。生产（无 Job）中 bridge 死亡后忙内核会把当前 cell 跑完；Windows smoke 中旧内核由 harness Job 终止，不代表生产行为 |
| 失败 / 作废保留 | run 1：两处 harness 缺陷（"断线无写"把只读 `fs.root`/`session.list` 计入；进程树遍历因 PID 复用误收 OneDrive），收窄为写类方法并按创建时间过滤；run 2：业务全过，末尾 PID 复用误报；run 3、4 通过但分别因 PID 复用判定不严谨、失败路径不删临时目录被作废；run 5 为最终证据。run 1–2 遗留的自身临时目录核对后手动删除 |
| 工程门 | app 类型检查 + 生产构建（主 JS 1377.06 kB / gzip 401.69 kB，>500 kB 提示保留）；app 27 文件 / 336（+20）；bridge 类型检查、20 文件 / 274；Rust `cargo test --lib` 5/5、`cargo build` 通过；Python 258 通过、5 项 Windows 权限跳过；`pnpm test:scripts` 24/24 |
| 集成 / 构建目录 | `INTEGRATION_SMOKE_OK`；bridge 重建 275 modules / 1.6 MB，Python resources 32 文件与源码一致；`PACKAGED_STARTUP_SMOKE_OK triple=x86_64-pc-windows-msvc`，仅构建目录回归，不运行 Tauri 壳，不是安装器验收 |
| 归属 / 清理 | 每次启动 Vite 前确认 5299 无监听；三棵 Vite 树（根 5492 / 30692 / 31236，均来自本工作树）结束后逐 PID 核对已退出、无本树 vite 进程、HTTP 拒绝（最后 netstat 仍列出一条 pid 0 的 LISTENING 残行，无进程、无响应）。只杀过本 smoke 自有 gen-1 bridge PID；未停止任何非本包进程 |
| 证据 | 本工作树 gitignored `demos/.novalab/validation-20261014/`：`seal-reconnect-round6.mjs`、`manifest-reconnect-round6.json` / `results-reconnect-round6.json` 与 20 份 `stage6-*.log`（`<home>`/`<worktree>`/`<repo>` 脱敏）。276 个源码、3 个 sidecar、前端 dist 30 文件、32 个 Python resources 的 SHA256，toolchain（win32/x64、Node v24.19.0、pnpm 10.33.2、uv 0.11.15、内核 Python 3.12.13、rustc 1.94.1、Playwright 1.63.0），命令与结果、红跑/作废运行、owned PID 与清理。前五轮 12 份 manifest/results 位于基线工作树，仅读取并核对指纹未变 |
| 边界 | Windows-only；Chromium + Vite dev，非 Tauri WebView/安装器；bridge 重启由 harness 模拟 Tauri 监督完成，Tauri 监督线程只有策略单测与编译覆盖；down + 重试按钮仅单测；dirty bridge-lost tab 只能保留草稿（D4 未裁决）；忙内核在 bridge 死后会跑完当前 cell（Windows 无法按已退出父进程杀树）；草稿只在 WebView 内存 |

默认值（Owner 未单独确认，待确认）：Tauri 退避 1/2/4 s；超限后「重试连接」重置 Rust 额度并重启前端循环；前端重连预算 90 s、退避 0.25/0.5/1/2/4/5 s；断线期间及 bridge-lost tab 禁止运行/保存/Diff/REPL/重启。

本轮关闭 A15 的「bridge 死亡→桌面重连（clean 手动冷重开、dirty 保留草稿）」子项（仅 Windows）；D4 跨代基线指纹 / dirty 恢复、跨应用草稿恢复与跨平台仍缺，**A15 保持未勾选**。

### 2026-10-16 第六轮补充：D4 跨代基线指纹（Windows-only）

Owner 批准（2026-10-16）原话："D4 approved: add a baselineSha256 field to both the kernel and bridge protocols, as the proposal recommends." 第六轮正文保持原样作为 D4 前记录；本补充只追加。

| 项 | 结果 |
|---|---|
| 协议 | 内核 `load_file` 结果新增 `baselineSha256`（基线原始字节 SHA-256，含 CRLF），`save_file` 成功返回 `{ok:true, baselineSha256}`，-32002 拒写时不变；bridge `NotebookState.baselineSha256?` 与 `SaveResult.baselineSha256?`（`cell.save` / `diff.accept`），可选、只增不改，旧内核缺省 → 前端视为未知 |
| 前端 | 每个 tab 记录最后确认的指纹（open / reload / restart / switch / 保存与 Diff 接受 ACK 更新）；bridge 换代后 dirty bridge-lost tab 也显示「重新打开」：`notebook.open` 得到新指纹，与旧代一致 → 保留草稿、改键、恢复自动保存；不一致或未知 → 走第四轮冲突流程（暂停保存、可「保留本地副本并加载磁盘版本」） |
| 先红 | Python 13 失败 / 54 通过（3 个新指纹用例 + 10 处改用 `saved_ok()` 的保存断言）；bridge `router.baseline.test.ts` 4 失败；app `bridgeRecovery.test.ts` 4 失败 / 12 通过 |
| 测试改动 | 第六轮 "dirty tab 拒绝重开" 用例被 4 个 D4 用例替换（匹配续存、不匹配冲突、未知冲突、open/保存 ACK 记录指纹）；Python 精确 `== {"ok": True}` 断言改为 `saved_ok()`（同时校验指纹 = 磁盘字节 SHA-256，更严格） |
| 工程门 | app vitest 339（27 文件）、生产构建（含 `tsc -b`，主 JS 1377.93 kB）；bridge `tsc --noEmit` + vitest 278（21 文件）；Python 261 通过 + 5 跳过；Rust `cargo test --lib` 5 + `cargo build`；`pnpm test:scripts` 24；sidecar/py-resources 重建后集成 smoke 与构建目录 packaged smoke 通过 |
| 真实 Chromium | 同一 `scripts/bridge-reconnect-smoke.mjs` 扩为三 tab，一跑通过 `BRIDGE_RECONNECT_SMOKE_OK`：gen-1 c.py 指纹等于磁盘字节 SHA-256；断线中编辑 B、C 均不发写；gen-2 三行三个重开按钮、内核 0；A clean 冷重开同前；**B（断线期间被外部改写）→ 冲突流程，草稿保留可见，未发 `cell.save`，磁盘保持外部字节**，点击「保留本地副本并加载磁盘版本」后加载外部版本、文件旁副本含草稿、tab 指纹 = 外部字节；**C（磁盘未变）→ 草稿自动保存落盘、tab 变 clean、指纹推进为新字节**；中断 cell 未重放；页面错误 0；自有 PID 31 个全部退出，临时目录（含恢复副本）删除 |
| 归属 / 清理 | 启动 Vite 前确认 5299 无监听；Vite 根 cmd 12284（→ pnpm 24164 → node 27516）由 preview_stop 结束，`taskkill /T` 复核无残留、HTTP 拒绝（仍有已知 pid 0 残行）。只杀本 smoke 自有 gen-1 bridge PID |
| 证据 | 本工作树 gitignored `validation-20261014/`：`seal-reconnect-round6-d4.mjs`、`manifest-reconnect-round6-d4.json` / `results-reconnect-round6-d4.json` 与 16 份 `stage6d4-*.log`（脱敏）。277 个源码（较第六轮变 20 个，含第六轮封存后追加的文档）、sidecar、dist、Python resources 的 SHA256；第六轮 manifest/results/seal 与其 20 份日志、前五轮 12 份封存均只读核对未变 |
| 边界 | Windows-only；Chromium + Vite dev，非 Tauri WebView/安装器；未知指纹（旧内核）按"已变"处理；字节完全还原的外部编辑视为未变；忙内核在 bridge 死后仍跑完当前 cell；草稿只在 WebView 内存 |

本补充关闭第六轮遗留的「dirty bridge-lost tab 跨代恢复（D4）」（仅 Windows）；跨应用草稿恢复、生产环境旧内核清理与跨平台仍缺，**A15 保持未勾选**。

### 2026-10-17 Agent 安全小包：F2 多格 diff 队列 + execute_cell 过渡确认（Windows-only）

Owner 原话："F2 和 execute_cell 过渡确认，先作为一个小包修掉，再进入 ADR-013 实现。"分支 `claude/novalab-agent-safety-fixes`，基于重试提交 56fd8b1。

| 项 | 结果 |
|---|---|
| F2 | `diff.stage` 有待审 diff 时验证「当前」与「叠加全部待审」两次；`dependsOn` / `conflictsWith` / `hint`；`diff.accept` 依赖未采纳或已被拒时在改动前拒绝；前端依赖 chip 与 Accept 拒绝原因；system prompt 与工具描述写明搬移定义的两步顺序 |
| F3 | `diff.stage` 排在 notebook 写队列上（并发工具调用按到达顺序） |
| compileError | 真实内核回传纯字符串，旧实现使被拒的 `propose_code_change` 在 M5 第二道闸整条被替换为占位文本；现在 stage 边界解析为 `{message, cellIds}`。`cell.save` / `diff.accept` 仍原样转发（app 两种都认），协议类型改为 `CompileError \| string` 如实描述 |
| execute_cell | `agent.executeCell` 逐次确认：`agent.confirmRequest` → `agent.confirmResponse`（先到先得）→ `agent.confirmResolved`；拒绝 / 超时 120 s / 切 notebook / 源码变更 → `{denied, reason, message}`；`--mcp` 无确认者一律拒绝；M5 白名单加入 denied 形状（未知 reason fail closed） |
| 先红 | router F2 5 失败 / 1 通过；F3 并发 1 失败；确认握手 9 失败；真实内核验收 1 失败（字符串 compileError）后又暴露 cellIds 捕获组错误，均修正 |
| 工程门 | bridge `tsc --noEmit` + vitest 315（25 文件）；app `tsc -b` + vitest 388（29 文件）+ 生产构建（主 JS 1387.15 kB）；Python 261 + 5 跳过；`pnpm test:scripts` 24；真实内核验收 17（7 文件）；集成 smoke + acceptance；sidecar / py-resources 重建；构建目录 packaged smoke + acceptance |
| 真实 Chromium | 新 `scripts/agent-safety-smoke.mjs` 通过：确认弹窗显示源码且默认焦点「拒绝」，拒绝不执行，允许后执行；F2 两条 diff，`依赖 diff-1` chip 可见，乱序 Accept 被拒并显示原因、cells 不变，按序采纳后 helper 进入新 cell。kernel-restart / bridge-reconnect / file-conflict / save-lifecycle / html-output 复测通过 |
| 证据 | 本工作树 gitignored `validation-20261014/`：`seal-agent-safety.mjs`、`manifest-agent-safety.json` / `results-agent-safety.json` 与 `stage-safety-*.log`（脱敏）；此前全部封存只读核对未变 |
| 边界 | Windows-only；Chromium + Vite dev，非 Tauri WebView / 安装器；确认超时只有单测；未用真实模型复测；外部 MCP Agent 不再能执行 cell（行为变化，已写入 `docs/mcp-demo.md`） |

**A15 保持未勾选。**

### 当前放行结论

- [ ] Owner 已确认本版范围、建议发布门与 ADR-011。
- [ ] B01–B07 全部关闭（B02 本工作树工程/skip/O-2 与完整画廊已关闭；其余仍未关闭），F/K 保留项有明确裁决与公开披露。
- [x] O-2 已先补失败用例、复现并按会话内容读取回归处理；代码修复与工程复测通过。
- [ ] 适用 A01–A18 对同一候选代码/产物完成，失败/跳过/N/A 均有处置。
- [ ] Windows/Linux 四种最终产物与版本可追溯，安装后桌面链路有证据。
- [ ] CHANGELOG/README/功能矩阵与候选能力一致，不宣称未验收的平台/provider/性能。
- [ ] Owner 明确授权正式发布（本轮没有）。

**结论：工程门、生产前端与 sidecar 构建已通过，O-2 已补失败回归并修复。B01/B03–B07 仍未关闭，尚不具备正式发布条件；本轮未提交、未发布。**

RPC 与进程隔离两个独立工作树已验收并集成；保存/关闭、执行队列、原子写入与外部冲突已分别完成子包验收。packaged 归属修复也已落地主线并由父独立复测。接下来按科研迭代路线推进 dead/ended 前端重启、bridge 重连与草稿恢复，再到共享 Agent 可信性、环境/运行可复核、候选构建、安装版和真实科研工作流、性能及剩余处置。ADR-011 仍为提案。提交/发布仍另行决定，工程通过不自动授权。

工作区卫生：17 个确认来自 demo 的旧导出/回转副本已移入 `demos/.novalab/gallery-archive/`（gitignore），可恢复。夹具正文与 HEAD 一致；自动审批拒绝了 `git restore`，故保留换行格式差异，原始字节已备份到 `demos/.novalab/fixture-backup-*`。未执行强制清理。
