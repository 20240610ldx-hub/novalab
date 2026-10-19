#!/usr/bin/env node
/**
 * Real Tauri window (WebView2 over CDP): offline draft journal (round 7 follow-up, O5).
 *
 * Windows only. Drives the debug desktop build (app/src-tauri/target/debug/novalab.exe, devUrl
 * http://localhost:5199 served by this worktree's Vite) through WebView2's remote-debugging port.
 * The app spawns and supervises its own bridge exactly as in production dev mode; discovery is
 * the product's own 7788–7798 scan (precondition: no other listener there).
 *
 *   1. open a.py in the real window; kill ONLY the app's bridge node PID (from its manifest)
 *   2. the Rust supervisor restarts the bridge (round 6 D2) → new generation → tab bridge-lost
 *   3. edit the bridge-lost tab → frontend calls the Rust command write_draft_journal (not
 *      draft.write) → journal next to a.py with the tab's last confirmed fingerprint
 *   4. kill the whole app tree (app death), relaunch → a.py offers recovery (fingerprint
 *      matches) → click restore → draft back in the editor, no cell.save, a.py bytes unchanged
 *
 * Isolation: NOVALAB_DATA_DIR and WEBVIEW2_USER_DATA_FOLDER point into the smoke's temp dir.
 * Every process it stops is a descendant of an app it launched. No provider, no credentials.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { alive, descendants, ownedSeen, processes, root, runFile, windows } from './owned-bridge.mjs';

if (!windows) {
  console.log('TAURI_WINDOW_DRAFT_SMOKE_SKIPPED (WebView2 is Windows-only)');
  process.exit(0);
}

const exe = path.join(root, 'app', 'src-tauri', 'target', 'debug', 'novalab.exe');
const appOrigin = 'http://localhost:5199';
const CDP_PORT = Number(process.env.NOVALAB_SMOKE_CDP_PORT ?? 9339);
const TIMEOUT_MS = 300_000;
const results = { steps: [], pageErrors: [] };
const step = (name, detail = {}) => {
  results.steps.push({ name, ...detail });
  console.log(`[step] ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function listeners() {
  const { stdout } = await runFile('netstat.exe', ['-ano', '-p', 'TCP'], { windowsHide: true });
  return stdout.split(/\r?\n/).map((l) => /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(l)).filter(Boolean)
    .map((m) => ({ port: Number(m[1]), pid: Number(m[2]) })).filter((r) => r.pid !== 0); // pid 0 = known stale rows
}

async function waitFor(predicate, label, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate().catch(() => undefined);
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await delay(200);
  }
}

async function observeApp(app) {
  const rows = descendants(await processes(), app.child.pid);
  for (const r of rows) if (!ownedSeen.has(r.pid)) ownedSeen.set(r.pid, r.created);
  return rows;
}

const launched = [];

async function launchApp(label, work) {
  const child = spawn(exe, [], {
    cwd: work,
    env: {
      ...process.env,
      NOVALAB_BRIDGE: '',
      NOVALAB_DATA_DIR: path.join(work, 'data'),
      WEBVIEW2_USER_DATA_FOLDER: path.join(work, 'webview2'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`[${label}!] ${d}`));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const app = { label, child, exited, browser: null, page: null, console: [] };
  launched.push(app);
  for (const r of await processes()) if (r.pid === child.pid) ownedSeen.set(r.pid, r.created);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok, `${label} CDP endpoint`, 60_000);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  app.browser = browser;
  await observeApp(app);
  const page = await waitFor(async () => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(appOrigin)), `${label} app page`, 60_000);
  app.page = page;
  page.on('pageerror', (error) => results.pageErrors.push(`${label}: ${error.message}`));
  app.ipc = [];
  page.on('request', (req) => { const m = /^https?:\/\/ipc\.localhost\/([^/?#]+)/.exec(req.url()); if (m) app.ipc.push(decodeURIComponent(m[1])); });
  page.on('console', (msg) => { if (app.console.length < 200) app.console.push(`${msg.type()}: ${msg.text()}`.slice(0, 300)); });
  await page.waitForLoadState('domcontentloaded');
  // The first connect is a single attempt by design (client.ts) and the store subscribes to status only
  // after it succeeds; the WebView usually loads before the dev bridge listens, leaving the window on the
  // "bridge 未连接 … 刷新" banner. Wait for this app's own bridge, then do what that banner says: reload.
  const own = await waitFor(async () => {
    const m = await bridgeManifest(work).catch(() => null);
    return m && (await observeApp(app)).some((r) => r.pid === m.pid) ? m : null;
  }, `${label} own bridge manifest`, 90_000);
  const bootConnected = await waitFor(() => page.evaluate(async () =>
    (await import('/src/store/notebook.ts')).useNotebook.getState().bridgeConnected === true), `${label} boot connect`, 15_000)
    .then(() => true, () => false);
  app.initialIdle = !bootConnected;
  if (app.initialIdle) await page.reload({ waitUntil: 'domcontentloaded' });
  console.log(`[${label}] bridge pid=${own.pid} up; boot connect ${bootConnected ? 'succeeded' : 'idle → reloaded'}`);
  await page.evaluate(async () => {
    const { useNotebook: nb } = await import('/src/store/notebook.ts');
    const { useNotebooks: tabs } = await import('/src/store/notebooks.ts');
    const { useI18nStore: i18n } = await import('/src/i18n/index.ts');
    const { bridge } = await import('/src/bridge/client.ts');
    i18n.getState().setLang('zh');
    const h = { nb, tabs, bridge, calls: [] };
    const original = bridge.rpc.bind(bridge);
    bridge.rpc = (method, params = {}) => { h.calls.push(method); return original(method, params); };
    window.__win = h;
  });
  try {
    await page.waitForFunction(() => window.__win.nb.getState().bridgeStatus === 'connected', undefined, { timeout: 90_000 });
  } catch (error) {
    const state = await page.evaluate(() => ({ url: location.href, status: window.__win?.nb.getState().bridgeStatus,
      connected: window.__win?.nb.getState().bridgeConnected, text: document.body.innerText.slice(0, 200),
      modules: performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /store\/notebook\.ts|bridge\/client\.ts/.test(n)) }))
      .catch((e) => ({ evalError: e.message }));
    console.log(`[${label}] not connected: ${JSON.stringify(state)}`);
    for (const line of app.console.slice(-40)) console.log(`[${label} console] ${line}`);
    throw error;
  }
  await observeApp(app);
  console.log(`[${label}] app pid=${child.pid} connected`);
  return app;
}

async function killApp(app) {
  if (!app || app.killed) return;
  app.killed = true;
  await app.browser?.close().catch(() => {}); // disconnects CDP only
  await observeApp(app).catch(() => {});
  await runFile('taskkill.exe', ['/PID', String(app.child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  await Promise.race([app.exited, delay(20_000)]);
}

async function bridgeManifest(work) {
  return JSON.parse(await readFile(path.join(work, 'data', 'bridge.json'), 'utf8'));
}

const overall = setTimeout(() => { console.error('smoke total timeout'); process.exit(2); }, TIMEOUT_MS);
const work = await mkdtemp(path.join(tmpdir(), 'novalab-tauri-window-smoke-'));
const nbDir = path.join(work, 'nb');
let app1;
let app2;
let failure;

try {
  assert.ok(existsSync(exe), 'debug desktop build missing (cargo build in app/src-tauri)');
  const busy = (await listeners()).filter((r) => (r.port >= 7788 && r.port <= 7798) || r.port === CDP_PORT);
  assert.deepEqual(busy, [], `discovery/CDP ports must be free so the window can only find its own bridge: ${JSON.stringify(busy)}`);
  assert.ok((await fetch('http://127.0.0.1:5199/').catch(() => null))?.ok, 'Vite must be serving this worktree on localhost:5199');

  await (await import('node:fs/promises')).mkdir(nbDir, { recursive: true });
  const aPath = path.join(nbDir, 'a.py');
  await writeFile(aPath, '# %% [cell-id: aaaaaaaa]\nx = 1\n\n# %% [cell-id: a2a2a2a2]\nw = x + 1\n', 'utf8');
  const aDisk = await readFile(aPath);

  app1 = await launchApp('app1', work);
  const m1 = await bridgeManifest(work);
  assert.ok((await observeApp(app1)).some((r) => r.pid === m1.pid), 'discovered bridge is a descendant of this app');
  await app1.page.evaluate(async (file) => { await window.__win.nb.getState().openNotebook(file); }, aPath);
  await app1.page.waitForFunction((file) => window.__win.nb.getState().notebookPath === file, aPath, { timeout: 60_000 });
  const tabBaseline = await app1.page.evaluate(() => window.__win.tabs.getState().activeTab()?.baselineSha256);
  assert.equal(tabBaseline, sha(aDisk));
  step('real window: a.py open on the app-owned bridge', { bridgePort: m1.wsPort, fingerprintMatchesDisk: true, initialConnectIdleThenReload: app1.initialIdle });

  // Bridge crash: kill only the bridge node process; the Rust supervisor must restart it.
  await runFile('taskkill.exe', ['/PID', String(m1.pid), '/F'], { windowsHide: true });
  await waitFor(async () => {
    const m = await bridgeManifest(work);
    return m.pid !== m1.pid && (await observeApp(app1)).some((r) => r.pid === m.pid) ? m : null;
  }, 'supervisor restart', 60_000);
  await app1.page.waitForFunction(() => {
    const h = window.__win;
    return h.nb.getState().bridgeStatus === 'connected' && h.tabs.getState().tabs.some((t) => t.bridgeLost);
  }, undefined, { timeout: 60_000 });
  step('Rust supervisor restarted the bridge; tab kept as bridge-lost (round 6 in a real window)');

  // Edit the bridge-lost tab: only the Tauri command can journal it.
  await app1.page.evaluate(() => window.__win.nb.getState().setCellCode('aaaaaaaa', 'x = 2  # typed while bridge-lost'));
  const journalName = await waitFor(async () => (await readdir(path.join(nbDir, '.novalab', 'drafts'))).find((n) => n.startsWith('a.py.') && n.endsWith('.draft.json')), 'offline journal', 15_000);
  const writers = {
    ipcSeen: [...new Set(app1.ipc)],
    invokes: app1.ipc.filter((c) => c === 'write_draft_journal').length,
    draftWrite: await app1.page.evaluate(() => window.__win.calls.filter((c) => c === 'draft.write').length),
  };
  console.log(`[app1] writers ${JSON.stringify(writers)}`);
  assert.ok(writers.invokes >= 1, 'journal written through the Rust command');
  assert.equal(writers.draftWrite, 0, 'bridge draft.write not used for a bridge-lost tab');
  const journal = JSON.parse(await readFile(path.join(nbDir, '.novalab', 'drafts', journalName), 'utf8'));
  assert.deepEqual(Object.keys(journal).sort(), ['baselineSha256', 'cells', 'dirtyCellIds', 'notebook', 'savedAt', 'version']);
  assert.equal(journal.baselineSha256, sha(aDisk), "journal carries the tab's last confirmed fingerprint");
  assert.deepEqual(journal.dirtyCellIds, ['aaaaaaaa']);
  assert.deepEqual(await readFile(aPath), aDisk);
  step('bridge-lost edit journaled by Rust write_draft_journal', { invokes: writers.invokes, draftWrite: 0 });

  // App death: the whole owned tree goes away; in-memory drafts are lost.
  await killApp(app1);
  await waitFor(async () => (await alive([...ownedSeen.keys()])).length === 0, 'app1 tree gone', 20_000);
  step('killed the whole app1 tree (WebView2, bridge, kernels)');

  app2 = await launchApp('app2', work);
  await app2.page.evaluate(async (file) => { await window.__win.nb.getState().openNotebook(file); }, aPath);
  await app2.page.locator('[data-testid="draft-recovery"][data-baseline-matches="true"]').waitFor({ state: 'visible', timeout: 60_000 });
  const before = await app2.page.evaluate(() => window.__win.nb.getState().cells[0]?.code);
  assert.equal(before, 'x = 1', 'nothing applied automatically');
  await app2.page.locator('[data-testid="draft-restore"]').click();
  await app2.page.waitForFunction(() => window.__win.nb.getState().cells[0]?.code === 'x = 2  # typed while bridge-lost');
  await delay(2_000);
  const restored = await app2.page.evaluate(() => ({
    dirty: window.__win.tabs.getState().activeTab()?.dirty,
    saves: window.__win.calls.filter((c) => c === 'cell.save').length,
    visible: document.body.innerText.includes('typed while bridge-lost'),
  }));
  assert.equal(restored.dirty, true);
  assert.equal(restored.saves, 0);
  assert.deepEqual(await readFile(aPath), aDisk, 'restore does not touch disk');
  step('relaunched app offers and restores the offline draft; disk untouched', restored);

  assert.deepEqual(results.pageErrors, [], `page errors: ${results.pageErrors.join('; ')}`);
} catch (error) {
  failure = error;
} finally {
  clearTimeout(overall);
  try {
    for (const app of launched.reverse()) await killApp(app);
    // An app that died first leaves its bridge tree without a live root: sweep every owned PID
    // (creation-time checked by alive()) so nothing this smoke started outlives it.
    for (const pid of await alive([...ownedSeen.keys()])) {
      await runFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    }
    let survivors = await alive([...ownedSeen.keys()]);
    const until = Date.now() + 15_000;
    while (survivors.length > 0 && Date.now() < until) {
      await delay(250);
      survivors = await alive(survivors);
    }
    results.ownedPidCount = ownedSeen.size;
    results.ownedSurvivors = survivors.length;
    assert.deepEqual(survivors, [], 'every owned app/WebView2/bridge/kernel PID must have exited');
    console.log('smoke cleanup: owned process trees exited');
  } catch (error) {
    failure = failure ? new Error(`${failure.message}; cleanup: ${error.message}`, { cause: failure }) : error;
  } finally {
    for (let i = 0; i < 20 && existsSync(work); i++) {
      await rm(work, { recursive: true, force: true }).catch(() => {});
      if (existsSync(work)) await delay(500); // WebView2 may release its profile files late
    }
    if (existsSync(work)) failure ??= new Error('smoke temp dir could not be removed');
    else console.log('smoke cleanup: temporary files removed');
  }
}
console.log(`TAURI_WINDOW_DRAFT_RESULTS ${JSON.stringify(results)}`);
if (failure) {
  console.error(failure);
  process.exit(1);
}
console.log('TAURI_WINDOW_DRAFT_SMOKE_OK');
