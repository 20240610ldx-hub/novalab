#!/usr/bin/env node
/**
 * Run the bundled node/bridge/uv with the packaged environment, using an owned
 * Bridge and a temporary synthetic notebook. This does not run a Tauri window
 * or installer. NOVALAB_SMOKE_PY_DIR may select an already provisioned uv project
 * (Release CI uses the checked-out py/) to avoid first-run dependency downloads.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSmokeBridge } from './smoke-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauriDir = path.join(root, 'app', 'src-tauri');

function targetTriple() {
  if (process.platform === 'win32' && process.arch === 'x64') return 'x86_64-pc-windows-msvc';
  if (process.platform === 'linux' && process.arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'x86_64-apple-darwin';
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'aarch64-apple-darwin';
  throw new Error(`unsupported platform/arch: ${process.platform}/${process.arch}`);
}

export const PACKAGED_SMOKE_FIXTURE = `# %% [cell-id: abcdef01]
import os
assert os.environ["NOVALAB_PACKAGED"] == "1"
assert os.path.isabs(os.environ["NOVALAB_UV_BIN"])
packaged_answer = 6 * 7
packaged_answer
`;

function packagedPaths() {
  const triple = targetTriple();
  const ext = process.platform === 'win32' ? '.exe' : '';
  const sourcePyDir = path.resolve(process.env.NOVALAB_SMOKE_PY_SOURCE_DIR ?? process.env.NOVALAB_SMOKE_PY_DIR ?? path.join(root, 'py'));
  return {
    triple,
    uvSidecar: path.join(tauriDir, 'binaries', `uv-${triple}${ext}`),
    sourcePyDir,
    runtimePyDir: path.resolve(process.env.NOVALAB_SMOKE_PY_DIR ?? sourcePyDir),
  };
}

/**
 * 首启自装预热：runtime py 目录缺 `.venv` 时，用 sidecar uv 执行与产品 ensureKernelVenv 相同的两步
 * （`uv python install` → `uv sync --all-extras`）。干净机器上这一步要下载解释器与依赖（实测 ~60 s），
 * 产品允许 300 s；验收用例各自只有 60 s 且考核的是启动/清理生命周期，故在用例前单独预热并留痕。
 * 已存在 `.venv` → 不做任何事。返回是否执行了预热。
 */
export function prewarmPackagedPython({ timeoutMs = 300_000, log = console.error } = {}) {
  const { uvSidecar, runtimePyDir } = packagedPaths();
  if (fs.existsSync(path.join(runtimePyDir, '.venv'))) return false;
  if (!fs.existsSync(path.join(runtimePyDir, 'pyproject.toml'))) {
    throw new Error(`packaged 预热缺少 pyproject: ${runtimePyDir}`);
  }
  const t0 = Date.now();
  for (const args of [['python', 'install'], ['sync', '--directory', runtimePyDir, '--all-extras']]) {
    const r = spawnSync(uvSidecar, args, { stdio: ['ignore', 'ignore', 'inherit'], timeout: timeoutMs, windowsHide: true });
    if (r.status !== 0) throw new Error(`packaged 预热失败: uv ${args.join(' ')} (status=${r.status ?? r.signal ?? r.error?.message})`);
  }
  log(`packaged prewarm: bootstrapped ${runtimePyDir} in ${Date.now() - t0}ms`);
  return true;
}

export async function runPackagedStartupSmoke({ fixture = PACKAGED_SMOKE_FIXTURE, ...options } = {}) {
  const { triple, uvSidecar, sourcePyDir, runtimePyDir } = packagedPaths();
  const ext = process.platform === 'win32' ? '.exe' : '';
  const nodeSidecar = path.join(tauriDir, 'binaries', `node-${triple}${ext}`);
  const bridgeScript = path.join(tauriDir, 'bridge-dist', 'bridge.mjs');
  for (const required of [nodeSidecar, uvSidecar, bridgeScript, path.join(sourcePyDir, 'pyproject.toml')]) {
    if (!fs.existsSync(required)) throw new Error(`packaged smoke 缺少产物: ${required}`);
  }

  let info;
  await withSmokeBridge(fixture, async ({ bridge, notebookPath, stage }) => {
    info = bridge.info;
    const ping = await bridge.rpc('ping');
    if (!ping?.pong) throw new Error('packaged ping 响应异常');
    const opened = await bridge.rpc('notebook.open', { path: notebookPath });
    await stage('opened');
    if (!opened?.notebookId || opened.state?.cells?.length !== 1) {
      throw new Error('packaged notebook.open 应返回一个合成 cell');
    }
    const cell = opened.state.cells[0];
    const mark = bridge.notifications.length;
    const run = await bridge.rpc('cell.run', { cellId: cell.id, cascade: false });
    if (!run?.ok) throw new Error(`packaged cell.run 失败: ${JSON.stringify(run)}`);
    await bridge.waitNotif('run.done', (p) => p?.cellId === cell.id, 15_000, mark);
    const result = bridge.notifications.slice(mark).find((n) =>
      n.method === 'run.mime' && n.params?.cellId === cell.id && n.params?.mime === 'text/plain');
    if (result?.params.data !== '42') throw new Error('packaged Python 计算结果应为 42');
    await stage('executed');
  }, {
    ...options,
    launch: () => ({
      node: nodeSidecar,
      main: bridgeScript,
      cwd: path.dirname(nodeSidecar),
      env: {
        NOVALAB_PACKAGED: '1',
        NOVALAB_PY_DIR: runtimePyDir,
        NOVALAB_PY_SOURCE_DIR: sourcePyDir,
        NOVALAB_UV_BIN: uvSidecar,
      },
    }),
  });
  // withSmokeBridge resolves only after owned descendants exit and temp removal.
  console.log(`PACKAGED_STARTUP_SMOKE_OK triple=${triple} wsPort=${info.wsPort} llmPort=${info.llmPort}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runPackagedStartupSmoke();
  } catch (error) {
    console.error('PACKAGED_STARTUP_SMOKE_FAIL:', error.message);
    process.exitCode = error.signal === 'SIGINT' ? 130 : error.signal === 'SIGTERM' ? 143 : error.signal === 'SIGHUP' ? 129 : 1;
  }
}
