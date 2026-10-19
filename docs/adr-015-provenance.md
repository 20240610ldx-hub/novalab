# ADR-015 结果溯源：输出文件记 SHA-256、产生它的 cell 与输入指纹

> 状态：**已实现**（Owner 2026-10-17："做来源追溯（SHA-256）"）。§5 取舍按推荐默认实现，均可逆。
> 关联：ADR-014（运行日志，`runId` 关联）· [运行包洞察](workflow-insights-bundles.md) §3「结果溯源」· [路线](research-iteration-roadmap.md) 阶段 4「数据文件内容哈希」、阶段 5「交付能识别运行来源」
> 硬约束（不变）：本地优先，记录只落 notebook 目录下 `.novalab/`；不读文件内容进上下文，只算哈希；Agent 出口不变（本 ADR 不新增 Agent 工具）。

## 1. 问题

交付一张图或一个 CSV 时，收件人和半年后的自己都会问：它是哪段代码、在哪次运行里产生的？用的输入还是现在这份吗？之后有没有被手改过？现有 `run.notify file-write` 只给路径，没有内容指纹，也不知道输入。

## 2. 决定

**内核**：exec 窗口内的审计 `open` 事件除写入外也收只读打开，发 `run.notify {kind:'file-read', path}`（同样去重、≤50 条）。过滤运行环境自身的读取：解释器 / site-packages / 用户 site / 内核包 / `~/.cache`、matplotlib 配置目录 / 系统目录（Windows `SystemRoot`，POSIX `/proc /sys /dev /etc /usr/share`）下的路径，以及 `.py .pyc .pyd .so .dll .pth` 与字体文件。临时目录**不**过滤（用户数据与测试常在那里）。真实内核验收：`import pandas, matplotlib` + `read_csv` 只记下那一个 CSV。旧 bridge / 前端忽略未知 kind。

同时修正写事件：exec 结束时已不存在的写入（写完即删的临时文件，例如 `tempfile.gettempdir()` 的可写探测）不再报告——它们不是结果，此前会在输出区显示成一行无意义的「wrote C:\…\Temp\xyj6bfie」。

**bridge**：每次运行结束（ADR-014 记录落盘后），对本次读写过的文件流式计算 SHA-256，追加一行到 `.novalab/provenance.jsonl`：

```json
{"v":1,"ts":"…","sessionId":"s-…","runId":"r-3","cellId":"b","codeSha256":"…",
 "inputs":[{"path":"D:/data/survey.csv","sha256":"…","bytes":1234}],
 "outputs":[{"path":"D:/proj/out/fig1.png","sha256":"…","bytes":5678}]}
```

- 哈希在运行结束后算：同一 cell 先读后写同一文件时，该路径记为输出并标 `inPlace: true`（输入哈希已不可得）。
- 超过 1 GiB 的文件不算哈希（`sha256: null, skipped: 'too-large'`）；运行结束时已不存在的记 `skipped: 'missing'`。
- 异步、不阻塞执行队列；失败只丢这一条记录。

**读取**：rpc `provenance.lookup {notebookPath?, path}` → 最近一次产生该文件的记录，并现场重算：文件现在的哈希是否仍等于记录（`current: 'same' | 'modified' | 'missing'`），每个输入现在是否变了。

**界面**：输出区与会话记录里的「wrote …」行可展开，显示产生它的 cell 与时刻、短哈希、是否被改过，以及各输入的短哈希与是否变化。

**导出**：`.ipynb` 每个 cell 的 `metadata.novalab.provenance` 附该 cell 当前会话最近一次的输入 / 输出指纹；路径在 notebook 目录内写相对路径，目录外只写 `<external>/文件名`（不把本机目录结构带进交付物）。

## 3. 为什么不并入运行日志

运行日志按会话分文件、随会话删除；溯源回答的是"这个文件从哪来"，要跨会话保留（上周产生的图今天还要能查）。所以单独一个按 notebook 的追加文件，以 `sessionId + runId` 关联运行日志。

## 4. 非目标（本包不做）

- 跨 notebook 的溯源（文件被另一个 notebook 读写）：各 notebook 只记自己的。
- 网络 / 数据库输入的指纹（`read_sql`、`requests`）：审计 `open` 看不到。
- 交付附录生成（用运行日志 + 溯源，下一包）。
- 哈希上限可在设置里调整（先用常量，交付附录包一并做设置项）。

## 5. 取舍（推荐默认已实现，均可逆）

| # | 问题 | 推荐（已实现） | 备选 |
|---|---|---|---|
| P1 | 输入怎么认 | exec 期间只读打开的文件，过滤解释器 / 库 / 临时目录 | 只认 notebook 目录内的文件（漏掉外部数据目录） |
| P2 | 大文件 | >1 GiB 不算哈希，只记大小 | 一律算（GB 级 CSV 每次运行多花数秒） |
| P3 | 导出路径 | 目录内相对路径，目录外只留文件名 | 绝对路径（暴露本机目录结构） |
| P4 | 保留期 | 与 notebook 同生命周期，不自动清理 | 按条数 / 天数滚动 |
