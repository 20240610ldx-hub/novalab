#!/usr/bin/env node
/**
 * Packaged runtime acceptance: launch the bundled node sidecar, discover and
 * authenticate the Bridge, then open and execute the real demo notebook.
 *
 * The Tauri window is intentionally not needed here; this exercises the same
 * sidecar command and environment that the Windows/Linux shell launches. Set
 * NOVALAB_SMOKE_PY_DIR to an existing uv project (CI uses the checked-out py/)
 * to avoid downloading dependencies during the acceptance run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BridgeClient, discoverBridge } from './bridge-client.mjs';

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

const triple = targetTriple();
const ext = process.platform === 'win32' ? '.exe' : '';
const nodeSidecar = path.join(tauriDir, 'binaries', `node-${triple}${ext}`);
const uvSidecar = path.join(tauriDir, 'binaries', `uv-${triple}${ext}`);
const bridgeScript = path.join(tauriDir, 'bridge-dist', 'bridge.mjs');
const sourcePyDir = process.env.NOVALAB_SMOKE_PY_SOURCE_DIR
  ? path.resolve(process.env.NOVALAB_SMOKE_PY_SOURCE_DIR)
  : process.env.NOVALAB_SMOKE_PY_DIR
    ? path.resolve(process.env.NOVALAB_SMOKE_PY_DIR)
    : path.join(root, 'py');
const runtimePyDir = process.env.NOVALAB_SMOKE_PY_DIR
  ? path.resolve(process.env.NOVALAB_SMOKE_PY_DIR)
  : sourcePyDir;

for (const required of [nodeSidecar, uvSidecar, bridgeScript, path.join(sourcePyDir, 'pyproject.toml')]) {
  if (!fs.existsSync(required)) throw new Error(`packaged smoke 缺少产物: ${required}`);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novalab-packaged-smoke-'));
const dataDir = path.join(tempDir, 'data');
const notebookPath = path.join(root, 'demos', 'demo.py');
const child = spawn(nodeSidecar, [bridgeScript], {
  cwd: path.dirname(nodeSidecar),
  env: {
    ...process.env,
    NOVALAB_PACKAGED: '1',
    NOVALAB_DATA_DIR: dataDir,
    NOVALAB_PY_DIR: runtimePyDir,
    NOVALAB_PY_SOURCE_DIR: sourcePyDir,
    NOVALAB_UV_BIN: uvSidecar,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

child.stdout.on('data', (d) => process.stdout.write(`[packaged-bridge] ${d}`));
child.stderr.on('data', (d) => process.stderr.write(`[packaged-bridge!] ${d}`));

const waitForBridge = async () => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const info = await discoverBridge();
      const client = new BridgeClient();
      await client.connect();
      return { client, info };
    } catch (error) {
      if (attempt === 119) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('packaged bridge 未就绪');
};

try {
  const { client, info } = await waitForBridge();
  const ping = await client.rpc('ping');
  if (!ping?.pong) throw new Error(`ping 响应异常: ${JSON.stringify(ping)}`);
  const opened = await client.rpc('notebook.open', { path: notebookPath });
  if (!opened?.notebookId || !Array.isArray(opened.state?.cells)) {
    throw new Error(`notebook.open 响应异常: ${JSON.stringify(opened)}`);
  }
  const firstCell = opened.state.cells[0];
  const run = await client.rpc('cell.run', { cellId: firstCell.id, cascade: false });
  if (!run?.ok) throw new Error(`cell.run 失败: ${JSON.stringify(run)}`);
  console.log(`PACKAGED_STARTUP_SMOKE_OK triple=${triple} wsPort=${info.wsPort} llmPort=${info.llmPort}`);
  client.close();
} finally {
  child.kill();
  if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}
