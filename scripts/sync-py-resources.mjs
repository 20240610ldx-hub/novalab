#!/usr/bin/env node
/**
 * P4.1b — kernel 资源同步（生成物脚本；产物不入库，见 app/src-tauri/.gitignore）。
 *
 * 做两件事：
 *  1. 复制 py/ 内核源到 app/src-tauri/py-resources/py/：
 *     novakernel/、tests/、pyproject.toml、uv.lock。
 *     **排除**体积垃圾：.venv、__pycache__、*.pyc、.pytest_cache、.ruff_cache、
 *     *.egg-info。（tests 保留——fixture 小；.venv 一定排除，装机后由 uv sync 首启自建。）
 *  2. 本机 uv（`where uv` 首条 realpath）→ app/src-tauri/binaries/uv-<triple>[.exe]
 *     （tauri.conf.json bundle.externalBin 以 "binaries/uv" 引用它。）
 *
 * 用法：node scripts/sync-py-resources.mjs   （在仓库根）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const srcTauri = path.join(repoRoot, 'app', 'src-tauri');
const pySrc = path.join(repoRoot, 'py');
const pyDest = path.join(srcTauri, 'py-resources', 'py');

function targetTriple() {
  const { platform, arch } = process;
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  throw new Error(`unsupported platform/arch: ${platform}/${arch}`);
}
const triple = targetTriple();
const exeExt = process.platform === 'win32' ? '.exe' : '';

/* ---------- 复制过滤 ---------- */
const EXCLUDE_DIRS = new Set([
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  '.mypy_cache',
  'node_modules',
  '.git',
]);
function isExcluded(p) {
  const base = path.basename(p);
  if (EXCLUDE_DIRS.has(base)) return true;
  if (base.endsWith('.egg-info')) return true;
  if (/\.(pyc|pyo|pyd)$/.test(base)) return true;
  return false;
}

function humanMB(p) {
  return `${(fs.statSync(p).size / 1024 / 1024).toFixed(1)} MB`;
}
function dirMB(p) {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const fp = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(fp);
      else total += fs.statSync(fp).size;
    }
  }
  return `${(total / 1024 / 1024).toFixed(1)} MB`;
}

/* ---------- 1. py/ → py-resources/py/ ---------- */
function syncPy() {
  if (!fs.existsSync(pySrc)) throw new Error(`py/ 源不存在：${pySrc}`);
  fs.rmSync(pyDest, { recursive: true, force: true });
  fs.mkdirSync(pyDest, { recursive: true });
  let copied = 0;
  // fs.cpSync 的 filter 返回 false 即剪枝（目录整体跳过）。
  fs.cpSync(pySrc, pyDest, {
    recursive: true,
    force: true,
    filter: (src) => {
      if (src === pySrc) return true;
      if (isExcluded(src)) return false;
      if (fs.statSync(src).isFile()) copied += 1;
      return true;
    },
  });
  console.log(`[sync-py] py/ → ${pyDest} (${copied} files, ${dirMB(pyDest)})`);
}

/* ---------- 2. uv sidecar ---------- */
function locateOnPath(name) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(finder, [name], { encoding: 'utf8', windowsHide: true });
    const first = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    if (first) return fs.realpathSync(first);
  } catch {
    /* not found */
  }
  return undefined;
}

function copyUvSidecar() {
  const envOverride = process.env.NOVALAB_UV_SRC;
  const uvPath = envOverride ? fs.realpathSync(envOverride) : locateOnPath('uv');
  if (!uvPath) throw new Error('找不到本机 uv（where uv）——装 uv 或设 NOVALAB_UV_SRC');
  let version = 'unknown';
  try {
    version = execFileSync(uvPath, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    /* 版本探测失败不致命 */
  }
  const dest = path.join(srcTauri, 'binaries', `uv-${triple}${exeExt}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(uvPath, dest);
  console.log(`[sync-py] uv ${version}: ${uvPath} → ${dest} (${humanMB(dest)})`);
}

syncPy();
copyUvSidecar();
console.log(`[sync-py] done (triple ${triple})`);
