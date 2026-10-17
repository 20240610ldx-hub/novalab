/**
 * Owned bridge generations for real-browser smokes (round 7 draft recovery).
 * Same mechanics as scripts/bridge-reconnect-smoke.mjs (round 6, kept as sealed):
 * Windows launches each bridge inside a Job Object (smoke-win32.ps1), POSIX in its own
 * process group; ownership is the launcher's descendant tree with creation-time checks so a
 * reused PID or a stale ParentProcessId is never adopted.
 */
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { stopOwnedTree, waitForManifest } from './smoke-runtime.mjs';

export const runFile = promisify(execFile);
export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'bridge', 'package.json'));
export const windows = process.platform === 'win32';

export async function processes() {
  if (windows) {
    const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,@{n="Created";e={$_.CreationDate.ToFileTimeUtc()}} | ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 * 1024 });
    const raw = stdout.trim() ? JSON.parse(stdout) : [];
    return (Array.isArray(raw) ? raw : [raw]).map((r) => ({ pid: Number(r.ProcessId), parent: Number(r.ParentProcessId), command: String(r.CommandLine ?? ''), created: Number(r.Created ?? 0) }));
  }
  const { stdout } = await runFile('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'command='], { timeout: 15_000 });
  return stdout.trim().split('\n').filter(Boolean).map((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m ? { pid: Number(m[1]), parent: Number(m[2]), command: m[3], created: 0 } : null;
  }).filter(Boolean);
}

/** Windows ParentProcessId can name a dead, reused PID: a child must not predate its parent. */
export function descendants(rows, rootPid) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const owned = new Set([rootPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) {
      if (!owned.has(row.parent) || owned.has(row.pid)) continue;
      if (row.created < (byPid.get(row.parent)?.created ?? 0)) continue;
      owned.add(row.pid); changed = true;
    }
  }
  return rows.filter((row) => owned.has(row.pid));
}

/** pid → creation time when first observed (0 = unknown on POSIX). Every one must be gone at the end. */
export const ownedSeen = new Map();

/** Record the generation's current tree (bridge, uv, kernels) as owned. */
export async function observe(gen) {
  const rows = descendants(await processes(), gen.bridgePid);
  for (const r of rows) if (!ownedSeen.has(r.pid)) ownedSeen.set(r.pid, r.created);
  return rows;
}

/** Still the SAME process: Windows reuses PIDs quickly, so compare creation time when known. */
export async function alive(pids) {
  const rows = new Map((await processes()).map((r) => [r.pid, r]));
  return pids.filter((pid) => {
    const row = rows.get(pid);
    if (!row) return false;
    const seen = ownedSeen.get(pid) ?? 0;
    return seen === 0 || row.created === 0 || row.created === seen;
  });
}

export async function launchBridge(label, work, signal) {
  const token = randomBytes(32).toString('base64url');
  const spec = {
    node: process.execPath,
    loader: pathToFileURL(require.resolve('tsx')).href,
    main: path.join(root, 'bridge', 'src', 'main.ts'),
    cwd: path.join(root, 'bridge'),
  };
  const child = spawn(windows ? 'powershell.exe' : spec.node, windows
    ? ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts', 'smoke-win32.ps1'),
      '-Node', spec.node, '-Main', spec.main, '-Loader', spec.loader]
    : ['--import', spec.loader, spec.main], {
    cwd: spec.cwd,
    env: {
      ...process.env,
      NOVALAB_PACKAGED: '0',
      NOVALAB_PY_DIR: path.join(root, 'py'),
      NOVALAB_UV_BIN: 'uv',
      NOVALAB_DATA_DIR: path.join(work, 'data'),
      NOVALAB_BRIDGE_TOKEN: token,
      NOVALAB_BRIDGE_PORT: '0',
      NOVALAB_LLM_PORT: '0',
    },
    detached: !windows,
    windowsHide: true,
    stdio: [windows ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.stdin?.on('error', () => {});
  let out = '';
  child.stdout.on('data', (d) => {
    out += String(d);
    const m = /NOVALAB_SMOKE_BRIDGE_PID=(\d+)/.exec(out);
    if (m) child.bridgePid = Number(m[1]);
    if (out.includes('NOVALAB_SMOKE_JOB_EMPTY')) child.jobEmpty = true;
    if (out.length > 4096) out = out.slice(-4096);
    process.stdout.write(`[${label}] ${d}`);
  });
  child.stderr.on('data', (d) => process.stderr.write(`[${label}!] ${d}`));
  const info = await waitForManifest(path.join(work, 'data', 'bridge.json'), child, token, signal);
  const gen = { label, child, closed, info, bridgePid: child.bridgePid ?? child.pid, stopped: false };
  for (const r of await processes()) if ((r.pid === gen.bridgePid || r.pid === child.pid) && !ownedSeen.has(r.pid)) ownedSeen.set(r.pid, r.created);
  console.log(`[${label}] owned bridge pid=${gen.bridgePid} launcher=${child.pid}`);
  return gen;
}

export async function stopGen(gen) {
  if (!gen || gen.stopped) return;
  gen.stopped = true;
  await stopOwnedTree(gen.child, gen.closed);
}

/** Kill ONLY the generation's bridge node PID (never a kernel, never /T). */
export async function killBridgeOnly(gen) {
  const rows = descendants(await processes(), gen.bridgePid);
  if (!rows.some((r) => r.pid === gen.bridgePid)) throw new Error('bridge pid not in its own tree');
  if (windows) await runFile('taskkill.exe', ['/PID', String(gen.bridgePid), '/F'], { windowsHide: true, timeout: 15_000 });
  else process.kill(gen.bridgePid, 'SIGKILL');
}
