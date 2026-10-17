# ADR-014 追加式运行日志：每次运行都留下可复盘的记录

> 状态：**已采纳**（Owner 2026-10-17："先做追加式运行日志"；同日裁决 O2 = 开放 Agent 读取运行历史、历史快照不存图）。§5 其余取舍按推荐默认实现，均可逆。
> 关联：[运行包洞察](workflow-insights-bundles.md) §2/§4 · ADR-013（影子执行）· [路线](research-iteration-roadmap.md) wave-2「Agent 运行复盘」「带核验附录的交付」
> 硬约束（不变）：本地优先，记录只落 notebook 目录下 `.novalab/`；Agent 出口仍按 M5 白名单（新增工具 `get_run_history` 同样过两道闸，见 §6）。

## 1. 问题

- 参考应用导出的 `.ipynb` 只剩 stdout；我们当前会话导出保留 error 与图，但**同一个 cell 改一点再跑只留最后一次**（运行包里相邻 cell 相似度 > 0.8 的"改一点再跑"：4 包 7 次 + 完整执行记录版 6 次），失败尝试、改了什么、谁触发的都没有。
- 现有 `.novalab/sessions/<id>.jsonl` 事件流只有 `{ts, kind:'run'|'error', actor, cellId, payloadRef:'exec:N'}`：没有代码版本、耗时、级联、结果摘要；Agent 经 `execute_cell` 触发的运行也记成 `actor:'user'`。

## 2. 决定

每个内核会话旁新增 `.novalab/sessions/<sessionId>.runs.jsonl`，**每个被执行的 cell 一行**（直接运行、级联下游、采纳 Diff 后的运行、REPL 各自成行）：

```jsonc
{ "v": 1, "runId": "r-12", "ts": "2026-10-17T14:02:03.120Z", "durationMs": 84,
  "cellId": "a1b2c3d4", "attempt": 3,            // 该 cell 在本会话的执行计数（失败也计，见 PR #10）
  "actor": "user" | "agent",                     // agent = 经 execute_cell 确认后运行
  "trigger": "direct" | "cascade" | "accept" | "repl",
  "rootRunId": "r-11",                           // 级联时指向触发它的那次运行
  "codeSha256": "…", "code": "…",                // code 只在本会话首次出现该哈希时内联（去重）
  "ok": false, "error": { "name": "KeyError", "line": 3 },   // 不存 evalue（可能含数据值）
  "out": { "stdoutBytes": 120, "stderrBytes": 0, "mime": ["text/plain"], "writes": ["out/a.csv"] } }
```

- **只追加**，崩溃时最多丢最后一行；读取宽容（坏行跳过）。
- **不存输出内容**（stdout 正文、图、表）：日志回答"跑了什么、成没成、改了哪里"，结果内容仍归快照/导出。
- **预算**：每会话最多 10,000 行；代码正文累计 2 MB 后只记哈希（`codeOmitted: true`）。超限只写一次 `{"v":1,"truncated":true}` 标记。
- **读取**：rpc `session.runs {path?, sessionId?, cellId?}` → `{records, truncated}`，给本机前端；Agent 只经 `get_run_history`（§6）读当前会话的精简视图。
- **导出**：`.ipynb` 每个 cell 的 `metadata.novalab.runs` 附该 cell 最近 50 次尝试的 `{attempt, ts, durationMs, ok, error, actor, trigger, codeSha256}`（无代码正文、无输出），交付物里能看到"跑过几次、哪次失败"。
- **界面**：Session 视图 cell 头显示「N runs」，展开看每次尝试（成败、触发方、耗时）与相对上一次的代码差异。

## 3. 为什么不改现有事件流

`<id>.jsonl` 是 spec §11 / ADR-002 定义的审计流（kind 枚举、payloadRef 约定），已有读者（会话列表、计数）。运行记录字段多、会去重存代码、有独立预算，放同一文件会让审计流变重且难以单独截断。两文件同生命周期、同目录，一起导出/删除。

## 4. 非目标（本包不做）

- 历史快照存图（Owner 2026-10-17 裁决：不存）。
- 交付附录生成（用本日志 + 溯源做，下一包）。

## 5. 取舍（推荐默认已实现，均可逆）

| # | 问题 | 推荐（已实现） | 备选 |
|---|---|---|---|
| O1 | 代码正文存不存 | 存，按哈希去重，2 MB/会话上限 | 只存哈希（无法回放"改了什么"） |
| O2 | Agent 能否读运行历史 | **Owner 裁决：开放**（§6），含相对上一次的代码变化行 | 只回元数据、不给代码差异 |
| O3 | 错误信息粒度 | 异常类名 + 用户 cell 行号，不存 evalue | 存截断的 evalue（可能含数据值） |
| O4 | 导出附历史 | 附元数据（最近 50 次，无代码） | 不附 / 附代码各版本 |

## 6. Agent 读取：`get_run_history`（O2）

- **入参**：`{cellId, limit?}`（默认 10、最多 20 次）。只读当前聚焦 notebook 的**当前会话**，不能翻历史会话。
- **出参**：`{cellId, totalAttempts, attempts[{attempt, ok, actor, trigger, durationMs, error?{name, line?}, codeChanged, diff?}]}`。`diff` 只含相对上一次尝试的变化行（`- 旧` / `+ 新`），每次上限 2000 字符；正文因预算未记录时只给 `codeChanged`。
- **不出进程**：stdout / stderr / evalue / 富输出 / 写入路径 / 代码哈希。代码以"变化行"出现，和 `get_cell_code` 同属 spec §7 白名单"代码文本"类。
- **两道闸**：router `agent.runHistory` 只构造上述字段；M5 输出白名单再按 zod 形状 strip 未知键、`attempts[].diff` 封顶。pi 运行时的受限宿主（M4）放行 `agent.runHistory`（只读）。
- **用途**（system prompt）：反复失败或用户问"之前改过什么"时查看，避免重复已经失败过的改法。
