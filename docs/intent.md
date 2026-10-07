# NovaLab 意图文档（Intent & 需求头脑风暴）

> 状态：v0.1 头脑风暴初稿，待用户裁决第 7 节开放问题
> 日期：2026-10-06
> 配套文档：[spec.md](spec.md)（技术规格）· [plan.md](plan.md)（实施计划）
> 参考代码：`refs/marimo`（反应式内核）、`refs/codemirror-merge`（行内 Diff）、`refs/vercel-ai`（Agent SDK）

---

## 0. 这份文档是什么

这是整个项目的"为什么"与"做什么"。它记录了三类内容：

1. **头脑风暴的结论**——把方案书里的愿景拆解成可验证的需求；
2. **决策记录（ADR）**——每个关键岔路口的选项、权衡与暂定结论；
3. **开放问题**——需要产品Owner（你）拍板的地方，第 7 节。

spec 回答"怎么做"，plan 回答"按什么顺序做"，本文档回答"到底要做一个什么东西、不做什么"。

---

## 1. 愿景（一句话）

> **NovaLab = 本地优先 + 反应式内核 + Agent 深度协同的桌面科研数据工作台；
> 交互范式clean-room 复刻 Claude Science Notebook，执行语义超越 JupyterLab。**

三个"必须感受到"的瞬间（产品北极星）：

- **状态永远可信**：任何时刻打开 notebook，每个 cell 的输出都与当前变量状态一致；不一致的 cell 被显式标记为 stale，而不是悄悄撒谎。
- **修错零摩擦**：报错 → Agent 卡片 → 行内红绿 Diff → `Tab` 采纳并自动重跑。全程不离开编辑器、不复制粘贴。
- **数据不出门**：LLM 只看到代码、报错栈、依赖图和 `df.head(1)` 级别的结构摘要；原始数据永远留在本地进程里。

---

## 2. 为什么现有工具不够（问题空间）

| 工具 | 强项 | 对我们场景的致命伤 |
|---|---|---|
| Jupyter / JupyterLab | 生态最全、科研人员肌肉记忆 | 隐式状态黑盒：乱序执行后变量与代码脱钩；Agent 拿到的"世界模型"是错的；.ipynb JSON 冲突 |
| Colab / Claude Science（云端） | UI/UX 现代、Agent 原生集成 | 数据必须上传（敏感科研数据不可接受）；GPU/内存配额；离线不可用 |
| marimo | 反应式 DAG、纯 .py 存储、UI 现代 | Agent 能力浅（补全级）；UI 不是"会话日志"范式；多内核/科研交付流弱 |
| Observable | 反应式、可视化强 | JS 生态，与 Python 科研栈绝缘 |
| VS Code + 插件 | 编辑器强 | 无反应式语义；notebook 体验是拼接的 |

**我们的空档**：marimo 的执行语义 × Claude Science 的交互范式 × 本地隐私边界 × 可插拔任意 LLM。四者交集目前无人占据。

---

## 3. 目标用户与典型场景

**主画像**：在本地敏感数据上做定量研究的实证研究者（示例即本项目Owner的真实工作流：省级人口预测与迁移分析、学校 POI 数据补全清洗——数据含地理与人口明细，不可上传云端）。

**场景脚本**：

- **N1 探索分析**：读 CSV/GeoJSON → 逐步清洗 → 画图 → 中途改上游清洗逻辑 → 下游所有统计与图**自动级联重跑或显式标 stale**（Jupyter 在这里开始撒谎，我们不撒谎）。
- **N2 修错循环**：cell 抛 `KeyError` → 右侧 Agent 自动浮现 One-click Fix 卡片（已附 traceback + 相关变量 schema）→ 行内 Diff → `Tab` → 级联重跑转绿。
- **N3 Agent 协作重构**：对 Agent 说"把这三格重构成一个带参数函数并加缓存" → Agent 用 `proposeCodeChange(insert_below/update)` 逐格提议 → 用户逐格审阅 → 全部采纳后 DAG 自动重连。
- **N4 交付**：一键切 App View（隐藏代码、留交互控件）给同事看；或导出 .ipynb 给还在用 Jupyter 的合作者；或作为纯 .py 进 git。

---

## 4. 复刻对象：Claude Science Notebook 逐元素盘点

对照两张截图（内核标签页视图 + Session notebook 汇总模态），复刻清单如下；**完整组件级规格见 [spec.md 附录 A](spec.md)**。

| # | 截图元素 | 我们的对应组件 | 阶段 |
|---|---|---|---|
| 1 | 顶部内核标签页（`Python — liaoning-pop` 等，active 高亮 pill） | 多文件/多内核 TabBar | P2（P1 单 tab） |
| 2 | 右上 `● Live` 状态 pill + 下拉 | 内核连接状态 pill（live/idle/busy/dead + 菜单：重启/断开） | P1 |
| 3 | cell 头：`[42]` 执行计数徽章 + `python` 语言 chip | CellHeader（计数、语言、stale 徽章、运行按钮 hover 浮现） | P1 |
| 4 | 代码区：暗色面板、行号、语法高亮、块内横向滚动 | CodeMirror 6 单元格编辑器 | P1 |
| 5 | `▶ output` 可折叠披露区（含 stdout / 文件写入提示） | CollapsibleOutput（MIME bundle 渲染：text/html/img/table） | P1 |
| 6 | 底部内核状态栏：`Python kernel · shared with the agent` + 拖拽把手 + `idle` | KernelStatusBar（可拖出变量 inspector） | P1 |
| 7 | 状态栏下 REPL 行：`>>> run code in this kernel…` | InlineREPL（直达内核，输出回灌为匿名 cell） | P1 |
| 8 | Session notebook 模态：id chip、`1 agent · 96 cells`、`9 segments` 折叠分组 | SessionView（基于执行事件日志的只读汇总） | P3 |
| 9 | 模态内分组头 `NOTEBOOK python · 2 cells` + 右下角 `.ipynb` 导出 | 分组头 + ExportMenu | P3 |
| 10 | 整体视觉：暗色、极简、等宽、Notion/Linear 气质 | 自建 design tokens（clean-room，不抄资产） | P1 |

**复刻之外、我们超越的增量**（Claude Science 没有或不必有的）：反应式 stale 标记与级联、行内 Diff 审阅（Tab/Esc）、schema 级 Agent 上下文、纯 .py 主存储、任意 LLM/本地模型、App View。

---

## 5. 需求清单（MoSCoW）

### Must（MVP 没有就不发布）

- **M1 反应式执行内核**：单赋值 DAG；编辑 cell 后下游传递闭包标 stale；运行支持级联重跑模式；循环依赖编译期报错。
- **M2 纯 .py 主存储**：自定 `# %% [cell-id]` cell 块格式 + 头部配置注释，git 友好、零 JSON 冲突；marimo 互操作 = 单向宽容导入 + 转换器导出（P3.6；S1 侦察修正：marimo 原生为 @app.cell 装饰器式、文件内无 id，与本格式互不直读）。
- **M3 单元格编辑器**：CodeMirror 6 多实例、行号、Python 高亮、块内横滚、可折叠 output、执行计数徽章。
- **M4 修错闭环**：traceback 自动捕获 → Agent One-click Fix 卡片 → 行内红绿 Diff → `Tab` 采纳（自动触发运行）/ `Esc` 撤销；Agent 写入永远 staged，禁止静默改文件。
- **M5 隐私边界**：出进程的内容仅限 代码文本 / traceback / DAG 结构 / 变量 schema / `head(1)` 级预览；有显式 UI 指示"本次发送了什么"。
- **M6 模型解耦**：设置面板填 Anthropic / OpenAI / DeepSeek / 本地 Ollama(vLLM) 的 base_url+key；离线模型可全脱网运行。
- **M7 内核状态栏 + 底部 REPL**：复刻截图元素 6、7。
- **M8 工作区文件管理**（2026-10-06 增补，Owner 指出缺基本功能）：左侧可折叠文件树（workspace root 可设、.py 双击打开、新建/重命名/删除带确认、路径越界拒绝）；交互参考 refs/jupyterlab `packages/filebrowser`，视觉 clean-room。
- **M9 会话管理**（同次增补）：内核生命周期 = 会话；历史会话列表（cell 数/起止时间/read-only）、只读浏览（ended 态 footer + 编辑器只读）、>500 cell 截断横幅 + .ipynb 全量导出入口、footer cell 计数。

### Should（MVP 后第一批）

- **S1** 多 Tab = 多文件多内核进程（视觉上等价截图元素 1）。
- **S2** Session 汇总模态 + `.ipynb` 导出（截图元素 8、9）。
- **S3** 变量 inspector（状态栏拖出：名字、类型、shape、sparkline 预览）。
- **S4** 原生交互控件（slider / table / datepicker，绑定即反应式重跑）。

### Could

- App View 一键发布（隐藏代码的交互报告）；cell 模板库；wasm 纯前端预览模式。

### Won't（本阶段明确不做）

- 多人实时协同；云同步；非 Python 内核；.ipynb 作为主格式的双向同步（只做导出 + 一次性导入转换）。

---

## 6. 决策记录（ADR 摘要，全文见 spec）

### ADR-001 内核路线：**自研 mini 反应式内核（B）为主，marimo 后端复用（A）为备**
- 选项 A：子进程跑 marimo server，自研前端说它的 WebSocket 协议。得：反应式语义零成本、.py 格式天然兼容。失：协议内部且易变；schema 嗅探、stale 策略、多内核都要绕着它做；Agent  introspection 深度受制于人。
- 选项 B：自研 Python 内核（AST 提取 defs/refs → 拓扑执行 → 失效传播），进程内 introspection 完全自主。得：Agent 工具想要什么就有什么；多内核 trivial；协议自己定。失：glitch-free 级联、环检测、stale 传递性是要啃的硬骨头（marimo 已 solved 的部分我们重做）。
- 选项 C：ipykernel + 外挂 DAG 层。失：有状态内核与反应式语义根本冲突，仅留作生态兼容参考，否。
- **暂定结论**：plan 中设 3 天 spike（S2）+ Go/No-Go 门 G1：B 的原型若在一个 sprint 内达到"级联正确 + 失效正确"，走 B；否则整体切 A（marimo 为 Apache-2.0，协议级集成或 vendor 均合规）。两条路线共用同一 `KernelAdapter` 接口，前端无感。

### ADR-002 文档模型：**单文件 = 单内核 = 自定 .py 格式；Tab = 打开的文件**
截图里的"内核标签页"在 P1/P2 用"多文件多进程"实现（每个 tab 一个 .py + 一个内核进程），语义干净。Session 汇总视图（segments）不改主存储，基于 sidecar 追加式事件日志 `.novalab/session.jsonl`（每次 run/diff/agent 动作一条），P3 再渲染成模态。

### ADR-003 Agent 栈：**Vercel AI SDK（前端流式）+ 本地 Bridge 双形态暴露工具**
Bridge 既是前端 in-process 工具函数的后端，也对外暴露标准 MCP server（stdio）——外部 Agent（如 Claude Code / 桌面 App）可以像截图里"shared with the agent"那样接入同一个 notebook。工具集 = 方案书 4 个 + `list_cells` / `get_cell_code` 两个只读辅助。

### ADR-004 UI：**clean-room 复刻**
只依据截图与公开交互描述重建视觉与交互；不反编译、不抄闭源资产；商标与命名回避 Claude/Claude Science。design tokens 自建（暗色、等宽、极简），参考气质而非像素取样。

### ADR-005 外壳：**Tauri 为最终形态，MVP 浏览器先行**
Bridge 从第一天就是独立进程（node），前端 `pnpm dev` 浏览器直连；Tauri 壳在 P1 第 2 周以 devUrl 模式接入（cargo 已就绪），不阻塞前端迭代。P4 才做打包流水线。

### ADR-006 隐私边界：**schema-only 上下文 + 发送内容可视化**
见 M5。补充：Bridge 侧做硬截断（preview 序列化器统一出口），不依赖 Agent prompt 自觉。

### ADR-007 工程基座：**pnpm workspace（app + bridge）+ uv（py/novakernel）**
三包 monorepo-lite：`app/`（React 19 + CM6 + Tailwind v4 + Zustand）、`bridge/`（node TS：WS + MCP + 内核进程监督）、`py/`（novakernel 包 + pytest）。参考仓库只读放 `refs/`，不进依赖图。

### ADR-008 开发自测端点与凭据纪律：**cc-switch tokenplan + gitignored .env.local**
Q7 裁决：开发自测使用本机 cc-switch 中 Claude 桌面端选项栏名为 `tokenplan` 的 URL 与 API Key（Anthropic 兼容代理）。凭据纪律：**项目永不自动读取任何凭据存储**（权限分类器亦拦截此类凭据探索）；两个值由 Owner 手动填入 `app/.env.local`（已 gitignore），`app/src/agent/providers.ts` 只读该文件；P2.1 设置面板上线后迁移 keychain/加密配置。

---

## 7. 开放问题（头脑风暴交互点）— ✅ 2026-10-06 已全部裁决

> **Owner 裁决**：Q1–Q6 全部采纳"我的倾向"列为最终决策；**Q7 = cc-switch 的 tokenplan 端点**（值由 Owner 填入 `app/.env.local`，见 ADR-008）。下表保留为决策档案。

| # | 问题 | 我的倾向 | 影响 |
|---|---|---|---|
| Q1 | 内核路线 B（自研）vs A（marimo 后端）偏好？ | B 为主、spike 验证、A 兜底 | 决定 P1 前两周工作量分布 |
| Q2 | "真·多内核并存"（同屏两个 Python 进程跑不同数据集）是否 MVP 硬需求？ | 否；多 Tab 多文件已覆盖 90% 场景，真多内核放 S1 | MVP 范围 |
| Q3 | UI 文案语言：中文优先 / 英文优先 / 双语 i18n？ | 英文 UI + 中文文档（科研工具惯例），i18n 留 P4 | 组件文案策略 |
| Q4 | 未来开源许可证？ | Apache-2.0（与 marimo 生态兼容，允许 vendor） | **2026-10-07 裁决：Apache-2.0 开源直发**（含 CI/发布页，P4.1/P4.5） |
| Q5 | 产品名：NovaLab 暂定？域名/仓库名是否已占？ | NovaLab 可用则用 | 包名、窗口标题 |
| Q6 | .ipynb 只需导出，还是要双向同步？ | 导出 + 一次性导入转换，双向 Won't | M2 边界 |
| Q7 | 开发自测用哪家 key？（Anthropic / DeepSeek / 本地 Ollama） | 有 Anthropic 用 Anthropic，否则 DeepSeek；Ollama 作离线验收 | M6 自测路径 |

---

## 8. MVP 验收（Definition of Done）

**演示脚本（全本地、断网可跑除 LLM 调用外全部步骤）**：
打开 `demo.py` → 编辑上游 cell → 下游自动标 stale → 运行级联转绿 → 人为制造 `KeyError` → Fix 卡片浮现（附 traceback+schema）→ 行内 Diff → `Tab` 采纳自动重跑转绿 → 底部 REPL 直接查询变量 → 导出 .ipynb。

**量化指标**：冷启动（双击→可编辑）< 3s；cell 运行附加开销 < 50ms；100 cell 滚动 60fps；Bridge 常驻内存 < 150MB；安装包（P4）< 20MB。

---

## 9. 非目标（再次强调）

不做：通用 IDE；Jupyter 插件形态；云端服务；多人协同；非 Python 内核；像素级 1:1 抄袭闭源 UI（clean-room，见 ADR-004）。
