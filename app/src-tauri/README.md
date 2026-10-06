# NovaLab Tauri 壳（P1.7 · devUrl 模式）

Tauri v2 桌面壳，手工脚手架（未用 create-tauri-app）。dev 期 WebView 直连
vite dev server（`devUrl = http://localhost:5199`）；`frontendDist = ../dist`
仅在 build 时使用。**beforeDevCommand/beforeBuildCommand 均为 null——vite 必须
手动起**（vite strictPort 5199，见 `app/vite.config.ts`）。

## dev 工作流（三终端）

| 终端 | 命令 | 说明 |
|---|---|---|
| 1 | `pnpm --filter @novalab/app dev` | vite dev server @ http://localhost:5199（strictPort，必须先起） |
| 2 | `pnpm --filter @novalab/bridge start` | bridge @ ws://127.0.0.1:7788（端口冲突自动 +1，见 spec §2） |
| 3 | `cd app && pnpm exec tauri dev` | Tauri 窗口（编译 Rust，首跑较慢） |

> 顺序建议 1 → 2 → 3：窗口打开时若 devUrl 未就绪会白屏/报错，刷新即可。
> 终端 3 也可以直接 `cargo run`（在 `app/src-tauri/` 下），效果等同。

## NOVALAB_BRIDGE 语义

`src/lib.rs` 的 `setup()` 钩子会尝试自动拉起 bridge：

- **未设置（默认）**：Tauri spawn `cmd /C pnpm --filter @novalab/bridge start`
  （Windows，DETACHED_PROCESS；repo root 经 `pnpm-workspace.yaml` 向上探测）。
  此时**终端 2 可省**。spawn 失败只打 eprintln 警告，不致命——dev 工作流允许
  bridge 手动先起（端口自愈机制下重复拉起会各自 +1 端口，注意别起两份）。
  应用退出时壳会 `taskkill /T /F` 整棵进程树（cmd → node）。
- **`NOVALAB_BRIDGE=external`**：完全不 spawn，假定 bridge 已由终端 2（或
  其他进程管理器）运行。适合：调试 bridge（要看它的 stdout）、用 `pnpm dev`
  (tsx watch) 热重载 bridge、或 bridge 由外部 supervisor 托管。

```powershell
$env:NOVALAB_BRIDGE = "external"; pnpm exec tauri dev
```

## P4 待办（打包期）

- [ ] **sidecar**：`cmd /C pnpm ...` dev 拉起改为 Tauri sidecar
      （`bundle.externalBin` + `tauri_plugin_shell`），bridge 打包为独立可执行；
      `repo_root()` 的编译期路径启发式一并删除。
- [ ] **图标**：`bundle.icon = []` 目前为空（见 `icons/README.md`）；用
      `pnpm exec tauri icon 源png` 生成后填入，`bundle.active` 置 true。
- [ ] **签名**：Windows 代码签名证书占位（plan P4.1，tauri-action CI）。
- [ ] **bundle**：NSIS/MSI targets、版本号策略、 updater 占位。

## 目录

```
src-tauri/
├─ Cargo.toml            tauri = "2" / tauri-build；lib name = novalab_lib
├─ build.rs              tauri_build::build()
├─ tauri.conf.json       identifier dev.novalab.app · window 1280x800 Dark
├─ capabilities/
│  └─ default.json       仅 core:default 权限（无插件）
├─ icons/                占位（P4 生成）
└─ src/
   ├─ main.rs            windows_subsystem 包装 → novalab_lib::run()
   └─ lib.rs             run()：setup() spawn bridge · Exit 时 kill
```
