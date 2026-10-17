# 科研自动化迭代路线与证据台账

> 2026-10-14 · 上游：[原始 intent](intent.md)、[架构与语义](spec.md)、[实施计划](plan.md) · 当前验收：[v0.1.1 清单](release-v0.1.1-checklist.md)
> 本路线按 Owner 授权自主推进常规优化、修复与验证；只在产品边界、数据保留/外发、核心技术路线等重大节点请求裁决。版本号、提交与公开发布另行授权。

## 1. 迭代目标

保持 intent 的三个目标：**状态永远可信、修错零摩擦、数据不出门**。其工程含义分别是代码/变量/输出/执行记录一致或明确 stale，Agent 修改经过可检查的提议与人工采纳，以及原始输出留本机、允许的代码/traceback/DAG/schema/head(1) 外发可见可核验。后一个目标不是“模型完全不接收数据”。

优先级由现有承诺的正确性、实际科研需求和复现证据共同决定。先消除数据丢失、状态污染、错误进程验收与不可结束的等待，再增加复现信息、真实共享 Agent 和交付能力。公开 issue 证明某种需求存在，不能代表市场规模或所有版本的缺陷率。

本阶段继续保持单文件/单内核、Python、纯 .py 主存储、mark-only 默认策略与 staged-only Agent 写入。自动重放副作用、云同步、多人实时协同、非 Python、.ipynb 双向主存储和通用 IDE 不在本路线默认范围内。

## 2. 公开需求证据（检索截止 2026-10-14）

“研究实证”“用户反馈”“维护者回应”的证明力度不同；关闭 issue 表示维护者记录的解决状态，不等于本项目独立验证该版本。以下数字仅用于说明各自研究范围。

| ID | 日期与来源 | 可支持的需求与适用范围 | 本项目映射 |
|---|---|---|---|
| E01 | 2025-03-16，[How Scientists Use Jupyter Notebooks](https://arxiv.org/html/2503.12309v1)；[ICSE 2025 官方记录](https://conf.researchr.org/details/icse-2025/icse-2025-research-track/201/How-Scientists-Use-Jupyter-Notebooks-Goals-Quality-Attributes-and-Opportunities) | 同一机构 20 位科学家的观察/访谈：输入文件修改后漏跑，原地修改 DataFrame 后残留状态干扰重试，结束时不能顺序重现结果；11 人在观察中使用 AI，部分人无法判断解释。不能外推总体发生率。 | N1/M1 状态可信；N2/N3 人工检查与运行证据；阶段 1、2、4 |
| E02 | 2024-01-11，[GigaScience：生物医学 notebook 计算复现](https://academic.oup.com/gigascience/article/doi/10.1093/gigascience/giad113/7516267)；[2023 预印本](https://arxiv.org/abs/2308.07333) | 收集 27,271 个 notebook，15,817 个 Python notebook 选入自动重跑；1,203 个无错误完成，879 个输出相同。依赖、导入、缺失文件是主要障碍，执行顺序/随机性/动态数据也可能造成差异。不能说所有失败都由隐藏状态造成。 | N1/N4 环境、文件引用、可复核运行；阶段 2、4、5 |
| E03 | 2025-02-20，[AI Scientist 独立评估 v1](https://arxiv.org/html/2502.14297v1)；[版本日期](https://arxiv.org/abs/2502.14297v1) | 特定 MovieLens/Green Recommender Systems 任务中，12 次尝试有 5 次执行失败，其余 7 篇生成稿有 4 篇包含错误或幻觉数值。没有重跑比较基线、声称改变参数但实际未改变，是具体失败模式。不能泛化到全部 Agent 或把合并统计当纯编造率。 | N2/N3 参数→运行→结果链与人工审阅；阶段 3、4 |
| E04 | 2026-02-06，[Cursor notebook 修改无法撤回报告](https://forum.cursor.com/t/critical-data-loss-bug-cursor-agent-changes-in-jupyter-notebooks-cannot-be-undone-or-reverted/151038) | 单用户报告 undo/checkpoint 无法恢复已接受的 cell 修改；官方 2026-02-20 表示应在 2.5 修复。未独立测试修复，不能称目前仍普遍存在。 | M4/M8 可恢复写入、采纳前后版本；阶段 1、2、3 |
| E05 | 2023-09-25，[Jupyter AI #397](https://github.com/jupyterlab/jupyter-ai/issues/397)，2025-02-04 completed | 用户因敏感代码与数据要求内部 FastChat/兼容端点和模型选择；维护者后来提供兼容端点支持。是机构内部模型需求，不是泄露报告。 | M5/M6 内部/本地端点与外发边界；阶段 1、3 |
| E06 | 2025-03-06，[Cursor .env 忽略规则反馈](https://forum.cursor.com/t/env-file-question/60165) | 官方承认历史版本 Tab 上下文包含近期编辑但已忽略文件的 bug，表示 v0.47 已修复。补全中出现秘密不等于此线程证明第三方实际收到秘密；保留/训练/传输是不同承诺。 | M5 工具结果和上下文逐通道哨兵验证；阶段 1、3 |
| E07 | 2024-06-05，[VS Code Jupyter #15746](https://github.com/microsoft/vscode-jupyter/issues/15746)，2024-07-30 completed | Remote SSH 下 Run All 顺序回归；用户 2024-07-19 测试版无法再复现，维护者记录修复。支持可靠排队/取消的需求，不证明 VS Code 长期无顺序保证。 | M1/M7 运行队列、崩溃取消；阶段 2 |
| E08 | 2024-10-11，[marimo #2598](https://github.com/marimo-team/marimo/issues/2598)，2026-01-12 completed | 多 notebook 独立 Python/PEP 723 环境请求；维护者记录通过 PR 解决。不能称当前 marimo 缺少独立环境。 | N1/N4 环境身份、错配提示；阶段 4 |
| E09 | 2025-09-08，[marimo #6282](https://github.com/marimo-team/marimo/issues/6282)，2025-09-09 not planned | 跨 cell `x += 1` 被单定义约束拒绝；维护者解释这是刻意保持无额外状态的设计。支持迁移解释与可审阅改写，不要求放弃响应式保证。 | M1/N3 编译错误说明、迁移帮助；阶段 3、4 |
| E10 | 2025-02-05，[marimo #3692](https://github.com/marimo-team/marimo/issues/3692)，检索时 open，所见追问至 2026-04-07 | 希望 Markdown 连同输出导出，供不安装 notebook 环境的读者使用；维护者提供多命令 workaround。源码、图表、单文件分享和可 diff 产物存在取舍。 | N4/S2 带输出交付和执行来源；阶段 5 |
| E11 | 2025-09-11，[marimo #6318](https://github.com/marimo-team/marimo/issues/6318)，2026-06-02 completed | 管理员要求关闭导出的 WebAssembly 分享入口。维护者澄清代码在 URL fragment、不随 HTTP 请求发服务器；不能当已确认上传证据。有效需求是控制源码包含和外部分享入口。 | M5/N4 分享前选择和边界说明；阶段 5 |

### 原 intent 的竞品假设处理

intent §2 原有的“marimo Agent 仅补全级”“交付弱”“四者交集无人占据”是立项假设，本次复核不支持。marimo 官方文档已有超出补全的能力；以下页面未注明可核实的产品版本/发布日期，均以 2026-10-14 检索日标识，属于厂商能力说明而非独立体验验收。

| 当前官方页面 | 可确认的能力 | 比较边界 |
|---|---|---|
| [AI assistant](https://docs.marimo.io/guides/editor_features/ai_completion/) | Manual/Ask/Agent/Code 模式；MCP 只读工具、增删改 cell、运行 stale cells、检查 kernel；Ollama/OpenAI-compatible 端点 | 直接纠正“仅补全级”；未据此判断审计、撤回或科学结论质量 |
| [Agents](https://docs.marimo.io/guides/editor_features/agents/) | 实验性 ACP sidebar 接 Claude Code、Gemini、Codex ACP、OpenCode；可编辑文件、默认标 stale；可经 OpenCode 接本地模型 | ACP 与 MCP 是不同集成；experimental，每 provider 一会话 |
| [Exporting](https://docs.marimo.io/guides/exporting/) | HTML/PDF/.ipynb/Markdown/WebAssembly HTML/依赖排序 Python/JSON session 与发布集成 | 纠正笼统“交付弱”；Markdown 带全部输出的特定请求仍见 E10，格式存在不等于全部保真 |
| [Sandboxes](https://docs.marimo.io/guides/package_management/sandboxes/) | 每 notebook uv/Pixi 环境、PEP 723 依赖与 Python 约束、传递依赖 lockfile | 是依赖环境隔离，代码仍能访问文件与网络；外部数据/平台/随机性另处理 |

后续比较按具体版本、部署方式与工作流核验；不将已关闭 issue 当作当前缺陷，不将营销功能声明当作科研任务验收。NovaLab 的差异应通过敏感本地数据、真实共享审阅、可靠保存/恢复和交付结果证明。

## 3. 统一闭环与运行规则

每个工作包遵循 **需求证据 → 最小失败用例 → 有界修改 → 实测验收 → 文档/限制更新 → 下一包**。问题登记至少包含 intent ID、证据或复现、影响、所属文件、验收方法、实际结果。源码实现、单测、开发 UI、构建目录、最终安装版、真实科研任务分开记录。

常规事项：以安全默认保留两份冲突内容、明确失败状态、取消已结束进程的等待、纯静态预检、隔离测试数据/上游、补准确协议和说明，自主推进。新问题必须先确认再修，不以静态怀疑直接记为已证实缺陷。

并行事项：明确文件归属；子工作树交付必须读 diff、独立复测和核验兼容调用点。长任务开工/集成前 fetch origin/main；重叠处沿用 main 的实现。只停止本次拥有的服务，不读取真实凭据，不修改真实科研文件作为破坏性测试。

完成门：保留日志与受测源码指纹；受影响类型/测试/集成通过，失败与跳过如实记录。每轮结束重新评估剩余风险，不能把某个脚本退出码扩大成完整发布放行。

## 4. 分阶段工作包与验收门

阶段以结果为门，不预设发布日期。范围可以根据复现和 Owner 自用反馈调整；新增范围要写入证据台账。

| 阶段 | 优化 / 新增 / 修复 | 验收与复盘条件 | 重大决策边界 |
|---|---|---|---|
| **1 可信入口与提议隔离（第一轮已封存）** | 验收并集成独立 RPC 客户端修复；避免错误进程被当本次受测对象。新增真实 HTTP/WS/代理负例与 HTML 浏览器检查。修复非对象 JSON 导致 bridge 崩溃、Diff 预检污染内核状态。 | 断线/发送失败/超时结束全部 pending，无 timer 遗留；长任务覆盖短默认期限仍按显式策略工作。A04/A05 自动检查、A08 浏览器子项；合法/非法候选均不改变 globals/controls/counts/stale/源码，采纳才更新。完整受影响测试通过。 | ADR-011 是否正式接受；CSP/保真富 HTML 或扩大外发范围另裁决。纯健壮性修复无需停。 |
| **2 保存、恢复与执行生命周期（当前）** | 原子保存、按 notebook/revision 确认保存；关闭失败保留上下文与草稿。外部编辑冲突保留双方版本。完成 clean dead/ended owner 的显式冷重启、同 notebook FIFO 与 owner 隔离；dirty dead tab 保留草稿并阻止重启，后续另做 bounded 草稿恢复与 bridge reconnect。 | 临时目录模拟写入失败、保存期间编辑/切 tab、外部改动；原文件和草稿均可恢复。杀本次内核后 clean restart 可用、queued promises 全结束、旧输出不伪装为新结果、A→B 延迟响应不串 owner。A15 仅按已验子项记证据。 | 自动三方合并策略、自动执行/副作用重放、dirty dead 自动覆盖或自动备份；默认不静默合并或重放。 |
| **3 同一 notebook 的可审阅 Agent** | 真实 stdio MCP 复现/修正共享实例；薄 adapter 连接已认证桌面 bridge，绑定 notebook，避免另起不可见内核。完善多格 Diff 队列、接受/撤回与审计；响应式约束提供具体可改写说明。 | 无真实 LLM 的 stdio 客户端证明 cell IDs/执行计数一致、提议出现前端、拒绝文件不变、接受同核执行。哨兵检查 app/MCP 工具与代理边界；真实 provider N2/N3 另记。 | 多 Agent 同时切焦点/互相采纳、远程 MCP；真实模型外发内容与预算需确认。 |
| **4 可复核的运行与环境** | 检查 `.venv` 实际就绪、部分安装恢复、资源版本匹配；展示解释器/库/lock 指纹与环境来源。会话准确记录 actor、源码 revision、执行与参数来源；恢复孤儿索引/本地 checkpoint。提供合成人口/POI N1 工作流和响应式迁移示例。 | 干净重跑与基准计算一致；缺文件/依赖/环境错配可解释。相同输入/参数/环境的运行能找到对应结果；不把“运行成功”说成科学结论有效。真实 scipy/geopandas 用实际库验收。 | 每 notebook 环境求解/自动装依赖、数据文件内容哈希、完整 prompt/富输出保留与保留期；需要隐私/空间裁决。 |
| **5 可交付产物与真实安装体验** | 验证 live .ipynb 图表/计数/HTML 和导入降级；优化 App View、长/宽输出和分享说明。整理版本映射、防错门、候选构建/安装、离线准备/失败恢复、性能证据。 | N4 收件人实际打开产物；.py 重开保持 IDs/代码，交付能识别运行来源。Windows/Linux 四种产物逐项安装/启动；A14/A18 与同一候选源码关联。Owner 合成演练后再使用私有数据。 | 新增 standalone HTML/Markdown 发布、历史富 MIME 持久化、离线依赖分发、性能阈值例外、签名/正式发布。 |

## 5. 第一轮记录

基线为 `e45a04a82ce2e6cef2d913a4da42de1a3700a4c3` **加本工作树未提交修改**；不能用该 SHA 单独标识本轮受测代码。此前 O-2 修复与工程结果见验收清单 §9。

| 包 | 当前结果 | 下一步 / 限制 |
|---|---|---|
| RPC 修复工作树验收 | 已读实际 diff并独立复测；首版13项通过，退回补 open/restart 长期限兼容及坏消息清理，最终22项通过；client/test/CI/文档按 hunk 集成 | 主线 `pnpm test:scripts` 22/22、`INTEGRATION_SMOKE_OK` 与重建目录 `PACKAGED_STARTUP_SMOKE_OK`；期限仅结束等待、不取消服务端执行。精确 discovery/fixture/异常清理由 Owner 启动的另一独立工作树处理，主线负责后续验收 |
| A04/A05 真实入口 | 新增 `bridge/src/main.security.acceptance.ts`：独立子进程/数据目录、私有 manifest PID 核对、Origin/token/广播/重启轮换、本机代理上游/头剥离/不可达 | 扩展 `null` 负例真实发现进程崩溃（3 项失败），修复对象形状守卫后 5 项通过；最终独立真实进程套件共 6 项通过（含纯预检）。无真实 provider |
| A08 浏览器子项 | `scripts/html-output-smoke.mjs` 真实 Chromium 调用生产 parser 与 OutputRenderer；富表替代 plain、fallback、双主题、span、节点预算、长/宽滚动、深输入通过；脚本执行 0，哨兵外链请求尝试 0，页面错误 0 | 开发 Chromium 证据，非最终 Tauri WebView。内核 1e6 字符上限和原样导出说明分别核验；ADR-011 仍待裁决 |
| Diff 预检 | 真实 Runtime 与 stdio 复现：候选/回滚后源码恢复但 stale 残留；删除/恢复还会影响变量、控件、计数 | 已改纯 `validate_cells`；Python 全套 219、bridge 默认 19 文件/242、真实进程 2 文件/6、bridge tsc 均通过；已审阅实际 diff，保留原 O-2 修改 |
| 集成、构建与 UI | 真实 bridge/kernel 冒烟通过，重建 bridge bundle 与 Python 资源后构建目录启动通过；Diff / Session 补测 2/2，后台 live / 导入归属 / 不串执行 cells 通过，无页面 console 错误 | 已检查受影响截图；证据另存本机 `validation-20261014/manifest-trust-round1.json` / `results-trust-round1.json`，保留旧 O-2 记录。开发浏览器与构建目录证据不等于最终安装版 |

## 6. 第二轮记录：保存与关闭（本包已验收）

已在真实前端 store 上用内存 RPC 夹具复现：旧保存 ACK 将更晚的草稿标 clean，随后关闭清空从未发送的新代码；切 tab 后 A 的 ACK 还会覆盖 B 的 dirty / DAG / stale。该证据验证客户端状态与关闭链，尚未证明最终安装版文件系统行为。后续用 deferred 回归、临时文件与真实 bridge 验证，不对私有科研文件注入故障。

本轮有界修复为 notebook/cell 版本确认、绑定归属的延迟保存、同 notebook 保存/关闭排队，以及失败保留草稿并可见重试。原子写入、外部冲突、进程崩溃后草稿恢复与重启/执行队列另有验收包。第一轮封存记录保持不变，第二轮结果另存。

Bridge 部分先补 5 个失败回归再修复，新增第 6 个 Diff 写入队列用例；最终默认套件 248、真实进程验收 8、类型检查通过。主线独立运行真实持久化 2 项与多 tab 16 项：后台 A 两次保存与关闭排队、B 并行保存不串文件；临时路径写盘失败保留草稿/会话/内核，恢复后重试落盘。前端最初 11 个交错回归在旧实现上全部失败；修复后共 22 个保存/关闭回归通过，完整 app 288 项与生产构建通过。历史只读投影期间的 ACK 只更新 live 缓存，返回 live 不恢复旧确认状态。

`scripts/save-lifecycle-smoke.mjs` 使用真实 Chromium、bridge/kernel 和临时文件：延迟真实保存 ACK 后继续编辑、相同 cell ID 的两个 notebook、后台关闭 flush、CodeMirror 编辑后立即点击关闭，均验证磁盘正文；把临时目标路径换成目录制造写入失败，验证 tab/草稿/错误保留，恢复路径后实际点击 Retry，最新代码落盘后才关闭。最终输出 `SAVE_LIFECYCLE_SMOKE_OK`，页面运行错误 0。首次两轮因运行中 Vite 热更新造成脚本动态导入另一 store 实例而超时；页面已正常打开，重启本次预览后同产品源码通过，失败日志保留。

独立进程隔离工作树已读 diff、按增量集成并由主线复测：客户端 24 项、Windows 进程验收先 12 项通过；主线增加 LLM listener 占用失败用例，发现入口不退出，修复为明确失败退出，最终 13/13。私有 manifest/PID/token/精确 URL 直连、独立临时夹具、失败/超时/处理器/并发清理均通过；不接管已有默认端口服务。Windows Job Object 在 bridge 运行前建立归属；POSIX 实现待 Linux CI 实测，信号用例只验证 `process.emit` 处理器路径。真实内核 `.acceptance.mjs` 与无 Python 的客户端 `.test.mjs` 分开。

受影响画廊 02/04/08/12/15 为 5/5，O-2 断言通过、无页面 console 错误；HTML 浏览器复测通过。前端生产构建、bridge 重建、集成 CLI 与构建目录启动均通过；Python 源码未改，沿用第一轮 219 项证据并核对资源指纹。第二轮另存 `manifest-save-round2.json` / `results-save-round2.json`，第一轮封存保持不变。A15 仍待原子写入、外部冲突、崩溃/重启与执行生命周期后续子包，未整体关闭。

## 7. 第三轮记录：执行队列生命周期（本包已验收）

对应 intent M1/M7 与 E07 的可靠执行需求。真实 stdio 先补 stop/restart 两项：长执行已开始、另两项排队后结束旧核，两个用例均因旧执行 promises 未结算而失败。受控 transport 的 12 项新增回归有 11 项失败、1 项通过（22 项既有测试未选中），进一步证实发送前重启让旧执行进入新核、旧 finally 放行并发执行、迟到通知污染和旧 load_file 续体干扰新核。

修复为可结算的 active/queued 项与生命周期代次；旧发送、执行 finally、transport 消息和 load_file 续体仅能操作自身代次。主线已读实际 diff，并独立运行默认 bridge 19 文件/260 项、类型检查、真实验收 4 文件/11 项，均通过。真实生命周期其中 3 项覆盖 stop/restart/直接终止本次 Python 子进程；已发送与排队调用全部拒绝、新核仅 load_file、执行计数归零、旧排队写文件哨兵不存在，之后新 REPL 可运行。每项等自身子进程 close 后清理临时目录。busy 不 ping、FIFO 和不自动重放保持；取消不会撤销停止前已经发生的副作用。

bridge bundle 已重建；私有 bridge/kernel 集成结果与本包源码、产物及日志分别记入 `manifest-queue-round3.json` / `results-queue-round3.json`。前端/Python 运行逻辑未改，本包不代表 dead/ended UI 重启入口、草稿恢复、外部冲突或 bridge 重连已验收，A15 仍未整体关闭。已另登记打包启动脚本的进程归属缺口：它仍扫描默认端口、成功标记早于后代回收；历史结果保留，本轮不把它当新的 packaged 运行验收，修复及独立复测待完成。

## 8. Packaged 启动归属修复记录（2026-10-14，Windows 构建目录）

packaged smoke 已复用已验收的共享 `smoke-runtime.mjs` / `smoke-win32.ps1`，有界增加 bundled 启动描述与可选 loader。实际执行 bundled node + bridge + uv、`NOVALAB_PACKAGED=1`，临时合成 notebook 检查环境并计算 `42`；私有随机 token/data、OS 分配端口、manifest PID/token/精确 URL 直连与整树清理共用现有路径。成功只在全部自身进程退出与临时文件删除之后输出。

本机 Windows 11 x64 修改后客户端 24/24、原共享进程验收 13/13；新增 packaged 12/12，覆盖 decoy 请求 0 且存活、无 HTTP discovery、回调失败、端口冲突、错误结果、RPC/总超时、bridge 死亡和信号处理器。进程表验证 bundled node/uv 与真实 Python 实际执行；CLI 成功退出 0，缺产物负例退出 1 且无成功标记。首轮 decoy 两次请求造成 5 项失败，归因未知，失败日志保留；诊断复跑及最终严格断言版均为 12/12、零请求。

新证据单列 gitignored `.novalab/packaged-ownership-win-20261014/manifest-final.json` / `results-final.json`，包含源码/产物/日志 SHA256；demos、第二轮封存 manifest/results 与 stage2 packaged 日志、第三轮 manifest/results 前后指纹一致。旧轮次不改写。开工与集成前 fetch 比较 `origin/main` 均无新增。Release 接入专用回归，但本轮未运行远端 CI。

本次仅为 Windows 构建目录、已有 Python 环境的运行证据；Linux/POSIX 清理、外部 OS 信号、最终安装器与 Tauri 窗口、干净机器首启、BYO、真实 provider 均未验证。A14/A15 和正式发布门不因此整体关闭。详细命令/结果/首次失败见 [发布清单](release-v0.1.1-checklist.md)。

## 9. 第四轮记录：原子保存与外部冲突（本包已验收）

对应 intent M1/M2/M8/M9 与 E01/E04 的状态可信、内容可恢复需求。原子写入先补失败注入，旧直接截断写入在 partial write / 编码 / close 失败时破坏原字节；修复同目录排它临时文件、flush/fsync/关闭后 replace，父专项 36 通过、4 项 POSIX 权限检查在 Windows 跳过。真实双内核后台 A 外改后 save 与 clean close 两项先红，磁盘新增/修改 cells 被静默覆盖；保留字节 soft 断言，再以加载基线字节比较、`-32002`、候选恢复副本与纯 backup 修复。副本失败也拒绝覆盖，删除属于冲突，不依赖 mtime/size 或 watcher。

Watcher 改为仅通知；前端暂停所属 tab 自动保存，继续保留本地可编辑草稿。显式操作携带全部持久 cells 与未发送草稿，先备份，再与 save/accept/close 同队列冷加载磁盘。失败保留草稿/旧会话，旧 ACK 不清冲突，后台与历史 ACK 只更新所属 live cache；临时 REPL 不写副本。真 Chromium 通过后台关闭保护、B 焦点/会话不变、watcher 提示、CodeMirror 修改后加载失败保留与显式重试，副本再次打开验证持久 IDs/代码和计数 0。

父真实浏览器还发现新开 B 继承 A 的临时 REPL；局部补 2 failed / 1 passed 红例并修复，再补 A→B→A 往返回归。新 owner 初始化干净缓存，已有 owner 恢复自身草稿/运行切片。主线独立最终 app 25 文件/312 项、bridge 默认 20 文件/269 项、真实进程 5 文件/13 项、Python 258 通过与 5 项 POSIX 权限跳过、脚本客户端 24 项均通过；类型检查、前端生产构建、bridge bundle 重建和 32 文件 Python resources 字节核对通过。保存/关闭、HTML 与私有 source integration 相邻复测通过；前端仍有 >500 kB chunk 提示。

已完成受影响画廊 02/04/08/12/15 的 5/5 补测，O-2 后台 live / 导入归属 / 不串 cells 内容断言通过，无页面 console 错误；已看多 tab、历史只读、Diff、Session 与导入截图。脚本旧删除动作改为可恢复归档，并在重写前备份合成夹具、索引和截图。完整 16 态仍是此前 O-2 轮，11 明确 skipped，未调用 provider。原画廊命令的删除动作被自动审批拒绝；改归档/备份后实际通过。预览停止只确认进程退出，留下的本次生成临时目录由父核验归属后补清理；此限制与 source/packaged 套件的完整清理证据分别记录。

并行 packaged 交付已冻结，父读实际实现并独立串行 source 13/13、packaged 12/12 通过，默认端口诱饵请求 0、自身进程树与临时目录回收完成。父最初端口占用未进入正文、次轮额外请求失败均保留；停止预览后最终通过，额外请求来源未确证。独立打包证据保持原范围，仅 Windows 构建目录与已有 Python 环境。

本轮另存 `manifest-conflict-round4.json` / `results-conflict-round4.json`，包含源码、构建、资源和原始日志指纹，前三轮封存原样保留。内容比较后 replace 仍有跨进程竞态，不是文件 CAS；fsync 不保证全部断电恢复；POSIX 0600 不等于 Windows 独占 DACL。副本不恢复 Python namespace/变量/输出。A15 未整体关闭，下一包为 dead/ended 前端重启、保存协调与代次/归属守卫，再推进 bridge 重连和跨应用草稿恢复。

## 10. 第五轮记录：dead/ended 前端冷重启（本包已验收，Windows-only，2026-10-16）

对应阶段 2 的「clean dead/ended owner 显式冷重启、同 notebook FIFO 与 owner 隔离；dirty dead tab 保留草稿并阻止重启」。Owner 选择安全保留并阻止：dirty 不重启、不覆盖磁盘、不新增自动恢复副本协议。重启按 owner 寻址、只冷 `load_file`，不执行 cell、不重放 REPL 或副作用；成功只替换原 owner cache 并切换 session，失败保留 dead、旧 session、输出、Diff 与草稿可重试；`restartInFlight` 期间 save/Diff/reload/close 拒绝，stale 状态不提前解除 ended。

真实 Chromium smoke 用真实 bridge/kernel 与临时文件，按 PID 杀自身内核后实际点击 SessionBar 重启，重启在途切 B 不串 owner，A 冷加载磁盘内容且仅一次 `kernel.restart`，dirty 后再死亡时点击重启被拒、草稿保留，页面错误 0，输出 `KERNEL_RESTART_SMOKE_OK`。首跑在全部业务断言通过后因脚本 Node 上下文残留 `window` 引用失败，已修并保留日志；第二跑被交接工作树的自身孤儿 Vite 提供，判为无效，结束该进程树后从本树复跑通过。真实 stdio router 验收 1/1；bridge 274、app 316、Python 258（5 项 Windows 权限跳过）、脚本 24、类型检查、生产构建、集成冒烟与构建目录 packaged smoke 均通过。

证据单列 gitignored `validation-20261014/manifest-restart-round5.json` / `results-restart-round5.json` 与 `stage5-restart-*.log`（路径脱敏），记录源码/产物/资源 SHA256、toolchain、owned PID 与清理；前四轮封存指纹未变。仅 Windows 开发 Chromium 证据，非 Tauri WebView/安装器。A15 仍未整体关闭：下一包为 bridge 死亡→桌面恢复/重连与跨应用或有界 dirty 草稿恢复，并需跨平台复测。

## 11. 第六轮记录：bridge 死亡→桌面重连（本包已验收，Windows-only，2026-10-16）

对应阶段 2「后续另做 … bridge reconnect」。Owner 裁决：新一代 bridge 上线后 clean tab 等用户点击才冷重开（只 `notebook.open`，不执行、不重放）；bridge 自动重启 60 s 内最多 3 次；断线期间允许继续编辑。前端连接状态机在断线时以 `BridgeDisconnectedError` 结算 pending、拒绝新 RPC（不排队、不重放），每次重连重新 discovery 与认证；tab 在新代上保留为 bridge-lost，不被 `notebook.list` 抹掉，点击后按 path 冷重开并改键。核实发现第四轮基线字节只存在内核内存，bridge 死后会丢：跨代 `baselineSha256`（D4）未裁决前，dirty bridge-lost tab 只保留草稿、拒绝重开/保存，以免覆盖断线期间的外部修改。Tauri 以纯策略 `RestartPolicy` + 监督线程 + `restart_bridge` 命令实现有界重启。

真实 Chromium smoke 用两代自有 bridge：只杀自身 gen-1 bridge PID，断言重连横幅、pending 结算、断线编辑不发写、gen-2 重新认证后两 tab 保留且无自动打开（gen-2 内核 0）、点击 clean tab 恰一次 `notebook.open` 冷加载且无重放、dirty tab 拒绝且磁盘外部字节保留、页面错误 0、18 个自有 PID 全部退出、临时目录删除，输出 `BRIDGE_RECONNECT_SMOKE_OK`。前两跑因 harness 缺陷（只读调用计入写、Windows PID 复用）失败，三、四跑因判定/清理不严谨作废，均保留日志。附带内核探针表明：空闲内核在 bridge 管道关闭后立即退出，忙内核会先跑完当前 cell。工程门：app 336、bridge 274、Rust 5、Python 258+5 跳过、脚本 24、类型检查、生产构建、集成与构建目录 packaged smoke 通过。

证据单列本工作树 gitignored `validation-20261014/manifest-reconnect-round6.json` / `results-reconnect-round6.json` 与 `stage6-*.log`；前五轮封存（基线工作树）仅读取核对未变。仅 Windows 开发 Chromium 证据，Tauri 监督线程只有单测与编译，非安装器。A15 仍未关闭：D4 跨代基线指纹与 dirty 恢复、跨应用草稿恢复、跨平台复测；运行/保存在断线期间禁止与退避/预算默认值待 Owner 确认。

**D4 补充（同日，Owner 批准）**：内核 `load_file`/`save_file` 报告基线原始字节的 `baselineSha256`，bridge 在 notebook 状态、`cell.save`、`diff.accept` 中透传；前端按 tab 记录，bridge 换代后 dirty tab 也可点击重开——指纹与旧代一致才恢复自动保存，不一致或未知走第四轮冲突流程，不盲写。先红（Python 13、bridge 4、app 4 失败）后绿；app 339、bridge 278、Python 261+5 跳过、Rust 5、脚本 24、构建与集成/packaged smoke 通过；同一真实 Chromium smoke 扩为三 tab，覆盖"磁盘已变 → 冲突 → 保留副本加载磁盘"与"磁盘未变 → 草稿落盘、指纹推进"，页面错误 0、31 个自有 PID 全部退出。证据为新增 `manifest-reconnect-round6-d4.json` / `results-reconnect-round6-d4.json` 与 `stage6d4-*.log`，第六轮封存只读核对未变。A15 仍开放：跨应用草稿恢复、生产环境旧内核清理（Job Object 跟进项）、跨平台复测。

## 12. Agent 安全小包：F2 多格 diff 队列 + execute_cell 过渡确认（Windows-only，2026-10-17）

Owner 裁决："F2 和 execute_cell 过渡确认，先作为一个小包修掉，再进入 ADR-013 实现。"对应阶段 3「完善多格 Diff 队列」与共享 Agent 可信性。

- **F2**：`diff.stage` 在有待审 diff 时验证两次：相对当前 notebook，以及叠加全部待审 diff 之后。单独不过、叠加通过 → 入队并带 `dependsOn`（搬移定义 = 先 update 原 cell 去掉定义、再提交新位置）；单独通过、叠加不过 → 拒绝并带 `conflictsWith`；单赋值冲突附 `hint`，指出先 update 哪个 cell。`diff.accept` 要求依赖已采纳，否则在改动 notebook 前拒绝。前端 diff 卡片显示「依赖 diff-N」和 Accept 被拒的原因。
- **F3（ADR-012 顺带发现）**：AI SDK 会并发执行同一消息里的工具调用，`diff.stage` 现在与 accept / save 一样排在 notebook 写队列上，后到的一条能叠加先到的一条。
- **顺带修复**：真实内核的 `compileError` 是纯字符串，而 M5 第二道闸要求 `{message, cellIds}`，所以真实环境里**每一次被拒的 `propose_code_change` 都被整条替换为占位文本**，模型看不到拒绝原因（ADR-012 G-1 时模型在搬移定义上反复失败，可能与此有关）。现在在 stage 边界解析为结构化形式；FakeKernel 的单赋值检查也改为与 `dag.py` 同格式的字符串。
- **execute_cell 过渡确认**：工具改走 `agent.executeCell`。bridge 广播 `agent.confirmRequest`（含将执行的源码），前端弹窗，默认焦点在「拒绝」；任一窗口先答即生效（`agent.confirmResponse`），随后广播 `agent.confirmResolved`。拒绝、超时（120 s）、等待期间切换 notebook 或源码被改，都返回 `{denied, reason, message}`，不执行。没有可确认的窗口（`--mcp` 模式）一律拒绝。这套握手是 ADR-013 O1(b)「每轮第一次运行先问用户」的基础。

先红后绿：F2 路由单测 5 失败 / 1 通过，F3 并发 1 失败，确认握手 9 失败；真实内核验收先暴露字符串 compileError 与捕获组错误，修正后通过。工程门：bridge 315（25 文件）、app 388（29 文件）、Python 261 + 5 跳过、脚本 24、真实内核验收 17（7 文件，新增 `router.diffqueue.acceptance.ts` 3 个）、类型检查与生产构建。真实 Chromium smoke `scripts/agent-safety-smoke.mjs`（`AGENT_SAFETY_SMOKE_OK`）：拒绝不执行、允许后在用户 kernel 上执行；依赖 chip 可见，乱序 Accept 被拒并在卡片显示原因且 notebook 不变，按序采纳后 helper 落到新 cell。另外五个既有浏览器 smoke 与集成 / packaged smoke 复测通过。

边界：仅 Windows、Chromium + Vite dev；超时只有单测；未用真实模型验证 `dependsOn` / `denied` 下的行为。**行为变化**：外部 MCP Agent 不能再执行 cell（只能读和提议）。

## 13. 维护包：输出预算、首屏拆包、测试临时目录、依赖与交接文书（Windows-only，2026-10-17）

Agent 安全小包后列出的「第二包」，均为不改产品边界的修复与优化。

- **F7 输出预算**：`@ai-sdk/anthropic` 对未知模型 id（tokenplan 的 qwen/glm/deepseek）把输出上限压到 4096，openai-compat 不传 `max_tokens` 时由服务端默认（DeepSeek 4096），长代码提议会被截断。现在未知模型显式带 8192（`defaultSettingsMiddleware`，调用方显式值仍优先），已知 Claude 模型沿用 SDK 按型号的上限。顺带：dev `.env.local` 兜底模型此前绕过了重试层与预算，现在与用户 provider 走同一构造路径。
- **首屏拆包**：模型构造从 `agent/providers.ts` 拆到 `agent/models.ts`，AI SDK（`ai` / `@ai-sdk/*` / `zod`）只经懒加载的 Agent 面板与设置面板进入。主包 1,399.6 kB（gzip 409.6）→ 206.8 kB（gzip 61.4），另有 `vendor-react` 218.8 kB、`vendor-codemirror` 376.1 kB 两个长缓存块；AI SDK 块 557.3 kB 在首帧后加载。`scripts/app-bundle-boundary.test.mjs` 沿 `main.tsx` 的静态 import 图守住边界（对旧 `App.tsx` 先红）。
- **测试临时目录**：bridge 单测与验收此前在 %TEMP% 累积了 8,234 个 `novalab-*` 目录。新增 vitest `globalSetup`（`bridge/src/testing/temp-sandbox.ts`）：每次运行把 TEMP/TMP/TMPDIR 指向专属 `novalab-vitest-*` 目录，结束只删这一个，不按前缀扫删别处。整套单测与真实内核验收后新增残留为 0。已有的 8,234 个旧目录未删除（属于用户临时目录，可能有并行会话在用）。
- **依赖**：`@earendil-works/pi-agent-core` / `pi-ai` 从 bridge `dependencies` 移到 `devDependencies`（只有 ADR-012 spike 与其测试引用；打包的 `bridge.mjs` 中 0 处引用）。
- **交接文书**：`docs/handover-dead-restart-package.md` 顶部加 10-17 状态条（第五轮已关闭并合入），正文保留原貌。

工程门：bridge 342、app 395、Python 296 + 5 跳过、脚本 27、真实内核验收 24、集成 / packaged acceptance 12/12，六个真实 Chromium smoke 全部通过。

未做：bridge 重连后的「全部重开」按钮——与第七轮（草稿恢复）和冷启动重连修复改同一批前端恢复代码，等它们合入后再做，避免冲突。

## 14. 第七轮记录：跨应用 dirty 草稿有界恢复（本包已验收，Windows-only 浏览器证据，2026-10-17）

Owner 裁决存储为"notebook 旁、7 天"。核实发现正常编辑 300 ms 内即自动保存，草稿只会在保存失败或冲突暂停时长期滞留，而此时内核可能已不可用，因此由 bridge 而非内核写恢复日志：去抖 1.5 s 后仍未保存才写，沿用第 4 轮"临时文件 + fsync + rename"，日志只含持久 cell 的 id/code、dirty 列表与 bridge 记录的基线指纹，每 notebook 最多 5 份、7 天删除、单份 2 MiB，保存成功即删。重开只提示：指纹一致可恢复为本地草稿而不写盘，不一致只能保存为同目录本地副本或丢弃。

先红（bridge 20、app 8 失败）后绿：bridge 319、app 393、Python 261+5 跳过、Rust 5、脚本 24、类型检查、生产构建、集成与构建目录 packaged smoke 通过。真实 Chromium smoke 以只读文件让自动保存持续失败，只杀自有 gen-1 bridge 并关闭页面，再以 gen-2 与新页面重开：磁盘未变的 notebook 被提示并经点击恢复、全程不写盘，之后正常保存清除日志；断线期间被外部改写的 notebook 只能保存为本地副本，原文件保持外部字节；页面错误 0、23 个自有 PID 全部退出。证据为 `manifest-drafts-round7.json` / `results-drafts-round7.json` 与 `stage7-*.log`，前六轮封存只读核对未变。A15 仍开放：Linux CI、bridge 断线期间的草稿落盘（需 Tauri 侧写盘通道）、生产环境旧内核清理；去抖、单份上限与"恢复不写盘"等默认值待确认。

## 15. 第七轮后续 7b：断线期间草稿落盘（本包已验收，Windows-only，真实 Tauri 窗口，2026-10-17）

Owner 按建议批准 O1–O6：断线或 bridge-lost 时由 Tauri Rust 命令 `write_draft_journal` 写入与第七轮完全相同的日志（同目录、同格式、同界限），只接受已存在的绝对 `.py` 文件，基线取前端最后确认的指纹；在线仍由 bridge 写，浏览器 dev 断线不写，读取与恢复仍只在 bridge。格式由 Node 与 Rust 共用的夹具约束。先红（Rust 8、app 5 失败）后绿：bridge 330、app 400、Rust 13、Python 261+5 跳过、脚本 24、构建、集成与 packaged smoke 通过。WebView2 远程调试驱动真实 debug 窗口：只杀自有 bridge → Rust 监督重启 → bridge-lost 中编辑 → 经 Tauri IPC 写出日志（bridge `draft.write` 0 次）→ 杀整个应用 → 重启后提示并点击恢复、不写盘；36 个自有 PID 全部退出。证据 `manifest-drafts-offline-round7b.json` / `results-…`，前七轮封存未变。新发现：桌面冷启动时 WebView 先于 bridge 监听加载，首次 `connect()` 只尝试一次且 store 只在首次成功后订阅状态，窗口停在"bridge 未连接 … 刷新"横幅，`retryBridge` 在 idle 状态无法恢复界面，只能刷新（既有行为，本包未修，建议另立小包）。A15 仍开放：Linux CI、生产环境旧内核清理、冷启动首次连接重试。

## 16. 决策停点

只在某个阶段确实需要改变既有边界时请求 Owner；先准备具体、可比较且带证据的结果。最近停点是 ADR-011 正式采纳：已有白名单表格实现与本轮浏览器证据，仍需明确是否作为产品承诺进入当前候选。它不阻止先完成请求健壮性、纯预检和并行 RPC 验收。

保存冲突默认保留双方、重启默认不自动执行、环境默认先诊断、会话信息默认仅本地。若后续需求必须超出这些默认，写决策提案说明触发场景、收益、数据/副作用范围和验收方式，再请求裁决。
