"""P4.1 bundle content verification — no 7z needed.

The NSIS payload is LZMA-solid-compressed, so byte-scanning the setup exe
proves nothing about its contents. The ground truth is the bundler-generated
script `target/release/nsis/<arch>/installer.nsi`: its `!define` block lists
the exact payload (MAINBINARYSRCPATH, WebView2 mode, resources/sidecars).

Checks:
1. installer.nsi defines: payload binary, WebView2 install mode, signing cmd.
2. No `File` commands beyond the main binary + uninstaller ⇒ shell-only bundle
   (known P4 gap: novakernel/bridge are NOT sidecar-packaged).
3. novalab.exe embeds the frontend dist: asset *keys* (paths) are stored
   plaintext in the binary even though asset *values* are compressed.

Run:  python scripts/verify_bundle.py   (from app/src-tauri, after tauri build)
"""
import pathlib
import re
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent / "target" / "release"
NSI = BASE / "nsis" / "x64" / "installer.nsi"
EXE = BASE / "novalab.exe"
DIST = pathlib.Path(__file__).resolve().parent.parent.parent / "dist"

def fail(msg: str) -> None:
    print(f"  [FAIL] {msg}")
    sys.exit(1)

# ---- 1. installer.nsi defines ------------------------------------------------
if not NSI.is_file():
    fail(f"{NSI} missing — run `tauri build --bundles nsis` first")
nsi = NSI.read_text(encoding="utf-8", errors="replace")
defines = dict(re.findall(r'!define\s+(\w+)\s+"([^"]*)"', nsi))
print(f"== {NSI.name} ==")
for key in ("PRODUCTNAME", "VERSION", "MAINBINARYNAME", "MAINBINARYSRCPATH",
            "INSTALLWEBVIEW2MODE", "UNINSTALLERSIGNCOMMAND", "INSTALLMODE",
            "ESTIMATEDSIZE"):
    print(f"  {key:24} = {defines.get(key, '<absent>')!r}")
if not defines.get("MAINBINARYSRCPATH", "").lower().endswith("novalab.exe"):
    fail("MAINBINARYSRCPATH does not point at novalab.exe")

# ---- 2. payload file list (shell-only expectation) ---------------------------
file_cmds = re.findall(r'^\s*File\s+(?!"/oname=)(.*)$', nsi, re.M)
oname_cmds = re.findall(r'^\s*File\s+"/oname=([^"]+)"', nsi, re.M)
print(f"  File commands (payload): {file_cmds}")
print(f"  File /oname (temp, e.g. webview2): {oname_cmds}")
unexpected = [f for f in file_cmds if "MAINBINARYSRCPATH" not in f]
if unexpected:
    fail(f"unexpected payload entries (resources/sidecars?): {unexpected}")
for banned in ("novakernel", "bridge", "node.exe", "python"):
    if re.search(rf'^\s*File\s+.*{banned}', nsi, re.M | re.I):
        fail(f"payload unexpectedly contains {banned!r}")
print("  => payload is main binary only: novakernel/bridge NOT bundled (P4 gap, expected)")

# ---- 3. frontend dist embedded in exe ----------------------------------------
if not EXE.is_file():
    fail(f"{EXE} missing")
exe_bytes = EXE.read_bytes()
assets = sorted((DIST / "assets").glob("*")) if DIST.is_dir() else []
if not assets:
    fail(f"no assets under {DIST} — build the frontend first")
checked = 0
print(f"== {EXE.name} ({len(exe_bytes):,} bytes) — embedded asset keys ==")
for a in assets:
    if a.suffix in (".woff", ".woff2"):
        continue  # spot-check below; scanning all fonts is noise
    if a.name.encode() not in exe_bytes:
        fail(f"asset key {a.name!r} not found in exe — stale embed?")
    checked += 1
font = next((a.name for a in assets if a.suffix == ".woff2"), None)
if font and font.encode() in exe_bytes:
    checked += 1
print(f"  => {checked} asset keys found plaintext in exe (dist is embedded)")
print("ALL CHECKS PASSED")
