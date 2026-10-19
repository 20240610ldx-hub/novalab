# 提案：bridge 断线期间的草稿恢复日志（A15 子包，第 7 轮后续）

> 状态：**Owner 已裁决并实现，未提交**（2026-10-17）。裁决原文："Approved as recommended: O1 Rust command, O2 any existing absolute .py file writing only its sibling .novalab/drafts, O3 use the frontend's last confirmed baselineSha256, O4 no browser-dev fallback, O5 start with unit tests + build regression and add the WebView2 real-window smoke, O6 bridge stays the online writer. Red tests first, then green." 实现结果见 §8。基于分支 `claude/novalab-draft-recovery`（第 7 轮，未提交）。
> 前置：第 6 轮（断线允许编辑）、D4（`baselineSha256`）、第 7 轮（bridge 写 `.novalab/drafts` 日志、重开只提示）。

## 1. 缺口

第 7 轮的日志由 bridge 写。bridge 断线时（第 6 轮 `reconnecting` / `down`，或新一代上线前的 bridge-lost tab）前端仍允许编辑，但：

- `scheduleDraftJournal` 在 `bridgeOffline() || tabBridgeLost()` 时直接返回（`app/src/store/notebook.ts`）；
- 这些草稿只在 WebView 内存。断线期间 WebView/应用再死，草稿全丢；
- 这正是第 6 轮最可能产生大量未保存编辑的状态（自动重启最多 3 次/60 s，失败后进入 down，用户可能继续写很久）。

## 2. 建议方案（混合：在线 bridge 写，离线 Tauri 写）

| 状态 | 写入方 | 基线指纹来源 |
|---|---|---|
| 在线（第 7 轮，不变） | bridge `draft.write` | bridge 记录（`ctx.cache.baselineSha256`） |
| 断线 / bridge-lost（新增） | Tauri Rust 命令 `write_draft_journal` | 前端 tab 上最后确认的 `baselineSha256`（D4 在 open / 保存 ACK / reload / restart 时更新） |
| 浏览器 dev（无 Tauri） | 不写（与今天相同） | — |

**同一格式、同一目录**：Rust 写出的文件与第 7 轮完全相同——`<notebook 目录>/.novalab/drafts/<basename>.<ms>-<rand8>.draft.json`，内容 `{version:1, notebook, baselineSha256, savedAt, cells:[{id,code}], dirtyCellIds}`；同样的临时文件（`create_new`，POSIX 0600）→ `sync_all` → `rename`，POSIX 尽力 fsync 目录；同样的 5 份 / 7 天 / 2 MiB 有界清理。**读取、提示、恢复、保存为副本、清除全部仍由 bridge 负责**（第 7 轮代码不变），所以离线写入的日志在下次 `notebook.open` 时自然被提示。

**前端流程**（`scheduleDraftJournal` / `writeDraftJournal`）：

1. 去抖 1.5 s 后仍有草稿；
2. 在线 → `bridge.rpc('draft.write', …)`（现状）；
3. 断线或 bridge-lost 且 `isTauri()` → `invoke('write_draft_journal', {notebookPath: tab.path, baselineSha256: tab.baselineSha256 ?? null, cells, dirtyCellIds})`；成功后同样置 `draftJournaled`；
4. 重连（同实例）后草稿补发保存成功 → 现有 `afterSuccessfulSave` 发 `draft.clear`，bridge 一并删掉 Rust 写的份；新一代 bridge → 第 6 轮 D4 重开路径已置 `draftJournaled`，保存成功后同样清除。

**Rust 命令的边界**（`app/src-tauri/src/drafts.rs`，只用标准库，无新依赖）：

- 只接受绝对路径、已存在的普通文件、扩展名 `.py`；目标目录固定为其同级 `.novalab/drafts`，文件名由 Rust 生成，前端不能指定；
- 校验 `cells` 只含字符串 `id`/`code`、`dirtyCellIds` 为字符串数组、序列化 ≤ 2 MiB、`baselineSha256` 为 64 位十六进制或 null；
- 不读、不删日志以外的任何文件；不触碰 notebook 本身；
- 返回 `{draftId, bytes}` 或带原因的错误（超限时前端沿用第 7 轮 tab 提示）。

**信任与风险**：Tauri 2 未声明 app ACL 时，`generate_handler!` 注册的命令对 main 窗口全部开放（`restart_bridge` 即如此）。主框架内任何脚本都能调用它。最坏情况是在某个 `.py` 旁写入不超过 5 份 × 2 MiB 的 JSON，而这些内容只会在重开时被**提示**，恢复也只是放回本地草稿、不写盘。离线时指纹由前端提供，Rust 无法核实；若被伪造为"一致"，后果同样限于"提示恢复"。富输出若在主框架渲染不可信 HTML，这一信任面已存在，不由本包引入。

## 3. 备选

| 方案 | 优点 | 缺点 |
|---|---|---|
| A. Rust 命令（推荐） | 无新依赖；路径与内容由 Rust 收口；与 `restart_bridge` 同一机制 | 需在 Rust 重写写入与有界清理（约 120 行），格式两处实现 |
| B. `tauri-plugin-fs` | 前端直接写文件，Rust 代码少 | 新插件 + capability 配置；scope 难以表达"任意 notebook 旁的 `.novalab/drafts`"，易放得过宽；原子写/清理仍要在前端重写 |
| C. 离线写 localStorage，重连后转交 bridge | 浏览器 dev 也可用 | 违背 Owner"放在 notebook 旁"的裁决；WebView 数据目录被清理即丢；应用退出后再未连上 bridge 就不会落到 notebook 旁 |
| D. 离线日志一律记 `baselineSha256: null` | 不信任前端指纹，最保守 | 离线草稿重开时永远只能"保存为本地副本"，无法直接恢复 |

## 4. 格式唯一来源

格式由两种语言实现，靠共享夹具防漂移：

- 新增 `bridge/test-fixtures/draft-journal/`：一份合法 v1 日志与若干非法样例（多字段、错类型、超长 id）；
- bridge 测试：第 7 轮 `readDraft` 解析合法样例、拒绝非法样例；
- Rust 单测：序列化结果与合法样例的键集合/类型一致；文件名匹配同一正则；5 份 / 7 天清理与 Node 版同一组用例（表驱动）；
- 前端测试：断线时走 `invoke`、在线时走 RPC、浏览器 dev 不写、超限提示。

## 5. 验收

1. 先红：Rust `drafts.rs` 单测、前端 `draftRecovery.test.ts` 新增离线用例、bridge 夹具用例。
2. 绿：`cargo test --lib`、`cargo build`、bridge/app vitest、构建、Python、脚本、集成与 packaged smoke。
3. 真实证据（二选一，见 O5）：
   - 基础：Rust 单测 + 构建目录回归（与第 6 轮 Tauri 监督同等级别，非真实窗口）；
   - 加强：用 WebView2 远程调试端口（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=…`）驱动**真实 Tauri 窗口**：杀自有 bridge → 断线中编辑 → 观察 Rust 写出日志 → 关窗口 → 重启应用 → 提示恢复。这也会首次在真实窗口里覆盖第 6 轮 `restart_bridge` 与第 7 轮流程，但需要构建 Tauri 应用、管理更多自有进程，耗时明显更长。
4. 新封存 `manifest-drafts-offline-round7b.json` / `results-…`，不覆盖前七轮。

## 6. 不覆盖

去抖 1.5 s 内的最新输入；Tauri 进程本身被杀（WebView 与 Rust 同时消失）时去抖窗口内的内容；跨机器同步；Linux/macOS 以 CI 为准。

## 7. 待 Owner 裁决

| # | 问题 | 建议 |
|---|---|---|
| O1 | 离线写入通道 | **A：Rust 命令**（无新依赖，路径与内容由 Rust 收口） |
| O2 | Rust 接受哪些路径 | **任意已存在的绝对 `.py` 普通文件**，只写其同级 `.novalab/drafts`；不另设白名单（离线时唯一的打开列表来自前端，信任等级相同） |
| O3 | 离线日志的基线指纹 | **用前端最后确认的 `baselineSha256`**（使离线草稿在磁盘未变时可直接恢复）；保守替代为 D（一律 null，只能存副本） |
| O4 | 浏览器 dev 回退 | **不写**（与 Owner"notebook 旁"裁决一致；dev 不是交付形态） |
| O5 | 验收强度 | 基础（单测 + 构建回归）先行；是否追加 **WebView2 真实窗口 smoke** 由 Owner 决定（推荐追加，可同时补上第 6/7 轮在真实窗口中的空白） |
| O6 | 在线时是否也改由 Rust 写 | **否**：在线仍由 bridge 写，指纹以 bridge 记录为准 |

## 8. 实现结果（第 7b 轮，Windows-only 证据，未提交）

- **Rust**：`app/src-tauri/src/drafts.rs` + `lib.rs` 命令 `write_draft_journal(notebookPath, baselineSha256, cells, dirtyCellIds) → {draftId, bytes}`。校验：绝对路径、`.py`、已存在普通文件；基线只接受 64 位小写 hex 或 null；cell 字段 `deny_unknown_fields`。写法与第 7 轮相同（`create_new` 临时文件、POSIX 0600、`sync_all`、rename、POSIX 目录 fsync），同样 5 份 / 7 天 / 2 MiB。
- **前端**：断线或 bridge-lost 且 `isTauri()` → `invoke('write_draft_journal')`，基线取 tab 上最后确认的 `baselineSha256`；在线仍 `draft.write`；浏览器 dev 断线不写；断线时不再取消待写的去抖。超限提示同时识别 Rust 的字符串错误与 bridge 的 -32602。
- **格式唯一来源**：`bridge/test-fixtures/draft-journal/`（合法 v1、5 个非法样例、4 个清理用例），Node（`drafts.fixtures.test.ts`，11 项）与 Rust（`drafts.rs` 单测）共用。
- **先红后绿**：Rust 8 项失败（桩）→ 绿；前端离线用例 5 失败 / 2 通过（2 个是"不得写入"守卫）→ 绿。
- **真实窗口 smoke**（`scripts/tauri-window-draft-smoke.mjs`，第 9 次运行通过）：WebView2 远程调试端口驱动 `target/debug/novalab.exe`；打开 a.py（指纹 = 磁盘）→ 只杀自有 bridge → Rust 监督重启、tab 保持 bridge-lost → 编辑 → 经 `http://ipc.localhost/write_draft_journal` 写出日志（`draft.write` 0 次），内容与指纹正确、磁盘未变 → 杀整个应用树 → 重启应用 → 指纹一致提示 → 点击恢复：草稿回到编辑器、未发 `cell.save`、磁盘未变。自有 PID 36 个，残留 0。
- **新发现（既有行为，非本包引入，未修）**：桌面冷启动时 WebView 先于开发 bridge 监听加载；首次 `connect()` 只尝试一次，且 store 只在首次成功后订阅状态，所以窗口停在"bridge 未连接 … 刷新"横幅，`retryBridge` 在 idle 状态也无法让界面恢复，只能刷新。smoke 按横幅提示在自有 bridge 就绪后刷新一次并记录（`initialConnectIdleThenReload: true`）。打包版 sidecar 也存在同一竞态的可能，建议另立小包：首次连接失败也进入有界重连并始终订阅状态。
- **调试过程**（日志保留）：run1 Vite 绑 `localhost` 在沙箱内 IPv6 回环 EACCES → 改 127.0.0.1；run2 未登记应用导致 bridge 孤儿 → 立即登记 + 自有 PID 清扫（孤儿已按清单 PID 手动清理）；run3–6 冷启动 idle（见上）；run7–8 `__TAURI_INTERNALS__.invoke` 不可写/不可配置，改由 CDP 网络事件观察 IPC。
- 封存：`manifest-drafts-offline-round7b.json` / `results-drafts-offline-round7b.json`，校验前七轮与第 7 轮封存未变。
