# NovaLab 实施计划（Plan）

> 状态：v0.1 · 2026-10-06（2026-10-10 增补 §5b v0.1.1；2026-10-13 整理验收与阻塞项） · 上游：[intent.md](intent.md) · [spec.md](spec.md)
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
| S1 侦察 | ✅ docs/spike-s1-memo.md + docs/adr/001-kernel-route.md（proposed）：路线 A 12–20 人日 + 每 minor 2–4 人日维护税，倾向"A 可行但不划算"；重大修正：marimo 格式与本格式互不直读，转换器立 P3.6 |
| G1 门 | ✅ 2026-10-06 裁决**路线 B**：S2 86 例 pytest 全绿 + integration-smoke.mjs 端到端绿；ADR-001 accepted；路线 A 保留为结构性缺陷兜底 |

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
| P1.2 | `py/novakernel`：dag + runtime + introspect + serialize（marimo 子集读写）+ server 消息循环；pytest ≥60 例 | S2 扩展版全绿；`fixtures/` 往返无损 | G1 | ✅ 完成（86 例绿；serialize 按 S1 修正降级为宽容导入；matplotlib 已入 data extras） |
| P1.3 | `bridge`：WS JSON-RPC router + KernelSupervisor（spawn/health/restart）+ 端口自愈；**冻结 KernelAdapter 接口** | 契约测试过；kill kernel 后一键恢复 | P1.2 | ✅ 完成（39 例 vitest 绿；契约冻结入 spec §6.2；偏离：session kind 增 'save'、preview 位于 src/preview.ts、diff.accept/kernel.restart 响应形状定稿——待集成时回写 spec §6.1/§8/§11） |
| P1.4 | 前端 CellList/CellHeader/CellEditor(CM6)/OutputDisclosure/OutputRenderer(text+traceback) | 100 cell 虚拟列表 60fps；折叠 output 复刻截图元素 3-5 | P1.3 | ✅ 完成（tsc/vitest 14 例/vite build 全绿；元素 2-7 齐；语法高亮为逐行正则 overlay——pnpm 严格解析下 @lezer/highlight 非直接依赖，P2 可提依赖换 TagSystem） |
| P1.5 | 反应式 UI 联动：stale 徽章、级联运行流式刷新、编译错行内提示 | intent §8 演示脚本前半段 | P1.4 | ✅ 完成（store reducer + compileErrors 行内提示；stale 传递闭包经集成冒烟验证） |
| P1.6 | KernelStatusBar + InlineREPL + LivePill（截图元素 2/6/7） | REPL 输出回灌匿名 cell | P1.4 | ✅ 完成（按冻结契约改为单一持久 [repl] cell；dead pill 点击重启） |
| P1.7 | Tauri 壳 devUrl 模式接入（spawn bridge、窗口、图标占位） | 双击桌面图标 = 浏览器同等体验 | P1.5 | ✅ 闭环（2026-10-06）：VCTools 补装于 VS18（Owner 执行）、图标集 `tauri icon` 生成、cargo check 绿；宿主两坑归档：Git usr\bin 的 coreutils link.exe 劫持 → 仓库级 rust-lld 免疫（.cargo/config.toml）；stable rustc 拒显式 msvc-lld flavor → 目标默认风味自动配对 |
| P1.8 | .py 打开/保存/新建 + sidecar `.novalab/` + 崩溃恢复横幅 | 改文件外部→热重载提示 | P1.5 | ✅ 完成（watch/ui-store 测试；崩溃横幅真机未拍，见功能矩阵） |
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
| P2.7 | PreviewSerializer 硬截断 + 发送审计 UI | >4KB  fuzz 必截单测 | ✅ bridge 侧完成（I 线）；审计 chip 随 G2 线 |
| P2.8 | **文件与会话管理**（M8/M9，第四波 J 线）：左侧文件树 + bridge fs.*（越界拒绝）+ 会话历史/只读浏览/ended 态/截断横幅/cell 计数；交互参考 refs/jupyterlab filebrowser | 双包绿 + 手测开/建/改/删文件与只读会话 | ✅ 完成 |
| P2.9 | **错误 UX 与写事件**（附录 A-2 #11/15/17，第四波 K 线）：error(line N) 徽章 + 编辑器红行高亮；内核 addaudithook('open') 写钩子 → run.notify → `wrote …` 通知行；matplotlib inline 验证 | py/app 双绿 + 真机截图 | ✅ 完成 |
| **D2** | 阶段演示：报错→Fix→Diff→Tab→级联绿 全闭环 | `docs/demos/p2.gif` |

## 4. 阶段 3 · 上下文深潜与多内核（W8–W10）

P3.1 多 Tab 多内核（S1）：KernelSupervisor N 进程 + tab 切换 + 内存水位提示；
P3.2 变量 inspector（状态栏拖出，S3）；
P3.3 交互控件 mo 风格子集（slider/table → 绑定即重跑，S4）；
P3.4 SessionModal + segments + .ipynb 导出/一次性导入（S2，截图元素 8/9）；
P3.5 schema 嗅探扩展：numpy/scipy/geopandas 类型表；
P3.6 marimo ↔ NovaLab .py 双向转换器（2–4 人日，S1 侦察估计；jupytext 参考实现，refs/marimo/examples 作 golden；起因：marimo 原生 @app.cell 式与本格式互不直读）；
**D3** 演示：双内核同屏 + session 模态 + 导出 ipynb 在 JupyterLab 打开无误。

## 5. 阶段 4 · 产品化（W11–W12）

P4.1 CI/CD：tauri-action 双平台产物 + 签名占位；GitHub Actions Release run `38066573600` 已验收 Windows NSIS/MSI、Linux AppImage/deb 与两平台真实启动 smoke；后续 CI 已加入构建后 bundle 产物检查（Windows NSIS payload、Linux AppImage/deb）。**Owner 裁决（2026-10-07）：Apache-2.0 开源直发**——LICENSE/NOTICE/CONTRIBUTING/CHANGELOG/.github workflows（ci + release-on-tag）先行；签名 secrets、版本号联动和 updater 仍待补。**P4.1b sidecar（Owner 裁决按建议案）**：bridge = externalBin node.exe + esbuild 单文件 JS resource；kernel = uv.exe sidecar 首启 `uv python install + uv sync` + BYO 兜底；identifier 保持 dev.novalab.app（macOS 后缀警告接受）；
P4.1b **D1/D2 录屏（Owner 裁决：做）**：playwright video 两条 reel（P1 全链路 / P2 修错闭环）→ docs/demos/reels/，矩阵 D 行闭环；P4.2 App View 模式；P4.3 亮色主题 + i18n 骨架（Q3）；P4.4 首启引导（uv 环境自检/修复向导，intent 风险章）；P4.5 公测发布页 + 开源仓库整理（Q4 许可证落定）。

## 5b. v0.1.1 · 加固与工作台（2026-10-10，评估后 Owner 裁决"按建议推进"）

| id | 任务 | 状态 |
|---|---|---|
| H1 | Bridge 鉴权（ADR-009）：`/bridge-info` discovery + Origin 白名单 + `bridge.auth` token；LLM 代理 token 头 | ✅（main `0877485`） |
| H2 | 隐私收紧：`get_cell_output` 只回 traceback + mime 键（main `0877485`）；审计 chip 记录每次工具返回、去掉常量 "0 rows sent" | ✅ |
| H3 | CI 画廊回绿：钉 en、选择器去中文文案依赖；新增 00-welcome 态 | ✅ 本地全绿（11 态无凭据降级为预期） |
| H4 | 工作台布局（ADR-010）：标题栏 / 活动栏 / 可缩放侧栏（Explorer · Sessions · Variables）/ 编辑区 / 可缩放 Agent 栏 / 状态栏 | ✅ |
| H5 | Welcome 页（JupyterLab 式）取代首启模态；常驻环境自检；`bridge.mcpLaunch` 回报 MCP 命令 | ✅ |
| H6 | Session notebook 对齐 Claude Science（spec 附录 A-5） | ✅ |
| H7 | 文档同步：intent / spec / plan / 功能矩阵 / CHANGELOG / README / SECURITY | ✅ |
| H8 | 量化指标基准脚本 `scripts/bench.mjs`（intent §8） | ✅（数字需空闲机器重测） |
| H9 | 普通 cell 尾表达式回显（L-5）、text/html 白名单表格渲染（ADR-011 提案）、.ipynb 导出含 text/html | ✅ |

**验收收口（2026-10-14，工程验证与 O-2 修复）**

详细范围、建议发布门、B01–B07 阻塞项、A01–A18 操作清单与证据模板见 [v0.1.1 验收清单与阻塞项](release-v0.1.1-checklist.md)。上表 ✅ 表示已有实现/历史证据，**不表示当前候选安装版验收通过或已发布**。

**下一步（建议顺序；发布门与例外待 Owner 确认）**
1. **范围与决策**：ADR-011 白名单表格已实现，仍待 Owner 裁决；确认本版保留限制与性能目标例外，不擅自调整阈值。
2. **当前基线回归与证据**：类型/三套单测/生产前端构建/集成已通过（bridge 242、app 266、Python 191）。O-2 已补后台 live 投影、归属与延迟列表回归；`--skip-agent` 已接入循环，11 态明确跳过。完整无 Agent 画廊 16/16、无页面 console 错误，O-2 内容断言通过；构建目录 `PACKAGED_STARTUP_SMOKE_OK`。后续已补真实进程 A04/A05（2 文件/6 项含纯预检）、Python 219 项及 HTML 浏览器子项，详见清单；其余安全/隐私子项仍待执行。optional Agent 失败不影响退出码，必须单列实际结果。
3. **版本与候选包**：明确产品/内部包版本联动，核对 tag 与安装显示；Windows NSIS/MSI、Linux AppImage/deb 最终产物安装后验证，不能只凭构建目录 sidecar smoke 放行。当前没有本轮 v0.1.1 候选包验收证据。
4. **Agent 与 Owner 自用**：真实 provider 的 Fix/多格重构、真实 stdio MCP 同一前端审阅闭环；候选安装版上跑人口预测或 POI 清洗 N1–N4。敏感数据留本地，远端模型发送范围须事先确认。
5. **量化验收**：`scripts/bench.mjs` 已有；旧 dev 数不能替代当前鉴权基线和真实 Tauri 窗口。空闲机器重测并补首帧、重输出、候选包体积；旧 NSIS 37MB 超过 <20MB 目标，须优化或 Owner 明确裁决。
6. **后续项（不自动全部纳入 v0.1.1 硬门）**：首启离线/镜像、i18n 深度迁移、Tauri CSP（当前 `csp: null`）、代码签名接线与材料、真实 scipy/geopandas 兼容验收。保留时须披露限制并由 Owner 确认；实际安全/隐私/数据丢失回归仍阻塞。
7. **正式发布另行授权**：本轮在工作树内修复、构建与验证；提交、版本调整、tag 和上传尚未执行。旧分支/工作树清理与本版验收无关，不在本轮删除范围。

**科研需求驱动的后续闭环（2026-10-14）**：公开研究与竞品反馈、intent N1–N4 映射、五阶段工作包、实测门和重大决策边界见 [科研自动化迭代路线与证据台账](research-iteration-roadmap.md)。可信入口与提议隔离第一轮已封存（RPC 22 项、真实进程 6 项、HTML、集成与构建目录启动通过；Diff/Session 补测 2/2）。第二轮保存 ACK / tab 归属 / 关闭失败保留已通过前端 288 项、bridge 248+8 项、真实浏览器磁盘验收与受影响画廊 5/5；独立进程隔离工作树已集成并由主线复测（客户端 24、Windows 进程 13 项），前端/bridge 构建与构建目录启动通过。第三轮执行队列生命周期已补真实先红并修复，主线独立 bridge 260 项、真实验收 11 项与类型检查通过；stop/restart/本次内核进程崩溃后全部旧调用结算，冷核无旧排队执行。第四轮原子写入与外部冲突已完成父独立工程门（Python 258+5 项权限跳过、bridge 269+真实 13、app 312、客户端 24）及真实浏览器备份/冷加载/失败重试；新开文件串 REPL 也已先红修复并复测。第五轮 dead/ended 前端冷重启已验收（2026-10-16，Windows-only）：clean owner 显式冷重启、dirty 拒绝并保留草稿，真实 Chromium `KERNEL_RESTART_SMOKE_OK`、真实 stdio router 1/1、bridge 274 / app 316 / Python 258+5 跳过 / 客户端 24、集成与构建目录启动通过，证据见 `manifest-restart-round5.json`。第六轮 bridge 死亡→桌面重连已验收（2026-10-16，Windows-only）：断线结算 pending、允许编辑、新一代 tab 保留为 bridge-lost、clean 点击冷重开、dirty 保留草稿，60 s 内最多 3 次自动重启；真实 Chromium `BRIDGE_RECONNECT_SMOKE_OK`、app 336 / bridge 274 / Rust 5 / Python 258+5 跳过 / 客户端 24、集成与构建目录启动通过，证据见 `manifest-reconnect-round6.json`。同日 D4 获批并补充验收：内核/bridge 协议新增 `baselineSha256`，dirty bridge-lost tab 重开时核对指纹，未变续存、已变走冲突流程；app 339 / bridge 278 / Python 261+5 跳过，真实 Chromium 三 tab smoke 通过，证据见 `manifest-reconnect-round6-d4.json`。2026-10-17 Agent 安全小包已验收（Windows-only）：多格 diff 队列叠加预检与 `dependsOn`（F2）、stage 串行（F3）、真实内核字符串 compileError 归一（此前被 M5 第二道闸整条遮蔽）、`execute_cell` 逐次用户确认（MCP 模式一律拒绝）；bridge 315 / app 388 / Python 261+5 跳过 / 真实内核验收 17，真实 Chromium `AGENT_SAFETY_SMOKE_OK`，证据见 `manifest-agent-safety.json`；随后进入 ADR-013 影子执行 S0–S2。同日维护包：未知模型输出预算 8192（F7）、AI SDK 懒加载使主 JS 1.40 MB → 207 kB、bridge 测试临时目录隔离（新增残留 0）、pi 依赖移入 devDependencies，证据见 `manifest-maintenance.json`。第七轮跨应用 dirty 草稿有界恢复已验收（2026-10-17，Windows-only 浏览器证据）：bridge 把滞留草稿原子写入 notebook 旁 `.novalab/drafts`（5 份 / 7 天 / 2 MiB），重开只提示，指纹一致可恢复、不一致保存为本地副本；bridge 319 / app 393 / Python 261+5 跳过，真实 Chromium `DRAFT_RECOVERY_SMOKE_OK`，证据见 `manifest-drafts-round7.json`。同日 7b 断线期间草稿落盘已验收（Windows-only，真实 Tauri/WebView2 窗口）：bridge 不在或 tab 为 bridge-lost 时由 Tauri 命令 `write_draft_journal` 写同一日志，bridge 330 / app 400 / Rust 13，`TAURI_WINDOW_DRAFT_SMOKE_OK`，证据见 `manifest-drafts-offline-round7b.json`；并发现桌面冷启动首次连接不重试（只能刷新），另立小包。接下来是 Linux CI 复核、冷启动首次连接重试与生产环境旧内核清理（A15 仍开放），随后共享 Agent、环境/运行可复核与交付。打包启动归属修复已落地主线，父独立 Windows source 13/13、packaged 12/12 通过，默认端口诱饵请求为 0、自身进程树与临时目录全部回收；只代表已有 Python 环境的构建目录，不代表安装器/干净机器首启。旧轮次证据保留；常规修复自主执行，不能把历史竞品 issue 当作当前缺陷。

---

## 6. 参考仓库阅读地图（refs/，只读）

| 仓库 | 必读路径 | 学什么 |
|---|---|---|
| `refs/marimo` | `_ast/compiler.py`、`_ast/visitor.py`（defs/refs 提取边角）；`_runtime/runner`、`_runtime/graph`（失效/级联/glitch-free）；`_server/api` + `websockets`（协议形态，S1 用）；`examples/`（serialize fixtures 来源） | 路线 A/B 共同的知识源；**只理解设计思路；实现、测试用例与断言依据本项目 spec 独立编写，不复制表达**（以 CONTRIBUTING clean-room 纪律为准） |
| `refs/codemirror-merge` | `src/merge.ts`、examples/inline | MergeView 内嵌模式、hunk API、装饰器样式 hook（P2.3） |
| `refs/vercel-ai` | `examples/ai-sdk-*`、`packages/ai/src/mcp` | useChat 流式、tool zod 单源、MCP client/server 装配（P2.1/P2.6） |
| `refs/jupyterlab` | `packages/filebrowser/src/{listing.tsx,model.ts}`、`packages/docmanager` | 文件浏览器交互范式（双击打开、面包屑、选择与删除确认语义），P2.8 clean-room 参考 |

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

## 9. 下一步（历史：2026-10-06 开工前清单，已全部完成；当前下一步见 §5b）

1. ~~回答 intent §7 的 Q1–Q7~~ ✅ 2026-10-06 已裁决（Q7 的值待 Owner 填入 `app/.env.local`）；
2. 我按 G1 流程跑 S1+S2 并出 `docs/adr/001-kernel-route.md` 终稿；
3. ~~`decideStalePolicy()`~~ ✅ Owner 裁决 mark-only，已实现（P2 补开关 UI 与 e2e）。
