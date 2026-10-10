# NovaLab Tauri 壳（P1.7 devUrl 模式 · P4.1 release 已本地验证）

Tauri v2 桌面壳，手工脚手架（未用 create-tauri-app）。dev 期 WebView 直连
vite dev server（`devUrl = http://localhost:5199`）；`frontendDist = ../dist`
仅在 build 时使用。**beforeDevCommand/beforeBuildCommand 均为 null——vite 必须
手动起**（vite strictPort 5199，见 `app/vite.config.ts`）。

## dev 工作流（三终端）

| 终端 | 命令 | 说明 |
|---|---|---|
| 1 | `pnpm --filter @novalab/app dev` | vite dev server @ http://localhost:5199（strictPort，必须先起） |
| 2 | `pnpm --filter @novalab/bridge start` | bridge loopback（默认 7788，冲突自动 +1；前端经 `/bridge-info` 发现，见 spec §2） |
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

## P4.1b sidecar 打包（bridge + kernel，已实现）

P4.1 的"仅壳"缺口按 Owner 裁决的 **方案 B（sidecar node.exe + bundled JS）+
kernel 方案 B（uv sidecar，首启自装）** 落地。identifier 保持 `dev.novalab.app`
不变（Owner 裁决）。

**构建顺序**（tauri-build 在 `cargo build` 时即拷贝 externalBin/resources 到
target/，故脚本必须先于 cargo/tauri build 跑，产物齐备才能编译）：

```powershell
pnpm --filter @novalab/app build        # 前端 dist（tauri.conf frontendDist）
node scripts/build-bridge.mjs           # bridge → bridge-dist/bridge.mjs + binaries/node-<triple>.exe
node scripts/sync-py-resources.mjs      # py/ → py-resources/py/ + binaries/uv-<triple>.exe
uv sync --directory py --all-extras    # 本地 smoke 复用已就绪的 .venv
node scripts/packaged-startup-smoke.mjs # sidecar → discovery/auth → notebook.open/cell.run
cd app/src-tauri
cargo build --release                   # tauri-build 拷 sidecar/resources 到 target/release/
pnpm --filter @novalab/app exec tauri build --bundles nsis --config '{\"bundle\":{\"active\":true}}'
python scripts/verify_bundle.py         # 断言反转为「payload 必含 sidecar/resources」
```

**产物（均 gitignore，见 `.gitignore`）**：
- `bridge-dist/bridge.mjs`：esbuild 把 `bridge/src/main.ts` 打成单文件 ESM
  （platform=node，ws/zod/chokidar/MCP SDK 全内联，banner 兜底 createRequire）。
  esbuild 来自 pnpm store（vite 的传递依赖，lockfile 已有）。~1.6 MB。
- `binaries/node-x86_64-pc-windows-msvc.exe`：本机 node（`where node` realpath，
  防 symlink；要求 ≥22）。~88 MB。
- `binaries/uv-x86_64-pc-windows-msvc.exe`：本机 uv（`where uv` realpath）。~63 MB。
- `py-resources/py/`：`py/` 内核源（novakernel/ + tests/ + pyproject.toml + uv.lock；
  **排除** .venv/__pycache__/*.pyc）。~0.7 MB。装机后 .venv 由 uv 首启自建。

**tauri.conf.json（最终形态）**：

```jsonc
"bundle": {
  "active": false,               // dev 期；打包用 CLI --config 覆盖开启
  "targets": "all",
  "icon": [ ... ],
  "externalBin": ["binaries/node", "binaries/uv"],   // tauri 追加 -<triple>.exe 查找
  "resources": ["bridge-dist/", "py-resources/"]     // 数组形态（schema BundleResources 允许 list 或 map）
}
```

**lib.rs 双分支**（`spawn_bridge`）：
- `tauri::is_dev()`（未启用 custom-protocol）→ dev 分支：现状 `cmd /C pnpm …`。
- packaged（`tauri build` 产物）→ `resolve_packaged_layout()` 经 `current_exe` 旁 +
  `resource_dir()`（Windows 上二者同目录）按序探测 sidecar（`binaries/` 子目录或扁平）
  与资源，spawn `node bridge.mjs`，注入：
  - `NOVALAB_PACKAGED=1`
  - `NOVALAB_PY_SOURCE_DIR=<resource>/py-resources/py`（只读资源）
  - `NOVALAB_PY_DIR=<appData>/py-resources/py`（可写运行时副本，uv sync 目标）
  - `NOVALAB_UV_BIN=<resource>/binaries/uv-<triple>.exe`
  布局缺失 → 警告并回落 dev spawn。退出时 `taskkill /T /F` 杀 node→uv→python 整棵树。

**bridge supervisor 适配**（`supervisor.ts`）：`StdioKernelTransport` 的 uv 命令与
pyDir 经 `resolveKernelSpawnSpec()` 读 `NOVALAB_UV_BIN`/`NOVALAB_PY_DIR`（缺省回落
现状 'uv' + repo 推导）。**首启自装**：packaged 下 spawn kernel 前若 `<pyDir>/.venv`
不存在 → `ensureKernelVenv()` 跑 `uv python install` + `uv sync --directory <pyDir>
--all-extras`（超时 300s）；任一失败/超时 → stderr warn 并**回落 BYO**（PATH uv/python）。
bootstrap 在途时 `send()` 缓冲、spawn 后 flush（首启 load_file 不丢）。单测覆盖 env
覆盖 + 回落 + 缓冲（注入假 runner/spawn，不真拉进程）。

## P4.1 历史本地 release 构建记录（2026-10-07）

```powershell
pnpm --filter @novalab/app build                # tsc -b 通过，vite → app/dist（~1s）
cd app/src-tauri && cargo build --release       # 2m39s（依赖多为缓存）
pnpm --filter @novalab/app exec tauri build --bundles nsis --config '{\"bundle\":{\"active\":true}}'
# ↑ PS 5.1 下 JSON 参数引号需 \" 转义（1m47s）。tauri.conf.json 的 bundle.active=false
#   保持不动，CLI JSON 合并覆盖——与 .github/workflows/release.yml 同法。
```

- **记录性质**：这次运行早于 sidecar 生成步骤，只验证了 Tauri 壳本身；当前发布流水线
  会先生成并验收 node/uv/bridge/kernel sidecar，再执行打包。
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

- [x] **sidecar（P4.1b 已落地）**：bridge 走方案 B（sidecar node.exe +
      esbuild 单文件 bridge.mjs 作 resource），kernel 走方案 B（uv sidecar +
      首启 `uv python install`/`uv sync` 自装，失败回落 BYO=C 现状路径）。
      未引入 tauri_plugin_shell——lib.rs 直接 `std::process::Command` spawn
      sidecar（Rust 侧无需 shell 权限，capabilities 不动）。细节见上方 P4.1b 节。
      安装目录不可写时，Bridge 会把只读 py-resources 复制到 appData 后再执行首启 `uv sync`。
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

**当前 release.yml 已包含 sidecar 生成与真实启动验收步骤**：tauri.conf.json 已声明
`externalBin`/`resources`，tauri-build 在 cargo 编译期就要求这些文件存在——
缺了直接构建失败（windows 与 linux job 都是）。在 `pnpm --filter @novalab/app
build` 之后、tauri-action 之前插入：

```yaml
      # ---- P4.1b sidecar 生成（externalBin/resources 是 cargo 编译期硬依赖）----
      - name: install uv (sidecar 源，两平台)
        uses: astral-sh/setup-uv@v5
      - name: build bridge bundle + node/uv sidecars + py resources
        run: |
          node scripts/build-bridge.mjs
          node scripts/sync-py-resources.mjs
```

（脚本自动按 runner 平台产出对应 triple 命名；node 取 setup-node 的
`where/which node`，uv 取 setup-uv 装入 PATH 的 uv。windows job 出
`*-x86_64-pc-windows-msvc.exe`，linux job 出 `*-x86_64-unknown-linux-gnu`。）

本地验证与 release.yml 用同一覆盖法（`--bundles ... --config
'{"bundle":{"active":true}}'`）。两点留意：
① windows job 跑 `nsis,msi` 双 target——msi(WiX) 本地未验证，CI 首跑即其
验证；若挂可临时降为 `nsis` 保 tag 发布链路。② tauri-action 以 args 数组
直传 CLI（无 shell 引号层），单引号 JSON 在 GH runner 安全。
`.cargo/config.toml` 的 rust-lld pin 在 CI 同样生效（rustup ≥1.28 自带
rust-lld proxy）。③ sidecar 使产物体积大增（node ~88 MB + uv ~63 MB，NSIS
LZMA 压缩后 setup 预计 60–140 MB），GitHub Release 附件与 actions 缓存时长
会相应上涨。

发布前的 `scripts/packaged-startup-smoke.mjs` 会直接启动本平台 sidecar，验证
`/bridge-info` 发现、WS token 认证、`notebook.open` 与一次真实 `cell.run`；Windows
与 Linux job 共用这条验收，不把“能编译”当作“能启动”。

## 目录

```
src-tauri/
├─ .cargo/config.toml    rust-lld linker pin（免疫 Git coreutils link.exe 劫持）
├─ Cargo.toml            tauri = "2" / tauri-build；lib name = novalab_lib
├─ build.rs              tauri_build::build()（拷 externalBin/resources 到 target/）
├─ tauri.conf.json       identifier dev.novalab.app · window 1280x800 Dark
│                        · bundle.active=false（dev 期；打包用 CLI --config 覆盖）
│                        · externalBin [binaries/node, binaries/uv]
│                        · resources [bridge-dist/, py-resources/]
├─ binaries/             （生成物，gitignore）node/uv sidecar，-<triple>.exe 命名
├─ bridge-dist/          （生成物，gitignore）esbuild 单文件 bridge.mjs
├─ py-resources/         （生成物，gitignore）py/ 内核源（无 .venv）
├─ capabilities/
│  └─ default.json       仅 core:default 权限（无插件；sidecar 由 Rust 侧 spawn，不需 shell 权限）
├─ icons/                tauri icon 生成全套（P4.1 已就位）
├─ scripts/
│  └─ verify_bundle.py   产物核验：installer.nsi 必含 sidecar/resources、禁 .venv/凭据
└─ src/
   ├─ main.rs            windows_subsystem 包装 → novalab_lib::run()
   └─ lib.rs             run()：setup() spawn bridge（dev=pnpm / packaged=sidecar
                         node+bridge.mjs+NOVALAB_* env 注入）· Exit 时 taskkill /T
```
