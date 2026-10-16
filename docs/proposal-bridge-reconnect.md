# 提案：bridge 进程死亡 → 桌面恢复/重连（A15 子包，第 6 轮）

> 状态：**已裁决并实现（2026-10-16，第 6 轮，Windows-only 验收）**。Owner：D1 clean tab 等用户点击重开（覆盖下文“自动”建议）；D2 60 s 内最多 3 次；D3 断线期间允许编辑。D4 同日获批并实现（`baselineSha256` 进入内核与 bridge 协议；dirty tab 重开时核对：未变续存、已变或未知走冲突流程），证据见 checklist 第六轮补充与 `manifest-reconnect-round6-d4.json`。退避、90 s 预算、手动重试重置额度、断线期间禁止运行/保存为默认值，待确认。证据见 checklist §9 第六轮。
> 原状态：设计提案，待 Owner 裁决，未写代码。基线 `bce0c2d`（第 1–5 轮），分支 `claude/novalab-bridge-reconnect`。
> 范围外：跨应用（WebView 也死）草稿恢复、Linux/macOS 复测、watchdog/session resume、自动执行或副作用重放。

## 0. 核实到的现状（决定设计的事实）

| # | 事实 | 位置 | 后果 |
|---|---|---|---|
| F1 | `ws.onclose` 只拒绝 pending、清空 ws/token；不重连，也**不通知 store** | `app/src/bridge/client.ts` | bridge 死后 `bridgeConnected` 仍为 true，横幅不出现，直到某次 RPC 失败 |
| F2 | `connectBridge` 只在首次失败时置 false；`openNotebook` 失败也置 false | `app/src/store/notebook.ts:813` | 无"重连中"状态，提示用户"刷新" |
| F3 | `notebookId = nb-<random>` 每个 bridge 进程随机 | `bridge/src/router.ts:415` | 新 bridge 里旧 tab 的 id 全部失效，必须按 path 重开并把 tab/cache/drafts 改键 |
| F4 | `refreshList` 用 bridge 的 `notebook.list` **整体替换** tabs；TabBar 在 `bridgeConnected` 变 true 时调用它 | `app/src/store/notebooks.ts:203`、`TabBar/index.tsx:72` | 朴素重连会把所有 tab（含 dirty）从 UI 抹掉（drafts 仍在 caches 里但无入口） |
| F5 | 第四轮基线字节 `_file_baseline` **只存在内核进程内存** | `py/novakernel/runtime.py:270,420,501` | bridge 死 → 内核死 → 基线丢失。新内核 `load_file` 会把"当时的磁盘"当新基线：断线期间的外部修改会被静默接纳，随后保存 dirty 草稿会**覆盖外部修改**——违背第四轮承诺 |
| F6 | Tauri `spawn_bridge` 只在 setup 调一次；退出时 `kill_bridge`（Windows `taskkill /T /F`） | `app/src-tauri/src/lib.rs:47,255` | 无监督、无重启 |
| F7 | 新 bridge 有新 token、可能落到 7788–7798 内另一端口 | `bridge/src/main.ts:75,252` | 每次重连都要重新 discovery + `bridge.auth`；LLM proxy origin/header 也随之变化 |

F4、F5 是本包真正的风险点：前者会丢 UI 入口，后者会破坏冲突保护。

## 1. 前端连接状态机（`BridgeClient`）

```
            auth ok                     ws close / error（已认证后）
 idle ──────────────▶ connected ─────────────────────────────▶ reconnecting
                         ▲                                         │  每次尝试 = discovery 扫描 + 新 WS + bridge.auth（新 token）
                         └──────────── auth ok（generation+1）──────┤
                                                                   │  预算耗尽
 down ◀────────────────────────────────────────────────────────────┘
   │  用户点击「重试连接」→ 重置预算 → reconnecting
```

- 新增 `status: 'connected' | 'reconnecting' | 'down'`、`generation: number`、`onStatus(listener)`；store 订阅后维护 `bridgeConnected` 与新字段 `bridgeStatus`，修 F1/F2。
- **有界退避**：0.25 s → 0.5 → 1 → 2 → 4 → 5 s 封顶；总预算 **90 s**（覆盖 Tauri 侧 3 次重启 + 退避 + node 冷启动），然后 `down`。`down` 不再自动尝试，横幅给「重试连接」按钮；在 Tauri 内同时调用新命令 `restart_bridge`（见 §2）重置 Rust 侧预算。
- **同一 bridge 还是新 bridge**：重新 auth 后若 token 与上一代相同（只是 WS 断了，进程仍在）→ 视为同代，`refreshList` 即可；token 不同 → 新代，进入 §3 的 tab 恢复。token 只在内存比较，不记录、不写日志。
- 新代后：重新取 `llmProxyOrigin`/header（provider 水合从"页面生命周期一次"改为"每代一次"）。

## 2. Tauri 侧子进程监督（`lib.rs`）

- 纯函数策略 `RestartPolicy { window: 60 s, max_restarts: 3, backoff: [1 s, 2 s, 4 s] }`，`fn on_exit(&mut self, now: Instant) -> Decision { Restart(Duration) | GiveUp }`；**Rust 单测**注入时间覆盖：窗口内第 4 次 → GiveUp、窗口滑出后恢复、退避序列。
- 监督线程：spawn 后每 500 ms `try_wait()`（短持锁）；意外退出 → 按策略退避后重 spawn（packaged/dev 同一路径）；GiveUp → 记录日志，停止监督，等前端 `restart_bridge` 命令（重置窗口后 spawn）。
- **关停不误重启**：`AtomicBool shutting_down` 在 `RunEvent::Exit` 中先置位，再 `kill_bridge`；监督线程见到置位即退出。
- 重 spawn 前对旧 PID 尽力 `taskkill /PID <old> /T /F`，清理可能残留的 uv/python 孙进程；内核本身在 stdin EOF 时应退出——实现阶段用 smoke 实测"旧代 `novakernel.server` 无残留"，若有残留再评估 Job Object（不在本包预设）。
- `NOVALAB_BRIDGE=external` 时不监督（与现状一致）。
- 验证口径：Rust 单测 + `cargo build` 构建目录回归；packaged smoke 只算 build-directory 回归，**不算安装器验收**。

## 3. 新一代 bridge 上各 tab 的处理

公共步骤（新代 auth 成功后，**在任何 `refreshList` 之前**）：

1. 所有旧 tab 标记本地字段 `bridgeLost: true`、`ended: true`、`kernelState: 'dead'`；保留 caches、drafts、conflict、recoveryPath；清除 `restarting`/`closing`/`reloading` 在途标记并写可重试错误。
2. `refreshList` 改为**合并**：bridge 列表里没有、但本地 `bridgeLost` 的 tab 不删除（修 F4）。
3. 重开 = `notebook.open {path}`（bridge 内只 `load_file`），**不执行、不重放**；成功后把旧 id 的 tab/cache/drafts/activeId 原子改键到新 id（只有 path 匹配才改，防串 owner，沿用第五轮 owner 捕获写法）。
4. 内核、会话、outputs、staged Diff、执行计数、临时 REPL 均视为丢失：清空并提示「bridge 已重启，内核与输出未保留」；旧会话日志在磁盘上，仍可在历史中 `session.open` 查看。

**跨代基线指纹（修 F5，本包必须做）**：
- 内核 `load_file` / `save_file` 结果追加 `baselineSha256`（对 `_file_baseline` 原始字节求值，不含内容）；bridge 在 `notebook.open`/`notebook.state`/保存响应中透传；前端按 tab 保存最后确认的指纹。
- 重开后比较新旧指纹：
  - 相同 → 磁盘未变，drafts 叠回，之后显式保存仍走第四轮内核字节检查（新内核基线 = 同样的字节）。
  - 不同 → clean tab：直接显示磁盘版本并提示"磁盘版本在断线期间已变化"；dirty tab：**进入既有冲突流程**（`pauseForConflict`：`backup_file` 写本地恢复副本、保留草稿、用户选择加载磁盘版本），不静默合并、不覆盖。
- 断线瞬间在途的保存结果未知：草稿 revision 未被 ACK 确认，tab 保持 dirty；重开时若磁盘已是我们写的内容，指纹也会不同 → 走冲突流程（保守，双方内容一致，只多一次确认）。

**clean tab**（待裁决 D1）：
- 选项 A（**建议**）：新代后自动冷重开，焦点 tab 优先、其余串行；失败的保持 `bridgeLost` + 「重新打开」按钮。理由：只 `load_file`、无执行、旧输出本来就已丢；用户回来即可继续。
- 选项 B：全部等用户点击「重新打开」（与第五轮"显式点击重启"口径最一致，但多 tab 时操作多）。

**dirty tab**：永不自动重开。显示「草稿保留；保存或重新打开前会校验磁盘是否变化」。用户点「保存」→ 先重开 + 指纹比较 → 一致才发送保存（内核再做第四轮字节检查）；点「重新打开」→ 同样比较，drafts 仍叠加为未保存状态。

## 4. 重连期间 RPC 语义

- **pending**：连接关闭瞬间全部以 `BridgeDisconnectedError`（新错误类，区别于 `BridgeRpcError` 的内核/协议错误）拒绝，**不重试、不重放**（exec/save 非幂等，且无法知道是否已送达）。运行中的 cell 标记"中断（bridge 断开）"，不伪装为内核结果。
- **新 RPC**：`reconnecting`/`down` 期间立即以 `BridgeDisconnectedError` 失败，**不排队**——排队请求在新代会指向失效的 notebookId，且新内核还没有基线。运行/保存/Diff/Agent 入口按 `bridgeStatus` 禁用并给出原因。
- 新代上线后旧 id 的迟到响应/通知：新代不会发出旧 id；前端按 owner 捕获仍丢弃不匹配的。

## 5. 断线期间是否允许编辑（待裁决 D3）

- 选项 A（**建议**）：允许编辑 cell 代码；草稿只在前端内存累积，tab 变 dirty（因此不会被自动重开），运行/保存禁用。风险：若 WebView 也随后死亡，这段草稿丢失——属于"跨应用草稿恢复"下一包。
- 选项 B：断线期间全部只读，减少需要保护的状态，但用户在等待时无法继续写。

## 6. 待 Owner 裁决

| # | 问题 | 建议 |
|---|---|---|
| D1 | 新代后 clean tab 自动冷重开，还是等用户点击 | 自动（只 `load_file`，不执行） |
| D2 | Tauri 重启上限 | 60 s 内最多 3 次，退避 1/2/4 s；超限后前端「重试连接」可手动重置；前端重连总预算 90 s |
| D3 | 断线期间是否允许编辑 | 允许编辑、禁止运行/保存 |
| D4（附带）| 跨代基线指纹需要内核/bridge 协议各加一个字段 `baselineSha256` | 同意（否则 dirty 保存在断线后的外部修改面前不安全） |

## 7. 裁决后的实现与验收顺序（先红后绿）

1. 失败用例：`client.test.ts`（close → pending 结算、状态 reconnecting、退避上限后 down、token 变化 → generation+1、断线期间 rpc 立即失败）；`notebooks.test.ts`（新代不抹 tab、改键、dirty 不自动重开、指纹不同 → conflict）；bridge/py 指纹字段测试；Rust `RestartPolicy` 单测。
2. 实现 §1–§5。
3. 门：bridge/app vitest、类型检查、生产构建、py pytest、`cargo test`（监督策略）。
4. 新增 `scripts/bridge-reconnect-smoke.mjs`（真实 Chromium，参照 `kernel-restart-smoke.mjs`/`smoke-runtime.mjs`）：A clean、B dirty；在 A 上挂一个长运行 cell → 按 PID 杀**本 smoke 自有的 bridge**（不是内核）→ 断言重连横幅、pending 结算为断开错误、运行/保存禁用 → harness 拉起新的自有 bridge 并切换 `/bridge-info` 路由 → 断言 A 按裁决冷重开（无 `exec_*`、计数为空）、B 草稿保留且未自动重开；断线期间外部修改 B 文件 → 保存 B 进入冲突流程且磁盘外部字节不变；页面错误 0；旧代内核无残留、两代进程树与临时目录均清理。
5. 证据：`demos/.novalab/validation-20261014/` 新建 `seal-reconnect-round6.mjs`、`manifest-reconnect-round6.json`/`results-reconnect-round6.json`/`stage6-reconnect-*.log`（路径脱敏、无 token），不覆盖前五轮；然后追加 checklist §9 / roadmap 新节，更新 `plan.md`、feature-matrix（仅凭真实浏览器证据升级）。Windows-only，A15 保持开放。
