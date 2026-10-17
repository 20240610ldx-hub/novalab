#!/usr/bin/env node
/**
 * Real Chromium: cross-application bounded draft recovery (round 7, A15).
 *
 * gen-1: a.py and b.py are read-only, so every autosave fails and the edits stay unsaved
 * drafts (stand-in for "saving keeps failing"). After the journal debounce the bridge writes
 * them to <dir>/.novalab/drafts. Then the smoke kills ONLY its own gen-1 bridge PID and
 * closes the page (WebView gone), changes b.py on disk, starts an owned gen-2 bridge and a
 * fresh page:
 *   a.py (disk unchanged) → offer with matching fingerprint → user clicks restore → drafts back
 *       in the editor, no cell.save, disk bytes unchanged; a later normal save clears the journal.
 *   b.py (changed on disk) → offer without restore → user clicks "save as local copy" → round-4
 *       recovery copy next to the file holds the draft; b.py keeps the external bytes.
 * No provider, no credentials, no Owner data. Owned processes and the temp dir are removed.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import {
  alive, killBridgeOnly, launchBridge, observe, ownedSeen, processes, runFile, stopGen, windows,
} from './owned-bridge.mjs';

const appURL = process.argv[2] ?? 'http://127.0.0.1:5299/';
const appOrigin = new URL(appURL).origin;
const TIMEOUT_MS = 240_000;
const results = { steps: [], pageErrors: [] };
const step = (name, detail = {}) => {
  results.steps.push({ name, ...detail });
  console.log(`[step] ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Saves must fail but .novalab/drafts must stay writable. */
async function setReadOnly(dir, files, readOnly) {
  if (windows) {
    for (const file of files) await runFile('attrib.exe', [readOnly ? '+r' : '-r', file], { windowsHide: true });
  } else {
    await chmod(dir, readOnly ? 0o555 : 0o755); // atomic replace needs a writable directory
  }
}

async function journalFiles(dir, notebook) {
  try {
    return (await readdir(path.join(dir, '.novalab', 'drafts'))).filter((n) => n.startsWith(`${notebook}.`) && n.endsWith('.draft.json'));
  } catch {
    return [];
  }
}

async function waitFor(predicate, label, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await delay(100);
  }
}

async function newPage(browser, getActive, notebook) {
  const page = await browser.newPage();
  page.on('pageerror', (error) => results.pageErrors.push(error.message));
  page.on('dialog', (dialog) => dialog.dismiss());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/bridge-info' && ['127.0.0.1', 'localhost'].includes(url.hostname)) {
      const active = getActive();
      if (!active) return route.abort('connectionrefused');
      return route.fulfill({ status: 200, headers: {
        'Content-Type': 'application/json', 'Access-Control-Allow-Origin': appOrigin,
      }, body: JSON.stringify(active) });
    }
    if (url.origin === appOrigin) return route.continue();
    const active = getActive();
    if (active && url.origin === active.llmProxyOrigin) return route.continue();
    return route.abort();
  });
  await page.goto(`${appURL}?path=${encodeURIComponent(notebook)}`);
  await page.evaluate(async () => {
    const { useNotebook: nb } = await import('/src/store/notebook.ts');
    const { useNotebooks: tabs } = await import('/src/store/notebooks.ts');
    const { useI18nStore: i18n } = await import('/src/i18n/index.ts');
    const { bridge } = await import('/src/bridge/client.ts');
    i18n.getState().setLang('zh');
    const h = { nb, tabs, bridge, calls: [] };
    const original = bridge.rpc.bind(bridge);
    bridge.rpc = (method, params = {}) => {
      h.calls.push({ method, params: method.startsWith('draft.') ? params : undefined });
      return original(method, params);
    };
    window.__drafts = h;
  });
  await page.waitForFunction((file) => window.__drafts.nb.getState().notebookPath === file
    && window.__drafts.nb.getState().cells.length > 0, notebook, { timeout: 30_000 });
  return page;
}

const controller = new AbortController();
const overall = setTimeout(() => controller.abort(new Error(`smoke 总超时 (${TIMEOUT_MS}ms)`)), TIMEOUT_MS);
const browser = await chromium.launch({ headless: true });
const work = await mkdtemp(path.join(tmpdir(), 'novalab-draft-recovery-smoke-'));
const nbDir = path.join(work, 'nb');
let gen1;
let gen2;
let failure;

try {
  await mkdir(path.join(nbDir, '.novalab', 'drafts'), { recursive: true });
  const aPath = path.join(nbDir, 'a.py');
  const bPath = path.join(nbDir, 'b.py');
  // Output text is computed so it never appears literally in the source/journal.
  const aSource = '# %% [cell-id: aaaaaaaa]\nx = 1\nprint("OUT" + "PUT_" + "MARK")\n\n# %% [cell-id: a2a2a2a2]\nw = x + 1\n';
  const bSource = '# %% [cell-id: bbbbbbbb]\nz = 1\n';
  await writeFile(aPath, aSource, 'utf8');
  await writeFile(bPath, bSource, 'utf8');
  const aDisk = await readFile(aPath);

  gen1 = await launchBridge('gen1', work, controller.signal);
  let active = gen1.info;
  let page = await newPage(browser, () => active, aPath);

  // Real outputs and a REPL variable exist in memory; none of them may reach the journal.
  await page.evaluate(async () => {
    const s = window.__drafts.nb.getState();
    await s.runCell('aaaaaaaa');
    await s.runRepl('secret_repl_value = 40 + 2');
  });
  await page.waitForFunction(() => window.__drafts.nb.getState().cells[0]?.output?.stdout?.includes('OUTPUT_MARK'));
  await setReadOnly(nbDir, [aPath, bPath], true);

  // Edit A: autosave fails (read-only) → draft stays → journal after the debounce.
  await page.evaluate(() => window.__drafts.nb.getState().setCellCode('aaaaaaaa', 'x = 2  # unsaved draft A\nprint("OUT" + "PUT_" + "MARK")'));
  const aJournalName = (await waitFor(async () => (await journalFiles(nbDir, 'a.py'))[0], 'a.py journal'));
  const aSave = await page.evaluate(() => {
    const h = window.__drafts;
    const tab = h.tabs.getState().tabs.find((t) => t.path.endsWith('a.py'));
    return { error: tab?.error?.operation, dirty: tab?.dirty, saves: h.calls.filter((c) => c.method === 'cell.save').length };
  });
  assert.equal(aSave.error, 'save', 'autosave must have failed on the read-only file');
  assert.equal(aSave.dirty, true);
  assert.ok(aSave.saves >= 1);
  const aJournal = JSON.parse(await readFile(path.join(nbDir, '.novalab', 'drafts', aJournalName), 'utf8'));
  assert.deepEqual(Object.keys(aJournal).sort(), ['baselineSha256', 'cells', 'dirtyCellIds', 'notebook', 'savedAt', 'version']);
  assert.equal(aJournal.baselineSha256, sha(aDisk), 'journal records the real disk fingerprint');
  assert.deepEqual(aJournal.dirtyCellIds, ['aaaaaaaa']);
  assert.deepEqual(aJournal.cells.map((c) => Object.keys(c).sort().join()), ['code,id', 'code,id']);
  assert.ok(aJournal.cells[0].code.includes('unsaved draft A'));
  const aJournalText = JSON.stringify(aJournal);
  assert.ok(!aJournalText.includes('OUTPUT_MARK') && !aJournalText.includes('secret_repl_value'), 'no outputs or REPL in the journal');
  assert.deepEqual(await readFile(aPath), aDisk, 'a.py untouched');
  step('gen1: failed autosave → bounded journal next to the notebook', { file: 'a.py', baselineMatchesDisk: true, outputsOrRepl: false });

  // Edit B the same way.
  await page.evaluate(async (file) => { await window.__drafts.nb.getState().openNotebook(file); }, bPath);
  await page.waitForFunction((file) => window.__drafts.nb.getState().notebookPath === file, bPath);
  await page.evaluate(() => window.__drafts.nb.getState().setCellCode('bbbbbbbb', 'z = 2  # unsaved draft B'));
  await waitFor(async () => (await journalFiles(nbDir, 'b.py'))[0], 'b.py journal');
  assert.equal(await readFile(bPath, 'utf8'), bSource);
  await observe(gen1);
  step('gen1: second notebook journaled', { file: 'b.py' });

  // Bridge dies and the page (WebView) goes away: in-memory drafts are gone.
  active = null;
  await killBridgeOnly(gen1);
  await page.close();
  await Promise.race([gen1.closed, delay(20_000).then(() => { throw new Error('gen1 launcher did not exit'); })]);
  gen1.stopped = true;
  if (windows) assert.equal(gen1.child.jobEmpty, true, 'gen1 Job must report no remaining processes');
  step('killed owned gen1 bridge and closed the page', { jobEmpty: gen1.child.jobEmpty ?? null });

  // While the app is gone: b.py changes on disk; a.py does not (read-only flag dropped on both).
  await setReadOnly(nbDir, [aPath, bPath], false);
  const bExternal = '# %% [cell-id: bbbbbbbb]\nz = 300  # external edit while the app was closed\n';
  await writeFile(bPath, bExternal, 'utf8');

  await rm(path.join(work, 'data', 'bridge.json'), { force: true });
  gen2 = await launchBridge('gen2', work, controller.signal);
  active = gen2.info;
  page = await newPage(browser, () => active, aPath);

  // A: offered, never applied automatically.
  await page.locator('[data-testid="draft-recovery"][data-baseline-matches="true"]').waitFor({ state: 'visible', timeout: 15_000 });
  await delay(2_000); // > both debounces: an automatic apply/save would show up here
  const offered = await page.evaluate(() => {
    const h = window.__drafts;
    return { code: h.nb.getState().cells[0]?.code, saves: h.calls.filter((c) => c.method === 'cell.save').length,
      restoreButton: !!document.querySelector('[data-testid="draft-restore"]') };
  });
  assert.equal(offered.code, 'x = 1\nprint("OUT" + "PUT_" + "MARK")', 'disk version stays in the editor until the user chooses');
  assert.equal(offered.saves, 0);
  assert.equal(offered.restoreButton, true);
  assert.deepEqual(await readFile(aPath), aDisk);
  step('gen2: a.py offers recovery (fingerprint matches), nothing applied', { autoApplied: false });

  await page.locator('[data-testid="draft-restore"]').click();
  await page.waitForFunction(() => window.__drafts.nb.getState().cells[0]?.code.includes('unsaved draft A'));
  await delay(2_000);
  const restored = await page.evaluate(() => {
    const h = window.__drafts;
    const tab = h.tabs.getState().tabs.find((t) => t.path.endsWith('a.py'));
    return { dirty: tab?.dirty, offer: !!tab?.draftRecovery, saves: h.calls.filter((c) => c.method === 'cell.save').length,
      visible: document.body.innerText.includes('unsaved draft A') };
  });
  assert.equal(restored.dirty, true);
  assert.equal(restored.offer, false);
  assert.equal(restored.saves, 0, 'restore sends no cell.save');
  assert.deepEqual(await readFile(aPath), aDisk, 'restore does not touch disk');
  assert.equal((await journalFiles(nbDir, 'a.py')).length, 1, 'journal kept until a save succeeds');
  step('restore → drafts back in the editor, disk untouched', { dirty: true, cellSave: 0, visible: restored.visible });

  // A normal save afterwards (user keeps editing) clears the journal (Owner: delete once saved).
  await page.evaluate(() => window.__drafts.nb.getState().setCellCode('aaaaaaaa', 'x = 3  # saved after recovery\nprint("OUT" + "PUT_" + "MARK")'));
  await waitFor(async () => (await readFile(aPath, 'utf8')).includes('saved after recovery'), 'a.py saved');
  await waitFor(async () => (await journalFiles(nbDir, 'a.py')).length === 0, 'a.py journal cleared');
  step('next successful save clears the journal', { journalCopies: 0 });

  // B: disk changed → no restore, only a local copy.
  await page.evaluate(async (file) => { await window.__drafts.nb.getState().openNotebook(file); }, bPath);
  await page.locator('[data-testid="draft-recovery"][data-baseline-matches="false"]').waitFor({ state: 'visible', timeout: 15_000 });
  const bOffer = await page.evaluate(() => ({
    code: window.__drafts.nb.getState().cells[0]?.code,
    restoreButton: !!document.querySelector('[data-testid="draft-restore"]'),
  }));
  assert.equal(bOffer.code, 'z = 300  # external edit while the app was closed');
  assert.equal(bOffer.restoreButton, false, 'no restore onto a changed file');
  await page.locator('[data-testid="draft-preserve"]').click();
  const recoveryPath = await page.waitForFunction((file) => {
    const tab = window.__drafts.tabs.getState().tabs.find((t) => t.path === file);
    return tab && !tab.draftRecovery && tab.recoveryPath;
  }, bPath).then((handle) => handle.jsonValue());
  const sameDir = (x, y) => (windows ? x.toLowerCase() === y.toLowerCase() : x === y); // kernel paths are normcase'd on Windows
  assert.ok(sameDir(path.dirname(recoveryPath), nbDir), 'copy sits next to the notebook');
  assert.ok((await readFile(recoveryPath, 'utf8')).includes('z = 2  # unsaved draft B'), 'copy holds the draft');
  assert.equal(await readFile(bPath, 'utf8'), bExternal, 'b.py keeps the external bytes');
  assert.equal((await journalFiles(nbDir, 'b.py')).length, 0, 'journal cleared after the copy');
  const bCalls = await page.evaluate(() => window.__drafts.calls.filter((c) => c.method === 'cell.save').length);
  step('changed disk → local recovery copy, notebook untouched', { copyHasDraft: true, cellSaveTotal: bCalls });

  await observe(gen2);
  assert.deepEqual(results.pageErrors, [], `page errors: ${results.pageErrors.join('; ')}`);
  await page.close();
} catch (error) {
  failure = error;
} finally {
  clearTimeout(overall);
  await browser.close().catch(() => {});
  try {
    if (!windows) await chmod(nbDir, 0o755).catch(() => {});
    await stopGen(gen2);
    await stopGen(gen1);
    const leftovers = (await processes()).filter((r) => r.command.includes(work));
    assert.deepEqual(leftovers.map((r) => r.pid), [], 'no process may still reference the smoke work dir');
    let survivors = await alive([...ownedSeen.keys()]);
    const exitDeadline = Date.now() + 10_000;
    while (survivors.length > 0 && Date.now() < exitDeadline) {
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
    if (windows) await runFile('attrib.exe', ['-r', '/s', path.join(work, '*')], { windowsHide: true }).catch(() => {});
    await rm(work, { recursive: true, force: true }).catch(() => {});
    if (existsSync(work)) failure ??= new Error('smoke temp dir could not be removed');
    else console.log('smoke cleanup: temporary files removed');
  }
}
console.log(`DRAFT_RECOVERY_RESULTS ${JSON.stringify(results)}`);
if (failure) {
  console.error(failure);
  process.exit(1);
}
console.log('DRAFT_RECOVERY_SMOKE_OK');
