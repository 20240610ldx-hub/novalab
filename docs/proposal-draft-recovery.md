# 提案：跨应用 dirty 草稿有界恢复（A15 子包，第 7 轮）

> 状态：**已实现并验收（2026-10-17，第 7 轮，Windows-only 浏览器验收）**。Owner 裁决存储位置与保留期（“Next to the notebook, 7 days (Recommended)”）；§4 默认值待确认。证据见 checklist 第七轮与 `manifest-drafts-round7.json`。基线 `56fd8b1`（`claude/novalab-reliability-stack`：第 6 轮 + D4、F1、LLM 重试），分支 `claude/novalab-draft-recovery`。
> 范围外：断线期间（bridge 不在）的草稿落盘、Tauri 侧独立写盘通道、REPL/变量/输出持久化、自动合并。

## 1. 问题

草稿（`drafts`）只在 WebView 内存。正常编辑 300 ms 内自动保存，丢失窗口很小；真正会长时间停留的未保存草稿出现在：

| 场景 | 为何不落盘 | bridge 在吗 |
|---|---|---|
| 内核 dead/ended 后继续编辑（第 5 轮） | `cell.save` 需要 `set_cells`/`save_file`，内核不在 | 在 |
| 外部冲突暂停保存（第 4 轮） | 自动保存暂停，等用户处理 | 在 |
| 保存持续失败（权限、磁盘） | 写盘报错，草稿保留 | 在 |
| bridge 断线（第 6 轮） | 无 RPC 通道 | **不在** |

此时 WebView/应用退出，草稿即丢。

## 2. 设计

**写入方 = bridge（Node），不是内核。**前三种场景里内核可能已死，只有 bridge 一定在；第四种两者都不在，本包不覆盖（见 §5）。写法移植第 4 轮 `serialize.write_file` 的模式：同目录排它创建临时文件（`wx`，0600）→ 写入 → `fsync` → `rename` 为最终名，失败删临时文件；POSIX 上再尽力 `fsync` 目录。

**位置与命名**：`<notebook 所在目录>/.novalab/drafts/<basename>.<毫秒时间戳>-<8 位随机>.draft.json`。按文件名中的时间戳判龄与排序，不信 mtime。

**内容**（只此几项，无输出/变量/REPL/凭据）：

```json
{ "version": 1, "notebook": "a.py", "baselineSha256": "<bridge 记录的基线指纹或 null>",
  "savedAt": "<ISO 时间>", "cells": [{ "id": "…", "code": "…" }], "dirtyCellIds": ["…"] }
```

`baselineSha256` 取 bridge 对该 context 的记录（D4，`load_file`/成功保存后更新，内核死后仍在），不接受前端传入。`cells` 为全部持久 cell（已叠加草稿；前端过滤 `kind:'repl'`，bridge 只保留字符串 `id`/`code`）。

**有界**：每个 notebook 最多 5 份（写新份后删最旧）；超过 7 天的在写入、打开时删除；单份序列化 > 2 MiB 拒写（`-32602`，前端在 tab 上提示“草稿过大，未写入恢复日志”，草稿仍留内存）。

**何时写**：前端在编辑后 1.5 s 去抖；触发时若该 tab 已无草稿（多数情况：300 ms 自动保存已成功）则不写。断线/bridge-lost tab 不写。经 bridge 同 notebook 写队列串行，保证与保存/清理的先后。

**何时删**：本会话写过日志（或已恢复草稿）的 tab 在保存 ACK 后无剩余草稿 → `draft.clear`；用户“丢弃”→ `draft.clear`；“保存为本地副本”成功后清除；7 天/5 份上限。

**重开**：只在新建 context 的 `notebook.open` 结果中附 `draftRecovery`（已打开的 tab 再 open 不附）。取最新一份可解析的日志：
- 所有 `dirtyCellIds` 的代码都与磁盘同 id cell 一致 → 无可恢复内容，静默删除，不提示；
- 日志指纹 = 本次 `load_file` 指纹 → `baselineMatches: true`，提示“恢复草稿 / 丢弃”；
- 不一致或日志无指纹 → `baselineMatches: false`，提示“保存为本地副本 / 丢弃”，**不提供应用到编辑器**。

**恢复（指纹一致）**：前端把 `dirtyCellIds` 中仍存在的 cell 代码放回草稿、tab 标 dirty，**不发 `cell.save`、不写磁盘**；之后按常规（下一次编辑/关闭时 flush）保存。日志保留直到保存成功。等待用户决定期间若该 tab 发生成功保存，提示降级为“保存为本地副本”。

**保存为本地副本（指纹不一致）**：`draft.preserve {notebookId, draftId}` → bridge 读日志 → 内核 `backup_file`（第 4 轮同目录 `.novalab-recovery-*.py`，排它创建）→ 清日志 → 前端以现有 `recoveryPath` 行显示副本路径。磁盘 notebook 不变。

## 3. 协议增量

| 方法 | 方向 | 说明 |
|---|---|---|
| `draft.write {notebookId, cells, dirtyCellIds}` | req | → `{draftId, bytes}`；超限 `-32602` |
| `draft.clear {notebookId}` | req | → `{removed}` |
| `draft.preserve {notebookId, draftId}` | req | → `{recoveryPath}`；需内核可响应 `backup_file` |
| `notebook.open` 结果 | res | 新增可选 `draftRecovery {draftId, savedAt, baselineMatches, dirtyCellIds, cells}` |

内核协议不变。

## 4. 默认值（待 Owner 确认）

去抖 1.5 s；单份上限 2 MiB；恢复后不自动写盘；指纹未知按“不一致”处理；仅提供最新一份（更旧的作为损坏时的后备）。

## 5. 不覆盖

bridge 断线期间编辑的草稿（需 Tauri 侧写盘通道，另包）；WebView 未崩但 bridge 与应用同时被杀的 1.5 s 去抖窗口；跨机器同步；Linux/macOS 以 CI 为准。
