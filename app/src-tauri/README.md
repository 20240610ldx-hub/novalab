# NovaLab Tauri 壳（P1.7 devUrl 模式 · P4.1 release 已本地验证）

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

## P4.1 本地 release 构建验证（2026-10-07，已跑通）

```powershell
pnpm --filter @novalab/app build                # tsc -b 通过，vite → app/dist（~1s）
cd app/src-tauri && cargo build --release       # 2m39s（依赖多为缓存）
pnpm --filter @novalab/app exec tauri build --bundles nsis --config '{\"bundle\":{\"active\":true}}'
# ↑ PS 5.1 下 JSON 参数引号需 \" 转义（1m47s）。tauri.conf.json 的 bundle.active=false
#   保持不动，CLI JSON 合并覆盖——与 .github/workflows/release.yml 同法。
```

- **产物**：`target/release/bundle/nsis/NovaLab_0.0.1_x64-setup.exe`（2.36 MiB；
  novalab.exe 8.7 MB，前端 dist 编译期嵌入，LZMA solid 压缩）。远低于典型
  15–60 MB 预期，因为**不含 bridge/kernel sidecar**——见下方 P4 缺口。
- **核验**：`python scripts/verify_bundle.py`（无需 7z：解析 bundler 生成的
  `target/release/nsis/x64/installer.nsi` 的 define/File 清单 + 扫描 exe 内明文
  asset key）。结论：payload 仅主程序；`INSTALLWEBVIEW2MODE=downloadBootstrapper`
  （安装时联网下载 WebView2）；未签名（预期，本机无证书 secrets）；
  novakernel/bridge/node/python 确认不在包内。
- **警告（未修，Owner 决策）**：identifier `dev.novalab.app` 以 `.app` 结尾，
  bundler 提示与 macOS .app 扩展名冲突——Windows NSIS 无碍；若将来出 mac 包，
  建议改（如 `dev.novalab.desktop`）。改动会变更应用数据目录与 updater 身份，
  故 P4.1 不擅动。

## P4 待办（打包期）

- [ ] **sidecar（P4 已知缺口）**：安装包只含前端+壳。安装版在无 repo 的机器上
      `repo_root()`（编译期 `CARGO_MANIFEST_DIR`）探测失败 → bridge 不 spawn
      （仅警告），kernel 更无从谈起；用户须自行 `pnpm --filter @novalab/bridge
      start` + `uv run`（py/）。方案选项（供 Owner 决策）：
      - **bridge（node，tsx ESM，deps: ws/zod/chokidar/MCP SDK）**：
        - **A. Node SEA 单文件**：esbuild/tsup bundle 成单 CJS →
          `node --experimental-sea-config` 注入 blob → 产出
          `bridge-x86_64-pc-windows-msvc.exe` 进 `bundle.externalBin`。
          单文件干净；但 SEA 尚 experimental，体积 ~40–80 MB，CI 需 node 构建链。
        - **B. sidecar node.exe + bundled JS**（推荐起步）：`externalBin` 带
          官方 node.exe，bridge 打成单文件 JS 作 `bundle.resources`，壳启动
          `node bridge.js`。无 experimental 特性、维护最省；两文件布局。
        - **C. bun compile**：`bun build --compile` 出单 exe（~55–95 MB），
          引入 bun 工具链作构建依赖。
      - **py 内核（novakernel，uv 虚拟项目，python≥3.11）**：
        - **A. python-build-standalone 便携 CPython**（astral 发行）作
          resource/externalBin，预装 novakernel 依赖（websockets 必带；
          pandas/matplotlib 视 demo 取舍）——完全离线；体积 +30–250 MB。
        - **B. uv sidecar**（推荐起步）：随包带 `uv.exe`（~15 MB），首启
          `uv python install 3.12` + `uv sync` 到 app-data——安装器小，
          首启需联网。
        - **C. BYO**：探测系统 python≥3.11 / uv，缺失则引导安装
          （现状行为的正式化）；作为 A/B 的 fallback 保留。
      - **壳侧配套**（任一组合相同）：引入 `tauri_plugin_shell`，capabilities
        加 `shell:allow-execute`（限定 sidecar）；`lib.rs` spawn 改
        packaged=sidecar / dev=pnpm 双分支；删 `repo_root()` 编译期启发式；
        externalBin 文件须带 target-triple 后缀命名。
- [x] **图标**：`tauri icon` 已生成全套（见 `icons/`），`bundle.icon` 已填；
      icons/README.md 的"空占位"描述已过时（本次已更新）。
- [ ] **签名**：Windows 代码签名证书占位（tauri-action CI；secrets 未配 =
      不签名，安装时 SmartScreen 未知发布者提示）。
- [ ] **bundle**：MSI（release.yml 已列 `nsis,msi`，本地未验证 WiX 路径）、
      版本号策略（tauri.conf.json 0.0.1 与 git tag 无联动）、updater 占位。
- [ ] **WebView2 引导**：当前默认 `downloadBootstrapper`（安装时联网）。
      离线/企业分发可改 `bundle.windows.webviewInstallMode`：
      `embedBootstrapper`（+~2 MB）或 `offlineInstaller`（+~150 MB）。
      P4.1 保持默认未改。

## CI release.yml 备注

本地验证与 release.yml 用同一覆盖法（`--bundles ... --config
'{"bundle":{"active":true}}'`），**P4.1 无需调整 CI**。两点留意：
① windows job 跑 `nsis,msi` 双 target——msi(WiX) 本地未验证，CI 首跑即其
验证；若挂可临时降为 `nsis` 保 tag 发布链路。② tauri-action 以 args 数组
直传 CLI（无 shell 引号层），单引号 JSON 在 GH runner 安全。
`.cargo/config.toml` 的 rust-lld pin 在 CI 同样生效（rustup ≥1.28 自带
rust-lld proxy）。

## 目录

```
src-tauri/
├─ .cargo/config.toml    rust-lld linker pin（免疫 Git coreutils link.exe 劫持）
├─ Cargo.toml            tauri = "2" / tauri-build；lib name = novalab_lib
├─ build.rs              tauri_build::build()
├─ tauri.conf.json       identifier dev.novalab.app · window 1280x800 Dark
│                        · bundle.active=false（dev 期；打包用 CLI --config 覆盖）
├─ capabilities/
│  └─ default.json       仅 core:default 权限（无插件）
├─ icons/                tauri icon 生成全套（P4.1 已就位）
├─ scripts/
│  └─ verify_bundle.py   产物核验：installer.nsi 清单 + exe 内嵌 asset key
└─ src/
   ├─ main.rs            windows_subsystem 包装 → novalab_lib::run()
   └─ lib.rs             run()：setup() spawn bridge · Exit 时 kill
```
