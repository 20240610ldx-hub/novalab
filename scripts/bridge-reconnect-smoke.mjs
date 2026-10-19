#!/usr/bin/env node
/**
 * Real Chromium + two owned bridge generations: bridge death → desktop reconnect (round 6, A15).
 *
 * The smoke owns every process it touches: two bridge launchers (Windows Job Object via
 * smoke-win32.ps1 / POSIX process group), their kernels, and one stand-alone kernel probe.
 * It kills only the gen-1 bridge PID reported by its own launcher (never a kernel, never
 * a process outside its trees), serves /bridge-info for the page from the owned manifests,
 * and removes its temporary directory. No provider, no credentials, no Owner data.
 *
 * D4 (Owner-approved baselineSha256): dirty tabs may be reopened; the kernel's real
 * fingerprint decides whether drafts resume saving (disk unchanged, tab C) or the
 * conflict flow opens (disk changed during the outage, tab B).
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { stopOwnedTree, waitForManifest } from './smoke-runtime.mjs';

const runFile = promisify(execFile);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'bridge', 'package.json'));
const appURL = process.argv[2] ?? 'http://127.0.0.1:5299/';
const appOrigin = new URL(appURL).origin;
const windows = process.platform === 'win32';
const TIMEOUT_MS = 240_000;

const results = { steps: [], kernelEofProbe: null, pageErrors: [] };
const step = (name, detail = {}) => {
  results.steps.push({ name, ...detail });
  console.log(`[step] ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
};

/* ---------------- process table (owned-tree checks only) ---------------- */

async function processes() {
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
function descendants(rows, rootPid) {
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

/** Every owned PID observed during the run (bridges, kernels); all must be gone at the end. */
/** pid → creation time when first observed (0 = unknown on POSIX). */
const ownedSeen = new Map();

const isKernel = (row) => row.command.toLowerCase().includes('novakernel.server') && /python(?:\.exe)?/i.test(row.command);

async function kernelsOf(gen) {
  const rows = descendants(await processes(), gen.bridgePid);
  const kernels = rows.filter(isKernel);
  const pids = new Set(kernels.map((r) => r.pid));
  // uv may wrap python: keep leaf python processes only.
  for (const r of rows) if (!ownedSeen.has(r.pid)) ownedSeen.set(r.pid, r.created);
  return kernels.filter((r) => !kernels.some((o) => o.parent === r.pid && pids.has(o.pid))).map((r) => r.pid);
}

/** Still the SAME process: Windows reuses PIDs quickly, so compare creation time when known. */
async function alive(pids) {
  const rows = new Map((await processes()).map((r) => [r.pid, r]));
  return pids.filter((pid) => {
    const row = rows.get(pid);
    if (!row) return false;
    const seen = ownedSeen.get(pid) ?? 0;
    return seen === 0 || row.created === 0 || row.created === seen;
  });
}

/* ---------------- owned bridge generations ---------------- */

async function launchBridge(label, work, signal) {
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

async function stopGen(gen) {
  if (!gen || gen.stopped) return;
  gen.stopped = true;
  await stopOwnedTree(gen.child, gen.closed);
}

/* ---------------- stand-alone kernel EOF probe ---------------- */

/** Owned kernel without a bridge: does it exit when its stdin (the bridge pipe) closes? */
async function kernelEofProbe(work, busy) {
  const kernel = spawn('uv', ['run', '--directory', path.join(root, 'py'), 'python', '-m', 'novakernel.server'], {
    cwd: work, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: !windows,
  });
  const exited = new Promise((resolve) => kernel.once('exit', (code) => resolve(code)));
  let ready = false;
  kernel.stderr.on('data', (d) => { if (String(d).includes('ready on stdio')) ready = true; });
  const readyBy = Date.now() + 60_000;
  while (!ready) {
    if (Date.now() > readyBy) throw new Error('kernel probe did not start');
    await delay(50);
  }
  const ms = busy ? 3_000 : 0;
  if (busy) {
    kernel.stdin.write(`${JSON.stringify({ id: 1, method: 'exec_repl', params: { code: `import time\ntime.sleep(${ms / 1000})` } })}\n`);
    await delay(300);
  }
  const t0 = Date.now();
  kernel.stdin.end();
  const code = await Promise.race([exited, delay(20_000).then(() => 'timeout')]);
  const elapsedMs = Date.now() - t0;
  if (code === 'timeout') {
    if (windows) await runFile('taskkill.exe', ['/PID', String(kernel.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    else process.kill(-kernel.pid, 'SIGKILL');
  }
  return { busy, exitedOnEof: code !== 'timeout', elapsedMs, sleptMs: ms };
}

/* ---------------- main ---------------- */

const controller = new AbortController();
const overall = setTimeout(() => controller.abort(new Error(`smoke 总超时 (${TIMEOUT_MS}ms)`)), TIMEOUT_MS);
const browser = await chromium.launch({ headless: true });
const work = await mkdtemp(path.join(tmpdir(), 'novalab-reconnect-smoke-'));
let gen1;
let gen2;
let failure;

try {
  const aPath = path.join(work, 'a.py');
  const bPath = path.join(work, 'b.py');
  const replayMarker = path.join(work, 'replayed.txt');
  const aSource = '# %% [cell-id: aaaaaaaa]\nx = 1\nprint("A_OK")\n\n'
    + `# %% [cell-id: bbbbbbbb]\nimport time, pathlib\ntime.sleep(20)\npathlib.Path(${JSON.stringify(replayMarker)}).write_text("ran")\n`;
  const bSource = '# %% [cell-id: cccccccc]\ny = 100\n';
  const cPath = path.join(work, 'c.py');
  const cSource = '# %% [cell-id: dddddddd]\nz = 1\n';
  await writeFile(aPath, aSource, 'utf8');
  await writeFile(bPath, bSource, 'utf8');
  await writeFile(cPath, cSource, 'utf8');

  gen1 = await launchBridge('gen1', work, controller.signal);
  let active = gen1.info;
  let discoveryRefusals = 0;

  const page = await browser.newPage();
  page.on('pageerror', (error) => results.pageErrors.push(error.message));
  page.on('dialog', (dialog) => dialog.dismiss());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/bridge-info' && ['127.0.0.1', 'localhost'].includes(url.hostname)) {
      if (!active) { discoveryRefusals += 1; return route.abort('connectionrefused'); }
      return route.fulfill({ status: 200, headers: {
        'Content-Type': 'application/json', 'Access-Control-Allow-Origin': appOrigin,
      }, body: JSON.stringify(active) });
    }
    if (url.origin === appOrigin) return route.continue();
    if ([gen1, gen2].some((g) => g && url.origin === g.info.llmProxyOrigin)) return route.continue();
    return route.abort();
  });

  await page.goto(`${appURL}?path=${encodeURIComponent(aPath)}`);
  await page.evaluate(async () => {
    const { useNotebook: nb } = await import('/src/store/notebook.ts');
    const { useNotebooks: tabs } = await import('/src/store/notebooks.ts');
    const { useI18nStore: i18n } = await import('/src/i18n/index.ts');
    const { bridge } = await import('/src/bridge/client.ts');
    i18n.getState().setLang('zh');
    const h = { nb, tabs, bridge, calls: [], rejections: [] };
    const original = bridge.rpc.bind(bridge);
    bridge.rpc = (method, params = {}) => {
      h.calls.push({ method, at: Date.now(), status: bridge.getStatus() });
      return original(method, params).catch((error) => {
        h.rejections.push({ method, name: error?.name });
        throw error;
      });
    };
    window.__reconnect = h;
  });
  await page.waitForFunction((file) => {
    const h = window.__reconnect;
    return h.nb.getState().notebookPath === file && h.nb.getState().cells.length === 2;
  }, aPath);
  const aId1 = await page.evaluate(() => window.__reconnect.tabs.getState().activeId);
  await page.evaluate(async () => { await window.__reconnect.nb.getState().runCell('aaaaaaaa'); });
  await page.waitForFunction(() => window.__reconnect.nb.getState().cells[0]?.output?.stdout?.includes('A_OK'));
  await page.evaluate(async (file) => { await window.__reconnect.nb.getState().openNotebook(file); }, bPath);
  await page.waitForFunction((file) => window.__reconnect.nb.getState().notebookPath === file, bPath);
  const bId1 = await page.evaluate(() => window.__reconnect.tabs.getState().activeId);
  await page.evaluate(async (file) => { await window.__reconnect.nb.getState().openNotebook(file); }, cPath);
  await page.waitForFunction((file) => window.__reconnect.nb.getState().notebookPath === file, cPath);
  const cId1 = await page.evaluate(() => window.__reconnect.tabs.getState().activeId);
  const cBaseline1 = await page.evaluate((id) => window.__reconnect.tabs.getState().tabs.find((t) => t.notebookId === id)?.baselineSha256, cId1);
  assert.equal(cBaseline1, createHash('sha256').update(await readFile(cPath)).digest('hex'), 'gen1 reports the real disk fingerprint');
  await page.evaluate(async (id) => { await window.__reconnect.nb.getState().switchTab(id); }, aId1);
  await page.waitForFunction((id) => window.__reconnect.tabs.getState().activeId === id, aId1);
  const gen1Kernels = await kernelsOf(gen1);
  assert.equal(gen1Kernels.length, 3, `gen1 must own three kernels (got ${gen1Kernels.length})`);
  step('gen1 ready', { tabs: 3, kernels: gen1Kernels.length, baselineMatchesDisk: true });

  // Long-running cell → pending cell.run at the moment the bridge dies.
  await page.evaluate(() => { const h = window.__reconnect; h.runDone = h.nb.getState().runCell('bbbbbbbb').then(() => true); });
  await page.waitForFunction(() => window.__reconnect.nb.getState().cells[1]?.status === 'running');
  await delay(500);

  // Kill ONLY the owned gen-1 bridge process (not a kernel, not the tree).
  const rowsBefore = descendants(await processes(), gen1.bridgePid);
  assert.ok(rowsBefore.some((r) => r.pid === gen1.bridgePid), 'gen1 bridge pid must be in its own tree');
  assert.ok(!gen1Kernels.includes(gen1.bridgePid), 'refusing to target a kernel');
  active = null;
  if (windows) await runFile('taskkill.exe', ['/PID', String(gen1.bridgePid), '/F'], { windowsHide: true, timeout: 15_000 });
  else process.kill(gen1.bridgePid, 'SIGKILL');
  step('killed owned gen1 bridge', { target: 'bridge-node' });

  await page.locator('[data-testid="bridge-reconnecting"]').waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForFunction(() => window.__reconnect.runDone);
  const settled = await page.evaluate(() => {
    const h = window.__reconnect;
    return {
      status: h.nb.getState().bridgeStatus,
      connected: h.nb.getState().bridgeConnected,
      runningCell: h.nb.getState().cells[1]?.status,
      runRejection: h.rejections.find((r) => r.method === 'cell.run')?.name,
    };
  });
  assert.equal(settled.status, 'reconnecting');
  assert.equal(settled.connected, false);
  assert.equal(settled.runRejection, 'BridgeDisconnectedError');
  assert.equal(settled.runningCell, 'stale');
  step('reconnect UI shown; pending cell.run settled', settled);

  // D3: keep editing while disconnected (B), no save/run is sent.
  const offline = await page.evaluate(async (id) => {
    const h = window.__reconnect;
    const before = h.calls.length;
    await h.nb.getState().switchTab(id);
    h.nb.getState().setCellCode('cccccccc', 'y = 200  # draft while disconnected');
    await new Promise((r) => setTimeout(r, 1_000)); // > autosave debounce
    await h.nb.getState().runCell('cccccccc');
    const sent = h.calls.slice(before).map((c) => c.method);
    const tab = h.tabs.getState().tabs.find((t) => t.notebookId === id);
    return { sent, dirty: tab?.dirty, draft: h.tabs.getState().readCache(id)?.drafts?.cccccccc?.code ?? h.nb.getState().cells[0]?.code };
  }, bId1);
  // Reads (fs.root, session.list…) may be attempted and fail fast; nothing that writes/runs may be sent.
  const writes = offline.sent.filter((m) => /^(cell\.|kernel\.|diff\.|control\.|notebook\.(open|close|reload|switch))/.test(m));
  assert.deepEqual(writes, [], `no bridge writes while disconnected: ${offline.sent}`);
  assert.equal(offline.dirty, true);
  assert.equal(offline.draft, 'y = 200  # draft while disconnected');
  const offlineC = await page.evaluate(async (id) => {
    const h = window.__reconnect;
    const before = h.calls.length;
    await h.nb.getState().switchTab(id);
    h.nb.getState().setCellCode('dddddddd', 'z = 2  # draft, disk unchanged');
    await new Promise((r) => setTimeout(r, 1_000));
    return { sent: h.calls.slice(before).map((c) => c.method), dirty: h.tabs.getState().tabs.find((t) => t.notebookId === id)?.dirty };
  }, cId1);
  assert.deepEqual(offlineC.sent.filter((m) => /^(cell\.|kernel\.|diff\.|control\.|notebook\.(open|close|reload|switch))/.test(m)), []);
  assert.equal(offlineC.dirty, true);
  step('edit allowed while disconnected; save/run not sent', { dirtyTabs: 2 });

  // External change to B while the bridge is gone (watcher cannot see it).
  const bExternal = '# %% [cell-id: cccccccc]\ny = 300  # external edit during outage\n';
  await writeFile(bPath, bExternal, 'utf8');

  // gen1 tree must be fully gone (launcher Job reports empty) before gen2 starts.
  await Promise.race([gen1.closed, delay(20_000).then(() => { throw new Error('gen1 launcher did not exit'); })]);
  gen1.stopped = true;
  if (windows) assert.equal(gen1.child.jobEmpty, true, 'gen1 Job must report no remaining processes');
  assert.deepEqual(await alive([gen1.bridgePid, ...gen1Kernels]), [], 'gen1 bridge and kernels must be gone');
  assert.ok(discoveryRefusals > 0, 'page must keep re-running discovery while no bridge is up');
  step('gen1 tree exited', { jobEmpty: gen1.child.jobEmpty ?? null, discoveryRefusals });

  // Harness brings up a NEW owned bridge (new token/port), as the Tauri supervisor would.
  await rm(path.join(work, 'data', 'bridge.json'), { force: true });
  gen2 = await launchBridge('gen2', work, controller.signal);
  assert.notEqual(gen2.info.token, gen1.info.token);
  active = gen2.info;
  await page.waitForFunction(() => window.__reconnect.nb.getState().bridgeStatus === 'connected', undefined, { timeout: 30_000 });
  await page.locator('[data-testid="bridge-reconnecting"]').waitFor({ state: 'detached' });
  await delay(1_500); // give any (forbidden) automatic reopen a chance to show up
  const lost = await page.evaluate(() => {
    const h = window.__reconnect;
    return {
      generation: h.bridge.getGeneration(),
      tabs: h.tabs.getState().tabs.map((t) => ({ id: t.notebookId, path: t.path, lost: !!t.bridgeLost, dirty: t.dirty, ended: t.ended })),
      opens: h.calls.filter((c) => c.method === 'notebook.open' && c.status === 'connected').length,
      rows: document.querySelectorAll('[data-testid="bridge-lost-row"]').length,
      reopenButtons: document.querySelectorAll('[data-testid="bridge-lost-reopen"]').length,
      reopenAll: document.querySelector('[data-testid="bridge-lost-all"]')?.textContent ?? null,
    };
  });
  const opensBeforeReconnect = await page.evaluate(() => window.__reconnect.calls.filter((c) => c.method === 'notebook.open').length);
  assert.equal(lost.tabs.length, 3);
  assert.ok(lost.tabs.every((t) => t.lost && !t.ended), 'all tabs kept, marked bridge-lost, still editable');
  assert.equal(lost.rows, 3);
  assert.equal(lost.reopenButtons, 3, 'D4: clean and dirty tabs all offer reopen (dirty ones are fingerprint-checked)');
  assert.ok(lost.reopenAll?.startsWith('3 '), `one "reopen all" row counting 3 tabs, got ${lost.reopenAll}`);
  assert.equal((await kernelsOf(gen2)).length, 0, 'D1: no automatic reopen — gen2 starts no kernel');
  step('gen2 connected; tabs kept as bridge-lost; nothing reopened', { generation: lost.generation, opensBeforeReconnect });

  const reopenButton = (file) => page.locator('[data-testid="bridge-lost-row"]', { hasText: path.basename(file) }).locator('[data-testid="bridge-lost-reopen"]');
  // D1: user clicks reopen on the clean tab A → cold load only.
  const opensBefore = opensBeforeReconnect;
  await reopenButton(aPath).click();
  await page.waitForFunction((file) => {
    const h = window.__reconnect;
    const tab = h.tabs.getState().tabs.find((t) => t.path === file);
    return tab && !tab.bridgeLost && h.tabs.getState().activeId === tab.notebookId;
  }, aPath);
  await delay(1_000);
  const reopened = await page.evaluate(({ file, oldId }) => {
    const h = window.__reconnect;
    const tab = h.tabs.getState().tabs.find((t) => t.path === file);
    return {
      newId: tab.notebookId,
      oldIdGone: !h.tabs.getState().tabs.some((t) => t.notebookId === oldId),
      cells: h.nb.getState().cells.map((c) => ({ code: c.code, execCount: c.execCount, output: c.output })),
      methods: h.calls.map((c) => c.method),
    };
  }, { file: aPath, oldId: aId1 });
  assert.notEqual(reopened.newId, aId1);
  assert.equal(reopened.oldIdGone, true);
  assert.equal(reopened.cells.length, 2);
  assert.ok(reopened.cells.every((c) => c.execCount === null && c.output === null), 'cold: no counts, no old outputs');
  assert.equal(reopened.cells[0].code, 'x = 1\nprint("A_OK")');
  const opensAfter = reopened.methods.filter((m) => m === 'notebook.open').length;
  assert.equal(opensAfter - opensBefore, 1, 'exactly one notebook.open for the click');
  const lastOpen = reopened.methods.lastIndexOf('notebook.open');
  assert.ok(!reopened.methods.slice(lastOpen).some((m) => /^(cell\.run|kernel\.repl|kernel\.restart|diff\.)/.test(m)), 'no execution/replay after reopen');
  const gen2Kernels = await kernelsOf(gen2);
  assert.equal(gen2Kernels.length, 1, 'only the reopened clean tab gets a kernel');
  assert.equal(existsSync(replayMarker), false, 'interrupted cell must not have been replayed');
  step('clean tab cold-reopened on click', { notebookOpen: 1, kernels: gen2Kernels.length, replayed: false });
  const allAfterA = await page.locator('[data-testid="bridge-lost-all"]').textContent();
  assert.ok(allAfterA?.startsWith('2 '), `"reopen all" now counts 2, got ${allAfterA}`);

  // D4 mismatch: dirty B (disk changed during the outage) → conflict flow; nothing saved over the external bytes.
  const savesBeforeB = await page.evaluate(() => window.__reconnect.calls.filter((c) => c.method === 'cell.save').length);
  await reopenButton(bPath).click();
  await page.waitForFunction((file) => {
    const tab = window.__reconnect.tabs.getState().tabs.find((t) => t.path === file);
    return tab && !tab.bridgeLost && tab.conflict;
  }, bPath);
  await delay(1_000); // > autosave debounce: a blind save would show up here
  const bConflict = await page.evaluate(({ file }) => {
    const h = window.__reconnect;
    const tab = h.tabs.getState().tabs.find((t) => t.path === file);
    return {
      conflictPath: tab.conflict?.notebookPath, dirty: tab.dirty,
      draft: h.tabs.getState().readCache(tab.notebookId)?.drafts?.cccccccc?.code,
      visible: h.nb.getState().cells[0]?.code,
      saves: h.calls.filter((c) => c.method === 'cell.save').length,
      banner: document.body.innerText.includes('的文件已有外部版本'),
    };
  }, { file: bPath });
  assert.equal(bConflict.conflictPath, bPath);
  assert.equal(bConflict.dirty, true);
  assert.equal(bConflict.draft, 'y = 200  # draft while disconnected');
  assert.equal(bConflict.visible, 'y = 200  # draft while disconnected');
  assert.equal(bConflict.saves, savesBeforeB, 'no save sent for the mismatched tab');
  assert.equal(bConflict.banner, true);
  assert.equal(await readFile(bPath, 'utf8'), bExternal, 'external bytes on disk untouched');
  step('dirty tab with changed disk → conflict flow; draft kept; disk untouched', { conflict: true });
  assert.equal(await page.locator('[data-testid="bridge-lost-all"]').count(), 0, '"reopen all" hidden once a single tab is left');

  // Existing round-4 resolution: keep a local copy, then load the external version.
  await page.getByRole('button', { name: '保留本地副本并加载磁盘版本', exact: true }).click();
  await page.waitForFunction((file) => {
    const tab = window.__reconnect.tabs.getState().tabs.find((t) => t.path === file);
    return tab && !tab.conflict && typeof tab.recoveryPath === 'string';
  }, bPath);
  const bResolved = await page.evaluate((file) => {
    const h = window.__reconnect;
    const tab = h.tabs.getState().tabs.find((t) => t.path === file);
    return { recoveryPath: tab.recoveryPath, code: h.nb.getState().cells[0]?.code, baseline: tab.baselineSha256 };
  }, bPath);
  assert.equal(bResolved.code, 'y = 300  # external edit during outage');
  assert.ok((await readFile(bResolved.recoveryPath, 'utf8')).includes('y = 200  # draft while disconnected'), 'local draft preserved in the recovery copy');
  assert.equal(bResolved.baseline, createHash('sha256').update(await readFile(bPath)).digest('hex'));
  assert.equal(await readFile(bPath, 'utf8'), bExternal);
  step('conflict resolved via local copy + disk load', { recoveryCopyHasDraft: true });

  // D4 match: dirty C (disk unchanged) → reopen, drafts kept, autosave resumes on the new kernel.
  await reopenButton(cPath).click();
  await page.waitForFunction((file) => {
    const tab = window.__reconnect.tabs.getState().tabs.find((t) => t.path === file);
    return tab && !tab.bridgeLost && !tab.conflict && tab.dirty === false;
  }, cPath, { timeout: 15_000 });
  const cDisk = await readFile(cPath);
  const cSaved = await page.evaluate((file) => {
    const h = window.__reconnect;
    const tab = h.tabs.getState().tabs.find((t) => t.path === file);
    return { baseline: tab.baselineSha256 };
  }, cPath);
  assert.ok(cDisk.toString('utf8').includes('z = 2  # draft, disk unchanged'), 'draft saved to disk after fingerprint matched');
  assert.equal(cSaved.baseline, createHash('sha256').update(cDisk).digest('hex'), 'tab fingerprint advanced to the saved bytes');
  assert.notEqual(cSaved.baseline, cBaseline1);
  assert.equal((await kernelsOf(gen2)).length, 3, 'one kernel per reopened tab');
  assert.equal(existsSync(replayMarker), false, 'interrupted cell still not replayed');
  step('dirty tab with unchanged disk → reopened, draft saved, fingerprint advanced', { saved: true });

  assert.deepEqual(results.pageErrors, [], `page errors: ${results.pageErrors.join('; ')}`);
  await page.close();

  results.kernelEofProbe = [await kernelEofProbe(work, false), await kernelEofProbe(work, true)];
  step('kernel stdin-EOF probe', { probes: results.kernelEofProbe });
} catch (error) {
  failure = error;
} finally {
  clearTimeout(overall);
  await browser.close().catch(() => {});
  try {
    await stopGen(gen2);
    await stopGen(gen1);
    const leftovers = (await processes()).filter((r) => r.command.includes(work));
    assert.deepEqual(leftovers.map((r) => r.pid), [], 'no process may still reference the smoke work dir');
    // Exit is asynchronous (console hosts, job teardown): wait up to 10 s, record what was slow.
    let survivors = await alive([...ownedSeen.keys()]);
    const exitDeadline = Date.now() + 10_000;
    while (survivors.length > 0 && Date.now() < exitDeadline) {
      const rows = await processes();
      results.slowExit = rows.filter((r) => survivors.includes(r.pid)).map((r) => path.win32.basename(r.command.replace(/"/g, '').split(/\s+/)[0] ?? '') || '(no command line)');
      await delay(250);
      survivors = await alive(survivors);
    }
    results.ownedPidCount = ownedSeen.size;
    results.ownedSurvivors = survivors.length;
    assert.deepEqual(survivors, [], 'every owned bridge/kernel PID must have exited');
    console.log('smoke cleanup: owned process trees exited');
  } catch (error) {
    failure = failure ? new Error(`${failure.message}; cleanup: ${error.message}`, { cause: failure }) : error;
  } finally {
    // The temporary directory is removed even when an assertion above failed.
    await rm(work, { recursive: true, force: true }).catch(() => {});
    if (existsSync(work)) failure ??= new Error('smoke temp dir could not be removed');
    else console.log('smoke cleanup: temporary files removed');
  }
}
console.log(`BRIDGE_RECONNECT_RESULTS ${JSON.stringify(results)}`);
if (failure) {
  console.error(failure);
  process.exit(1);
}
console.log('BRIDGE_RECONNECT_SMOKE_OK');
