# ADR-001: 内核路线——自研反应式内核（B）vs 复用 marimo 后端（A）

> 状态：**accepted**（G1 门裁决 2026-10-06）：**路线 B（自研 novakernel）**
> 决策人：Owner（G1 门，plan.md §1；Q1 裁决倾向 B，S2 达标确认）
> 上游：[intent.md §6 ADR-001 摘要](../intent.md) · [spec.md §6.2](../spec.md) · [plan.md §1](../plan.md)
> 证据：[spike-s1-memo.md](../spike-s1-memo.md)（marimo 0.25.1 协议面侦察，路线 A 定价 12–20 人日 + 维护税）。S2 结果：py/novakernel **86 例 pytest 全绿**（dag 26 / runtime 22 / serialize 13 / introspect 10 / server 7，含 3 个 marimo fixtures）；`scripts/integration-smoke.mjs` 端到端一次绿（bridge × kernel × 模拟前端：open 3 cells/2 edges → run×3 → schema df=4×3 → 编辑上游 → staleSet=3）。

---

## 背景

NovaLab 需要反应式执行内核：AST 级 defs/refs 提取、拓扑执行、编辑后失效传递闭包（stale）、多重定义编译错误、幽灵变量删除（spec §5）。marimo（Apache-2.0，`refs/marimo` @ 0.25.1）已解决同类问题且用纯 .py 主存储。

内核是 P1 全链路地基。两条可行路线共用同一 `KernelAdapter` 接口（spec §6.2，P1.3 冻结）：Bridge ↔ 内核子进程只说"执行语"（`exec_cell / exec_repl / introspect / ping / shutdown`），前端对内核实现无感。

S1 侦察结论摘要（详见 memo）：

- marimo server 对前端暴露的是**私有内部协议**：命令面 ~100 个 HTTP 端点（POST + `Marimo-Session-Id` 头）+ 29 种内核命令；`/ws` 仅内核→前端单向推送 **43 种 op**（`{"op","data"}` 帧）；无 semver/稳定性承诺，但有 msgspec→OpenAPI→TS 生成式类型流水线与 CI breaking-change 门禁（memo §1/§2）。
- 前后端**同仓库同版本同 wheel 发布**，无协议版本协商——marimo 的设计假设是"前后端永远同版本，漂移即整页 reload"（memo §2）。第三方前端 = 当第二客户端，须 pin 版本 + 契约测试。
- 替换其前端的最小消息子集 ≈ **10 个 HTTP 端点 + 13 个 WS op**，适配层核心 500–1500 行 TS；路线 A 全量适配估 **12–20 人日** + 每次 minor 升级 2–4 人日维护税（memo §4/§7）。
- **spec §4 声明的"marimo 兼容子集"不成立**：真 marimo 磁盘格式是 `@app.cell` 装饰器 + `def _(refs)…return (defs,)` 函数体、**文件内不存 cell id**（运行时 4 字母 id + 相似度匹配）；我们的 `# %% [cell-id: 8hex]` 是 percent 风格，marimo 不能直读，只能经 jupytext 单向导入且重发全部 id。互操作 = 双向转换器（2–4 人日），**路线 A/B 都躲不掉**（memo §5）。
- 无头捷径全部排除：`App.embed()` 仅限 marimo kernel 内部调用；`create_asgi_app` 仅只读 RUN 模式；Islands/WASM 是浏览器静态形态（memo §3）。
- 语义缺口：Owner 裁决的 mark-only 策略可用 marimo `runtime.on_cell_change=lazy` 近似，但 ask 模式、副作用 cell 名单、PreviewSerializer 的 head(1) schema 嗅探在其模型中无对应物，需 Bridge 侧模拟或功能降级（memo §4/§8-R4）。
- 许可证：协议级集成不构成衍生作品，无开源义务外溢；vendor 片段义务最重（保留声明+标注修改）；§6 商标条款禁止产品名使用 marimo（memo §6）。

## 选项

### 路线 A：复用 marimo 后端（子进程跑 marimo server，Bridge 做协议翻译）

- **得**：反应式语义（级联/glitch-free/环检测/多重定义拒绝/幽灵变量处理）零研发成本、确定性交付；变量 DAG 推送免费（`variables`/`variable-values` op）；datasources/SQL/export 等现成；Apache-2.0 协议级集成合规负担低。
- **失**：
  - 协议私有且高频演进（0.x minor 无兼容承诺；命令面已发生过 WS→REST 整体迁移），**版本 pin + 契约测试 + 每次升级 2–4 人日维护税**（memo §2/R1/R2）。
  - 适配工作量 **12–20 人日**（memo §7），不低于路线 B 的排期投入，且换来的是长期外部依赖。
  - introspect 深度、stale 策略、副作用名单受制于人，NovaLab 差异化特性（Agent schema 上下文、mark-only/ask 策略钩子）需绕行模拟（memo §4/R4）。
  - 多内核 = N 个完整 marimo server 进程（uvicorn+LSP+文件管理），P3.1 成本超瘦内核一个量级（R6）。
  - ".py 格式天然兼容"卖点**不成立**（R3）：转换器两路线都要写。
  - 握手复杂度：双 token（auth + skew protection）、5 种连接类型、capability 协商（R5）。

### 路线 B：自研 Python 内核（py/novakernel）

- **得**：协议自己定（spec §6.1/§6.2 已成文）；introspect/PreviewSerializer/副作用启发式/stale 策略与 Agent 工具集完全自主；多内核 trivial；瘦进程冷启动快（<3s 指标友好）。
- **失**：defs/refs 提取边角（walrus/match/comprehension 作用域）、失效传递闭包、幽灵变量删除是硬骨头——marimo 已 solved 的部分重做（纪律：读思路、依据文法自写测试断言、不抄代码，memo §6 做法 3）。
- **投入**：S2（2 人日 spike）+ P1.2（~5–8 人日，已排期），合计 **7–10 人日**，无外部漂移、无维护税。
- **验证**：✅ S2 黄金集扩至 86 例全绿——作用域边角（walrus/match/comprehension/lambda/global/del）、级联副作用跳过与失败分支阻断、幽灵变量清除、serialize 往返无损均覆盖；端到端集成冒烟绿。**G1 达标。**

### 路线 C：ipykernel + 外挂 DAG 层

有状态内核（隐式乱序执行、magic、变量不可枚举回收）与反应式语义根本冲突，无法保证"状态永远可信"北极星。**否**（intent.md §6 已裁决，本 ADR 维持）。

## 后果

### 若选 B（预期路径）

- S1 侦察降级为知识资产：marimo `_ast/compiler.py`、`_runtime/graph` 继续作为 defs/refs 边角与级联语义参考读物（plan §6 阅读地图）；memo 的证据表可作 P1.2 测试用例设计的文法依据（行为描述级，不抄表达）。
- 风险集中在内核边角 bug → 缓解：黄金集 + fixtures 往返测试（spec §14）。
- serialize.py 需实现 `# %%` 子集 ↔ 真 marimo 格式双向转换器（2–4 人日，含 id 映射策略：我们持久 8hex id，marimo 侧每次加载重发）。

### 若选 A（兜底路径）

- 前端零改动（`KernelAdapter` 冻结于 spec §6.2）；工作量转移至 Bridge `MarimoAdapter`：12–20 人日（memo §7 分解）；novakernel 退役为转换器/工具。
- 必须落实：pin marimo==0.x.y、启动时 `/api/version` 校验拒配（R8）、消息 fixture 契约测试、CI 接入其 openapi-diff 门禁工具链（R1）。
- NovaLab 差异化特性受限（R4）：Agent introspection 深度、ask/副作用策略为模拟实现；产品风险高于工程风险。
- .py 转换器照样要写（R3），A 的格式收益归零。

### 切换成本（对称性）

`KernelAdapter`（spec §6.2）是唯一切换点：B→A 与 A→B 都只动 Bridge 内核适配实现，前端与 MCP 工具层零改动。不对称处在长期成本：**A = 一次性 12–20 人日 + 每 minor 升级 2–4 人日持续税 + 差异化受限；B = 一次性 7–10 人日 + 自有边角 bug 风险（S2 验证中）**。切换窗口 = G1（W1 末）；过窗后 P1.4+ 按 B 的消息流实现，再切 A 仍只需重做 Bridge 翻译层。

## 决策

**路线 B（自研 novakernel）** —— G1 门 2026-10-06 裁决。

依据：S2 黄金集 86 例全绿、无结构性缺陷（作用域模型正确、级联/失效语义正确）；端到端集成冒烟（bridge × kernel × 模拟前端）一次绿；S1 侦察定价路线 A 为 12–20 人日 + 每 minor 2–4 人日维护税且差异化受限（"可行但不划算"）。
路线 A 保留为兜底：切换点 = `KernelAdapter`（spec §6.2）不变；触发条件 = P1/P2 期间 novakernel 暴露**结构性**缺陷（作用域模型根本错误等），边角 bug 一律 P1.2 纪律内收敛。
后续：P3.6 marimo 双向转换器；`refs/marimo` 降级为参考读物（plan §6 阅读地图）。

## 相关

- 侦察证据：[docs/spike-s1-memo.md](../spike-s1-memo.md)（Q1–Q6 + 工作量 + 风险清单 R1–R8 + 证据表）
- 接口冻结：spec §6.2（P1.3 交付）
- 许可证：marimo = Apache-2.0（memo §6）；NovaLab 拟 Apache-2.0（intent Q4 裁决）
- ADR-004（clean-room UI）独立于本 ADR：即使走 A 复用后端，前端仍为 clean-room 自研。
- spec §4 / intent M2 / ADR-002 表述已按 memo §5 修订完成（2026-10-06，G1 后文档维护）。
