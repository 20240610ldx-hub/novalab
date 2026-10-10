#!/usr/bin/env node
/**
 * P4.1b — bridge sidecar 打包（生成物脚本；产物不入库，见 app/src-tauri/.gitignore）。
 *
 * 做两件事：
 *  1. esbuild 把 bridge/src/main.ts 打成单文件 ESM
 *     → app/src-tauri/bridge-dist/bridge.mjs
 *     （platform=node；ws/zod/chokidar/@modelcontextprotocol/sdk 全部内联，
 *      banner 提供 createRequire 兜底 CJS 动态 require，并注明生成物勿手改。）
 *  2. 本机 node（`where node` 首条的 realpath，防 fnm/volta symlink；要求 ≥22）
 *     → app/src-tauri/binaries/node-<target-triple>[.exe]
 *     （tauri.conf.json bundle.externalBin 以 "binaries/node" 引用它。）
 *
 * esbuild 来源（按序尝试）：root/app 直接可 resolve → pnpm store 内 vite 的
 * 兄弟目录（app 未直接依赖 esbuild，但 vite 依赖它，lockfile 已有）。
 *
 * 用法：node scripts/build-bridge.mjs   （在仓库根；先跑 pnpm install）
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const srcTauri = path.join(repoRoot, 'app', 'src-tauri');
const require = createRequire(import.meta.url);

/* ---------- target triple（externalBin 命名约定，tauri-utils external_binaries） ---------- */
function targetTriple() {
  const { platform, arch } = process;
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  throw new Error(`unsupported platform/arch for sidecar naming: ${platform}/${arch}`);
}
const triple = targetTriple();
const exeExt = process.platform === 'win32' ? '.exe' : '';

/* ---------- esbuild 定位 ---------- */
function resolveEsbuildEntry() {
  // 1) 常规 resolve（若 root/app 哪天直接依赖了 esbuild）
  for (const base of [repoRoot, path.join(repoRoot, 'app')]) {
    try {
      return require.resolve('esbuild', { paths: [base] });
    } catch {
      /* 继续 */
    }
  }
  // 2) pnpm：vite（app devDep）realpath 的兄弟 node_modules 里必有 esbuild
  try {
    const viteDir = require.resolve('vite/package.json', {
      paths: [path.join(repoRoot, 'app')],
    });
    return require.resolve('esbuild', { paths: [path.dirname(viteDir)] });
  } catch {
    /* 继续 */
  }
  // 3) 直接扫 .pnpm store（兜底，防 hoist 布局变化）
  const pnpmDir = path.join(repoRoot, 'node_modules', '.pnpm');
  if (fs.existsSync(pnpmDir)) {
    const hit = fs
      .readdirSync(pnpmDir)
      .filter((d) => /^esbuild@/.test(d))
      .sort()
      .at(-1);
    if (hit) {
      const candidate = path.join(pnpmDir, hit, 'node_modules', 'esbuild', 'lib', 'main.js');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error('找不到 esbuild —— 先 `pnpm install`（esbuild 经 vite 在 lockfile 中）');
}

/* ---------- 本机二进制定位（realpath，防 shim/symlink） ---------- */
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

function humanMB(p) {
  return `${(fs.statSync(p).size / 1024 / 1024).toFixed(1)} MB`;
}

/* ---------- 1. bundle bridge ---------- */
async function bundleBridge(esbuildEntry) {
  const esbuild = await import(pathToFileURL(esbuildEntry).href);
  const outfile = path.join(srcTauri, 'bridge-dist', 'bridge.mjs');
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  const result = await esbuild.build({
    entryPoints: [path.join(repoRoot, 'bridge', 'src', 'main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: false,
    minify: false,
    banner: {
      js: [
        '/* NovaLab bridge bundle —— scripts/build-bridge.mjs 生成物，勿手改；源在 bridge/src/。 */',
        'import { createRequire as __novalabCreateRequire } from "node:module";',
        'const require = __novalabCreateRequire(import.meta.url);',
      ].join('\n'),
    },
    logLevel: 'warning',
    metafile: true,
  });
  const inputs = Object.keys(result.metafile.inputs).length;
  console.log(`[build-bridge] bundled ${inputs} modules → ${outfile} (${humanMB(outfile)})`);
}

/* ---------- 2. node.exe sidecar ---------- */
function copyNodeSidecar() {
  const envOverride = process.env.NOVALAB_NODE_BIN;
  const nodePath = envOverride ? fs.realpathSync(envOverride) : locateOnPath('node');
  if (!nodePath) throw new Error('找不到本机 node（where node）——装 Node ≥22 或设 NOVALAB_NODE_BIN');
  const version = execFileSync(nodePath, ['--version'], { encoding: 'utf8' }).trim(); // vX.Y.Z
  const major = Number(version.replace(/^v/, '').split('.')[0]);
  if (!(major >= 22)) throw new Error(`node ${version} < 22，不满足 sidecar 要求（${nodePath}）`);
  const dest = path.join(srcTauri, 'binaries', `node-${triple}${exeExt}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(nodePath, dest);
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  console.log(`[build-bridge] node ${version}: ${nodePath} → ${dest} (${humanMB(dest)})`);
}

const esbuildEntry = resolveEsbuildEntry();
console.log(`[build-bridge] esbuild: ${esbuildEntry}`);
await bundleBridge(esbuildEntry);
copyNodeSidecar();
console.log(`[build-bridge] done (triple ${triple})`);
