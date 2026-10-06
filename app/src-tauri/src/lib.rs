//! NovaLab Tauri shell (P1.7 — devUrl mode).
//!
//! Responsibilities (docs/spec.md §1/§2):
//! - Host the WebView pointed at the vite dev server (dev) or `../dist` (build).
//! - Spawn the Bridge (node) child process unless the developer already runs it
//!   themselves (`NOVALAB_BRIDGE=external`).
//! - Kill the Bridge on app exit.
//!
//! P4 (packaging) TODO: replace the `cmd /C pnpm ...` dev spawn with a proper
//! Tauri **sidecar** binary (`bundle.externalBin` + `tauri_plugin_shell`), embed
//! real icons, and drop the compile-time repo-root heuristic in `repo_root()`.

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

use tauri::Manager;

/// Managed app state holding the bridge child process handle (if we spawned it).
/// `None` when `NOVALAB_BRIDGE=external` or when the spawn failed (dev workflow
/// tolerates a manually-started bridge — see spec §2).
struct BridgeChild(Mutex<Option<Child>>);

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
///
/// Dev-mode spawn on Windows: `cmd /C pnpm --filter @novalab/bridge start`
/// from the repo root, detached (`DETACHED_PROCESS`) so it survives console
/// quirks and does not fight the Tauri process for stdio. Spawn failure is a
/// warning, never fatal: the dev may start the bridge in their own terminal.
fn spawn_bridge(app: &tauri::AppHandle) {
    if std::env::var("NOVALAB_BRIDGE").as_deref() == Ok("external") {
        eprintln!("[novalab] NOVALAB_BRIDGE=external — not spawning bridge; assuming it is already running on ws://127.0.0.1:7788");
        return;
    }

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
        // bridge is fine. P4 sidecar will make this strict.
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
        // We spawned `cmd /C pnpm ...`, so the real workload (node/tsx) is a
        // grandchild. `child.kill()` would only kill cmd.exe and orphan node;
        // taskkill /T /F terminates the whole tree. P4: a sidecar binary is a
        // direct child and `tauri_plugin_shell`'s Command::kill handles this.
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
/// compile time — fine for dev; P4 packaging must switch to a resource/sidecar
/// layout) and walks up. Also handles `tauri dev`'s runtime cwd defensively.
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
