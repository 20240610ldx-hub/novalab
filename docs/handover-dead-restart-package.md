# NovaLab dead/ended 重启包 · 交接文书

> 日期：2026-10-16 · 工作树：`D:\Notebook Agent\.claude\worktrees\bold-colden-61a1f4`
> 代码基线：`e45a04a82ce2e6cef2d913a4da42de1a3700a4c3` + 本工作树未提交修改
> 本次 fetch 后 `HEAD...origin/main = 0 0`；提交 SHA 不能单独代表受测代码。
> 状态：**实现与单测门已通过；真实 stdio router 验收已通过；真实 Chromium UI 验收脚本已就绪但最后一次运行未完成（预览进程已退出）**。未提交、未 push、未打 tag、未改版本。
>
> **2026-10-17 更新（本文以下内容保留为 10-16 交接原貌，状态以此条为准）**：本包已关闭。真实 Chromium `KERNEL_RESTART_SMOKE_OK`、pytest、`pnpm test:scripts`、集成与构建目录 packaged smoke 复跑通过，独立证据为 `validation-20261014/manifest-restart-round5.json` / `results-restart-round5.json`；checklist §9、路线图 §10、plan.md 与功能矩阵 restart 行（🟡→✅）已更新。提交 `bce0c2d`，随后与第六轮（`5fb39b9`，bridge 重连 + D4）一起经 PR #2 合入 main。§2.3 与 §4 第 1–4 项均已完成；§4 第 5 项中 bridge 重连已完成（第六轮），跨应用草稿恢复在第七轮另行推进。A15 仍未勾选。

## 1. 本包目标与已定策略

Owner 选择「安全保留并阻止重启」：干净（clean）的 dead/ended notebook 可显式冷重启；**脏（dirty）dead/ended notebook 一律不重启**，本地草稿保留、磁盘不被覆盖、不新增自动恢复副本协议。

冻结边界：

- 重启按 notebook owner 寻址，冷加载 `load_file`，**不执行 cell、不重放 REPL、不重放副作用**；
- 成功仅替换原 owner cache：清 outputs / Diff / `needsPersist` / schemas / 执行计数 / 临时 `repl`，结束旧 session 并开新 session；
- 失败保持原 dead/ended、旧 session、cache、output、Diff、草稿，可重试；
- 同 notebook FIFO 与 `restartInFlight` 保证队列与重复请求语义；
- bridge 重连、watchdog/session resume、跨应用或有界草稿恢复**不在本包**。

## 2. 进度

### 2.1 已完成实现

| 层 | 改动 | 位置 |
|---|---|---|
| 协议 | `kernel.restart {notebookId}`；响应 `{notebookId, notebookPath, state}` | `bridge/src/protocol.ts` |
| Bridge | owner 寻址重启；进入 `serializeNotebook` FIFO；`restartInFlight` 拒绝重复；`needsPersist` 拒绝；成功后清理 outputs/diffs/`needsPersist`/ended 并切换 session；失败保留 dead | `bridge/src/router.ts:745` |
| Bridge | `notebook.close` / `notebook.reload` / `cell.save` / `diff.stage|accept|reject` 在重启在途时拒绝 | `bridge/src/router.ts:483,538,633,802,841,892` |
| Bridge | 重启期间不被 stale `restarting/idle` 状态提前解除 ended | `bridge/src/router.ts:1000` |
| 前端 | `NotebookTab.restarting`、`setRestarting`、`canRestartTab`、normalize 保留本地标记 | `app/src/store/notebooks.ts` |
| 前端 | `restartKernel(options?: { allowLive?: boolean })`：owner 捕获、history/conflict/closing/reloading/duplicate 拒绝、dirty 保留草稿并记录可重试错误、响应 owner 校验、只更新 owner cache、冷加载 `execCount: null` | `app/src/store/notebook.ts:1140` |
| 前端 | 重启不再被普通只读护栏吞掉（history 仍在底层拒绝） | `app/src/store/session.ts:628` |
| UI | dead 且非 history 时展示 restart 行；restart 错误显示「重启失败」并提供重试 | `app/src/components/SessionBar/index.tsx:241`、`app/src/components/TabBar/index.tsx:238` |
| UI | Welcome「新会话」保留原 clean-live 行为：`restartKernel({ allowLive: true })` | `app/src/components/Welcome/index.tsx:303` |
| 脚本 | 画廊 restart 改为 owner 寻址 | `scripts/demo-gallery.mjs:737` |

### 2.2 已通过验证

| 门 | 结果 |
|---|---|
| `git fetch` + `HEAD...origin/main` | `0 0` |
| bridge typecheck | 通过 |
| app typecheck | 通过 |
| app build | 通过（仅 chunk >500kB 提示） |
| bridge vitest | 20 files / **274 passed** |
| app vitest | 25 files / **316 passed** |
| 新增真实 stdio router 验收 | **1 passed**（`bridge/src/router.restart.acceptance.ts`） |
| 新增浏览器 smoke 语法检查 | 通过（`node --check`） |
| `git diff --check` | 无 whitespace error（仅既有 LF/CRLF 提示） |

真实 stdio router 验收覆盖：首次仅 `load_file`；崩溃后旧 active/queued 执行按 `-32000` 结算且不写禁止文件；restart 仅新增 `load_file`、无 `exec_*`、执行计数归零、旧 output/Diff 清空；session 历史保留且旧会话可 `session.open`；外部修改导致保存失败后，杀掉该 owner 再 restart 被 `-32000` 拒绝，磁盘外部字节原样保留、未新增子进程。

### 2.3 未完成 / 待续

- **真实 Chromium UI 验收**：`scripts/kernel-restart-smoke.mjs` 已就绪，第二次运行已走通「dead → SessionBar restart → 切 B → dirty refusal」主流程；最后一次因 Vite 预览进程退出（`ERR_CONNECTION_REFUSED`）未完成，**尚未取得通过证据**。代理与计划均要求：不得以直接 bridge 调用、fake kernel、headless 截图或既有 packaged smoke 替代此项。
- Python pytest、`pnpm test:scripts`、`node scripts/integration-smoke.mjs`、`node scripts/packaged-startup-smoke.mjs` 在本包最终改动后尚未复跑。
- 本包独立证据 manifest/results 尚未写入 `demos/.novalab/validation-20261014/`（既有 round-4 封存不得覆盖）。
- `docs/plan.md` 的 next-package 口径、`docs/demos/feature-matrix.md` 的 restart/dead-tab 行尚未更新（需先有浏览器证据）。
- A15 未勾选：bridge 死亡→桌面恢复/重连、跨应用草稿恢复仍缺。

## 3. 卡点与解决方案

1. **dead tab 无法重启**：`session.ts` 的只读护栏同时隐藏入口并阻断动作。改为让重启不受 `readOnly` 拦截，由 `notebook.ts` 自己做 history/owner/dirty/conflict 判定；`SessionBar` 条件由 `!readOnly` 改为 `!historyView`。
2. **A 的响应水合到 B**：捕获 `ownerId/path`，响应必须匹配 owner；切 tab 后只写 A 的 cache，仅在 A 仍 active 时恢复可见 live 状态。
3. **重启绕过写队列 / 后续写作用到新 session**：引入 `restartInFlight`，并在 save/Diff/reload/close 入口拒绝，已先入队者仍先完成。
4. **stale 状态提前解除 ended**：`onKernelStatus` 在 `restartInFlight` 期间不清除 `ctx.ended`。
5. **冷重启保留执行计数**：前端投影显式 `execCount: null`。
6. **dirty dead 静默返回**：dirty/drafts 检查前置到能力判断前，记录 `{ operation: 'restart' }` 可重试错误并保留草稿。
7. **真实 acceptance harness `capture` 未初始化**：`spawnImpl` 回调早于对象构造完成写入 `capture.child`，导致 `notebook.open` 返回错误；改为先建 `capture` 占位再赋值 `transport`。
8. **误判 RPC 结算形状**：`router.handle` 恒 fulfilled，内核取消体现在 `response.error.code = -32000`；断言改为逐项检查，避免把协议封套误判为产品失败。
9. **浏览器 smoke 提前外部写盘**：该写入会触发 watcher → conflict，合法阻止 restart，导致等待钩子不出现；移除该前置后流程走通。
10. **断言与实际冷加载语义不符**：脚本期待已删除的外部 `x = 7`，实际返回磁盘 `x = 1`（正确冷加载）；改为断言冷加载内容且 B 可见状态不变。
11. **预览进程不稳定**：运行期间 Vite 退出导致 `ERR_CONNECTION_REFUSED`；需重启预览后复跑。

## 4. 未来开发计划（按优先级）

1. 重启 Vite 预览，复跑并取回 `scripts/kernel-restart-smoke.mjs` 通过证据（含 owned PID 清理与无 page error）。
2. 复跑 `uv run --directory py pytest`、`pnpm test:scripts`、`node scripts/integration-smoke.mjs`；必要时先 `node scripts/build-bridge.mjs` / `node scripts/sync-py-resources.mjs`，再跑 `node scripts/packaged-startup-smoke.mjs`（仅作 build-directory regression，不作安装器验收）。
3. 建立本包独立 evidence manifest/results（gitignored 校验区）：记录 source/bundle/resource SHA256、平台/toolchain、命令、pass/fail/skip、owned child PIDs 与清理；保留首次失败复现，不写入 token/凭据/真实研究数据/敏感绝对路径。
4. 证据齐备后更新 `docs/release-v0.1.1-checklist.md` §9 与 `docs/research-iteration-roadmap.md`（追加，不改旧记录），再更新 `docs/plan.md`；仅在真实浏览器证据存在时升级 `docs/demos/feature-matrix.md` 的 restart/dead-tab 行，否则保持 `🟡`。
5. 下一包（独立）：bridge 死亡→桌面恢复/重连、跨应用或有界 dirty 草稿恢复；两者完成后才讨论 A15 关闭。

## 5. 纪律与边界（延续）

- 不 commit / push / tag / release / 改版本；未触碰 `refs/`、未复制其文件/注释/测试；未读取 cc-switch、系统凭据或其他 worktree `.env.local`。
- 不使用真实 provider、Owner 真实科研数据、最终安装器或共享桌面/stdio MCP 实例做验收。
- 只停止本包拥有的测试进程与临时目录；不把 fake kernel、直接 bridge 调用或既有 packaged smoke 当作 dead-tab UI 验收。
- 若最终只能完成 Windows 验证，需标注 Windows-only，并保持跨平台 A15 开放。
