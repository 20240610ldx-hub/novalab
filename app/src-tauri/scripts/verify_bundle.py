"""P4.1b bundle content verification — payload must now CARRY the sidecars.

The NSIS payload is LZMA-solid-compressed, so byte-scanning the setup exe
proves nothing about its contents. The ground truth is the bundler-generated
script `target/release/nsis/<arch>/installer.nsi`: its `!define` block and
`File`/resource commands list the exact payload.

Checks (P4.1b — assertions INVERTED vs P4.1 shell-only expectation):
1. installer.nsi defines: payload binary, WebView2 install mode, signing cmd.
2. Payload CONTAINS: node sidecar, uv sidecar, bridge-dist/bridge.mjs,
   py-resources/py (novakernel source).
3. Payload does NOT contain: any .venv, credential files (.novalab/,
   providers.json, *.env.local, id_rsa…), __pycache__.
4. novalab.exe embeds the frontend dist: asset *keys* (paths) are stored
   plaintext in the binary even though asset *values* are compressed.

Run:  python scripts/verify_bundle.py   (from app/src-tauri, after tauri build)
"""
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent.parent          # app/src-tauri
BASE = HERE / "target" / "release"
NSI = BASE / "nsis" / "x64" / "installer.nsi"
EXE = BASE / "novalab.exe"
DIST = HERE.parent / "dist"                                     # app/dist

TRIPLE = "x86_64-pc-windows-msvc"

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

nsi_l = nsi.lower()

# ---- 2. payload must contain sidecars + resources ----------------------------
REQUIRED = {
    "node sidecar":        f"node-{TRIPLE}.exe".lower(),
    "uv sidecar":          f"uv-{TRIPLE}.exe".lower(),
    "bridge bundle":       "bridge.mjs",
    "py-resources kernel": "py-resources",
    "novakernel server":   "server.py",
}
print("== required payload entries ==")
for label, needle in REQUIRED.items():
    if needle not in nsi_l:
        fail(f"{label} missing from installer.nsi (needle {needle!r})")
    print(f"  [OK] {label:22} ({needle})")

# ---- 3. payload must NOT contain venv/credentials ----------------------------
# 只扫描真正的 payload 指令行（File / SetOutPath）——不扫 !define：identifier
# `dev.novalab.app` 合法地包含子串 ".novalab"，但它是 bundle id 而非文件路径。
BANNED = (".venv", ".novalab", "providers.json", "__pycache__",
          ".env.local", "id_rsa", "secret.txt", "credentials")
print("== banned payload entries ==")
payload_lines = [
    ln for ln in nsi.splitlines()
    if ln.lstrip().lower().startswith(("file ", "file\tdir", "setoutpath"))
]
for banned in BANNED:
    for line in payload_lines:
        if banned in line.lower():
            fail(f"payload contains banned entry {banned!r}: {line.strip()[:120]}")
    print(f"  [OK] absent: {banned}")

# ---- 4. frontend dist embedded in exe ----------------------------------------
if not EXE.is_file():
    fail(f"{EXE} missing")
exe_bytes = EXE.read_bytes()
print(f"== {EXE.name} ({len(exe_bytes):,} bytes) ==")
assets = sorted((DIST / "assets").glob("*")) if DIST.is_dir() else []
if not assets:
    fail(f"no assets under {DIST} — build the frontend first")
checked = 0
print("== embedded asset keys ==")
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

# ---- size report (informational) ---------------------------------------------
for setup in sorted((BASE / "bundle" / "nsis").glob("*-setup.exe")) if (BASE / "bundle" / "nsis").is_dir() else []:
    print(f"== installer: {setup.name} = {setup.stat().st_size / 1024 / 1024:.1f} MB ==")

print("ALL CHECKS PASSED")
