//! NovaLab Tauri shell (P1.7 devUrl mode + P4.1b sidecar packaging).
//!
//! Responsibilities (docs/spec.md §1/§2):
//! - Host the WebView pointed at the vite dev server (dev) or `../dist` (build).
//! - Spawn the Bridge (node) child process unless the developer already runs it
//!   themselves (`NOVALAB_BRIDGE=external`).
//! - Kill the bridge process tree on app exit.
//!
//! P4.1b — bridge/kernel sidecar 双分支：
//! - **dev**（`tauri::is_dev()`，即未启用 custom-protocol：`tauri dev` / 裸 cargo build）：
//!   维持现状 `cmd /C pnpm --filter @novalab/bridge start`，repo root 向上探测。
//! - **packaged**（`tauri build` 产物）：spawn sidecar node.exe 跑
//!   `<resource>/bridge-dist/bridge.mjs`（esbuild 单文件 bundle，scripts/build-bridge.mjs
//!   生成），并注入：
//!   * `NOVALAB_PACKAGED=1`        —— bridge supervisor 走 packaged 分支（首启自装 venv）
//!   * `NOVALAB_PY_DIR=<resource>/py-resources/py` —— novakernel 项目目录（uv sync 目标）
//!   * `NOVALAB_UV_BIN=<resource>/binaries/uv-<triple>.exe` —— sidecar uv
//!   payload 落盘位置以 tauri NSIS 实际布局为准（P4.1b 实测 installer.nsi）：
//!   sidecar 扁平落 $INSTDIR 且剥掉 triple 后缀（node.exe / uv.exe，与主 exe 同目录，
//!   Windows resource_dir == exe dir）；resources 保持相对结构（bridge-dist/、
//!   py-resources/）。resolve 仍按序探测多种形态以防 bundler 行为变化。
//!
//! 生成物（bridge-dist/、py-resources/、binaries/*.exe）不入库，由
//! scripts/build-bridge.mjs + scripts/sync-py-resources.mjs 在打包前产出。

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::Manager;

/// Managed app state holding the bridge child process handle (if we spawned it).
/// `None` when `NOVALAB_BRIDGE=external` or when the spawn failed (dev workflow
/// tolerates a manually-started bridge — see spec §2).
struct BridgeChild(Mutex<Option<Child>>);

/// P4.1b 打包目标是 Windows x64 NSIS；sidecar 文件名嵌 target triple
/// （tauri-utils `external_binaries()` 命名约定，triple 由 tauri-build 经
/// `cargo:rustc-env=TAURI_ENV_TARGET_TRIPLE` 提供）。非 Windows x64 的 packaged
/// 分支直接判 None 回落 dev spawn（不在本期范围）。
const SIDCAR_TRIPLE: &str = env!("TAURI_ENV_TARGET_TRIPLE");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BridgeChild(Mutex::new(None)))
        .setup(|app| {
            spawn_bridge(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building NovaLab")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                kill_bridge(app_handle);
            }
        });
}

/// Spawn the bridge unless `NOVALAB_BRIDGE=external`.
/// Packaged 构建走 sidecar 分支；dev（或 packaged payload 缺失时回落）走 pnpm 分支。
fn spawn_bridge(app: &tauri::AppHandle) {
    if std::env::var("NOVALAB_BRIDGE").as_deref() == Ok("external") {
        eprintln!("[novalab] NOVALAB_BRIDGE=external — not spawning bridge; assuming it is already running on ws://127.0.0.1:7788");
        return;
    }

    if !tauri::is_dev() {
        match resolve_packaged_layout(app) {
            Some(layout) => return spawn_packaged_bridge(app, layout),
            None => eprintln!(
                "[novalab] WARNING: packaged build but sidecar/resources not found — \
                 falling back to dev pnpm spawn (bridge likely unavailable)"
            ),
        }
    }

    spawn_dev_bridge(app);
}

/* ------------------------------------------------------------------ */
/* packaged 分支（P4.1b）                                              */
/* ------------------------------------------------------------------ */

/// 打包产物在盘上的实际布局（全部解析成功才有值）。
struct PackagedLayout {
    node: PathBuf,
    bridge_script: PathBuf,
    uv: PathBuf,
    py_dir: PathBuf,
}

/// 在候选目录（exe dir、resource_dir）下按序探测 sidecar / 资源。
/// sidecar 命名 `<name>-<triple>.exe`；NSIS 布局可能保留 `binaries/` 前缀也可能扁平。
fn find_first(dirs: &[&Path], candidates: impl Fn(&Path) -> Vec<PathBuf>) -> Option<PathBuf> {
    for dir in dirs {
        for cand in candidates(dir) {
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

fn sidecar_candidates(dir: &Path, name: &str) -> Vec<PathBuf> {
    let exe_ext = if cfg!(windows) { ".exe" } else { "" };
    let tripled = format!("{name}-{SIDCAR_TRIPLE}{exe_ext}");
    vec![
        // NSIS 实测布局（P4.1b）：sidecar 扁平落 $INSTDIR 且剥掉 triple 后缀
        // （installer.nsi: File "/oname=node.exe" ...node-x86_64-pc-windows-msvc.exe）。
        dir.join(format!("{name}{exe_ext}")),
        dir.join("binaries").join(&tripled),
        dir.join(&tripled),
    ]
}

fn resolve_packaged_layout(app: &tauri::AppHandle) -> Option<PackagedLayout> {
    // 非 Windows x64 的 sidecar 布局不在 P4.1b 范围。
    if !cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        return None;
    }
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| exe_dir.clone());
    let dirs = [exe_dir.as_path(), resource_dir.as_path()];

    let node = find_first(&dirs, |d| sidecar_candidates(d, "node"))?;
    let uv = find_first(&dirs, |d| sidecar_candidates(d, "uv"))?;
    let bridge_script = find_first(&dirs, |d| {
        vec![d.join("bridge-dist").join("bridge.mjs")]
    })?;
    let py_dir = find_first(&dirs, |d| {
        let p = d.join("py-resources").join("py");
        if p.is_dir() {
            vec![p.join("pyproject.toml")]
        } else {
            vec![]
        }
    })?
    .parent()?
    .to_path_buf();

    eprintln!(
        "[novalab] packaged layout: node={} bridge={} uv={} py={}",
        node.display(),
        bridge_script.display(),
        uv.display(),
        py_dir.display()
    );
    Some(PackagedLayout {
        node,
        bridge_script,
        uv,
        py_dir,
    })
}

/// Spawn sidecar node.exe + bridge.mjs，注入 packaged 环境变量。
/// node 是直接子进程；退出时 kill_bridge 以 taskkill /T 杀整棵树
/// （node → uv → python 孙进程一并清理）。
fn spawn_packaged_bridge(app: &tauri::AppHandle, layout: PackagedLayout) {
    let install_dir = layout.node.parent().map(Path::to_path_buf);
    let mut cmd = Command::new(&layout.node);
    cmd.arg(&layout.bridge_script)
        .env("NOVALAB_PACKAGED", "1")
        .env("NOVALAB_PY_DIR", &layout.py_dir)
        .env("NOVALAB_UV_BIN", &layout.uv);
    // 凭据/全局数据落 Tauri appData（packaged 下 $INSTDIR 上级不可靠）
    if let Ok(data_dir) = app.path().app_data_dir() {
        cmd.env("NOVALAB_DATA_DIR", data_dir);
    }
    // GUI 应用无控制台：null stdio + CREATE_NO_WINDOW，防 node 弹出黑窗。
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(dir) = install_dir {
        cmd.current_dir(dir);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // https://learn.microsoft.com/windows/win32/procthread/process-creation-flags
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match cmd.spawn() {
        Ok(child) => {
            eprintln!(
                "[novalab] bridge sidecar spawned (pid {}) — ws://127.0.0.1:7788",
                child.id()
            );
            let state = app.state::<BridgeChild>();
            *state.0.lock().expect("bridge state poisoned") = Some(child);
        }
        Err(e) => eprintln!("[novalab] ERROR: failed to spawn bridge sidecar: {e}"),
    }
}

/* ------------------------------------------------------------------ */
/* dev 分支（现状保留）                                                 */
/* ------------------------------------------------------------------ */

/// Dev-mode spawn on Windows: `cmd /C pnpm --filter @novalab/bridge start`
/// from the repo root, detached (`DETACHED_PROCESS`) so it survives console
/// quirks and does not fight the Tauri process for stdio. Spawn failure is a
/// warning, never fatal: the dev may start the bridge in their own terminal.
fn spawn_dev_bridge(app: &tauri::AppHandle) {
    let root = match repo_root() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[novalab] WARNING: {e}; bridge NOT spawned — start it manually: pnpm --filter @novalab/bridge start");
            return;
        }
    };

    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        // https://learn.microsoft.com/windows/win32/procthread/process-creation-flags
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        let mut c = Command::new("cmd");
        c.arg("/C")
            .args(["pnpm", "--filter", "@novalab/bridge", "start"])
            .current_dir(&root)
            .creation_flags(DETACHED_PROCESS);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("pnpm");
        c.args(["--filter", "@novalab/bridge", "start"])
            .current_dir(&root);
        c
    };

    match cmd.spawn() {
        Ok(child) => {
            eprintln!(
                "[novalab] bridge spawned (pid {}) from {} — ws://127.0.0.1:7788",
                child.id(),
                root.display()
            );
            let state = app.state::<BridgeChild>();
            *state.0.lock().expect("bridge state poisoned") = Some(child);
        }
        // Non-fatal by design: the documented dev workflow is three terminals
        // (vite / bridge / tauri dev), so a pre-started or manually-started
        // bridge is fine.
        Err(e) => eprintln!(
            "[novalab] WARNING: failed to spawn bridge ({e}); start it manually: pnpm --filter @novalab/bridge start"
        ),
    }
}

/// Kill the bridge child (whole process tree on Windows) on app exit.
fn kill_bridge(app: &tauri::AppHandle) {
    let state = app.state::<BridgeChild>();
    let mut guard = state.0.lock().expect("bridge state poisoned");
    let Some(mut child) = guard.take() else {
        return; // external bridge or spawn failed — nothing we own
    };

    #[cfg(windows)]
    {
        // dev 分支：我们 spawn 的是 `cmd /C pnpm ...`，真实负载（node/tsx）是孙进程；
        // packaged 分支：node 是直接子进程，但 kernel（uv → python）是它的孙进程。
        // 两种情况都靠 taskkill /T /F 杀整棵树。
        let pid = child.id().to_string();
        let _ = Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
    let _ = child.wait(); // reap
    eprintln!("[novalab] bridge stopped");
}

/// Locate the pnpm workspace root (the dir containing `pnpm-workspace.yaml`).
///
/// Starts from `CARGO_MANIFEST_DIR` (= `<repo>/app/src-tauri`, baked in at
/// compile time — fine for dev; the packaged branch never reaches here) and
/// walks up. Also handles `tauri dev`'s runtime cwd defensively.
fn repo_root() -> Result<PathBuf, String> {
    let start = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut dir = Some(start.as_path());
    while let Some(d) = dir {
        if d.join("pnpm-workspace.yaml").is_file() {
            return Ok(d.to_path_buf());
        }
        dir = d.parent();
    }
    Err(format!(
        "could not locate repo root (no pnpm-workspace.yaml above {})",
        start.display()
    ))
}
