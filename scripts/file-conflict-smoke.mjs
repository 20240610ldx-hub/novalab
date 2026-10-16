#!/usr/bin/env node
/** Real Chromium + owned bridge + disposable files: preserve both sides of external edits. */
import assert from 'node:assert/strict';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { withSmokeBridge } from './smoke-runtime.mjs';

const appOrigin = new URL(process.argv[2] ?? 'http://127.0.0.1:5299/').origin;
const original = '# %% [cell-id: aaaaaaaa]\nx = 1\nprint("OLD_OUTPUT")\nx\n\n# %% [cell-id: bbbbbbbb]\ny = x + 1\n';
const external = '# %% [cell-id: aaaaaaaa]\nx = 9\n\n# %% [cell-id: bbbbbbbb]\ny = x + 99\n\n# %% [cell-id: cccccccc]\nz = y + 1\n';
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  await withSmokeBridge(original, async ({ bridge: nodeBridge, notebookPath }) => {
    const secondPath = path.join(path.dirname(notebookPath), 'second.py');
    await writeFile(secondPath, '# %% [cell-id: aaaaaaaa]\nx = 100\nx\n', 'utf8');
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/bridge-info' && ['127.0.0.1', 'localhost'].includes(url.hostname)) {
        return route.fulfill({ status: 200, headers: {
          'Content-Type': 'application/json', 'Access-Control-Allow-Origin': appOrigin,
        }, body: JSON.stringify(nodeBridge.info) });
      }
      if (url.origin === appOrigin || url.origin === nodeBridge.info.llmProxyOrigin) return route.continue();
      return route.abort();
    });
    await page.goto(`${appOrigin}/?path=${encodeURIComponent(notebookPath)}`);
    await page.evaluate(async () => {
      const { useNotebook: nb } = await import('/src/store/notebook.ts');
      const { useNotebooks: tabs } = await import('/src/store/notebooks.ts');
      const { useSession: session } = await import('/src/store/session.ts');
      const { bridge } = await import('/src/bridge/client.ts');
      window.__conflictAcceptance = { nb, tabs, session, bridge };
    });
    await page.waitForFunction((file) => {
      const h = window.__conflictAcceptance;
      return h.nb.getState().notebookPath === file && h.nb.getState().cells.length === 2 && h.tabs.getState().activeId;
    }, notebookPath);
    await page.evaluate(async (file) => {
      const h = window.__conflictAcceptance;
      h.firstId = h.tabs.getState().activeId;
      await h.nb.getState().runCell('aaaaaaaa');
      await h.nb.getState().runRepl('print("OLD_REPL")');
      // Delay autosave while arranging the background conflict; explicit close still flushes.
      h.originalSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => h.originalSetTimeout(callback, delay === 300 ? 60_000 : delay, ...args);
      h.nb.getState().setCellCode('aaaaaaaa', 'x = 2');
      await h.nb.getState().openNotebook(file);
      h.secondId = h.tabs.getState().activeId;
      await h.nb.getState().runCell('aaaaaaaa');
    }, secondPath);
    await page.waitForFunction((file) => {
      const s = window.__conflictAcceptance.session.getState();
      return s.sessions.some((item) => item.id === s.currentId && item.notebookPath === file && !item.endedAt);
    }, secondPath);
    const secondSession = await page.evaluate(() => window.__conflictAcceptance.session.getState().currentId);
    await writeFile(notebookPath, external, 'utf8');
    const retained = await page.evaluate(async () => {
      const h = window.__conflictAcceptance;
      await h.nb.getState().closeTab(h.firstId);
      const tab = h.tabs.getState().tabs.find((item) => item.notebookId === h.firstId);
      return { exists: Boolean(tab), dirty: tab?.dirty, conflict: tab?.conflict,
        localCode: h.tabs.getState().readCache(h.firstId)?.cells.find((cell) => cell.id === 'aaaaaaaa')?.code,
        activeId: h.tabs.getState().activeId, cells: h.nb.getState().cells.map((cell) => cell.code),
        currentId: h.session.getState().currentId };
    });
    assert.equal(retained.exists, true);
    assert.equal(retained.dirty, true);
    assert.equal(retained.localCode, 'x = 2');
    assert.equal(retained.currentId, secondSession);
    assert.deepEqual(retained.cells, ['x = 100\nx']);
    assert.equal(await readFile(notebookPath, 'utf8'), external);
    assert.ok(retained.conflict?.recoveryPath);
    assert.match(await readFile(retained.conflict.recoveryPath, 'utf8'), /x = 2/);
    console.log('conflict acceptance: background close refuses overwrite, keeps local draft/recovery and current notebook session');

    await page.getByRole('button', { name: '保留本地副本并加载磁盘版本', exact: true }).click();
    await page.waitForFunction(() => {
      const h = window.__conflictAcceptance;
      const tab = h.tabs.getState().tabs.find((item) => item.notebookId === h.firstId);
      return tab && !tab.conflict && !tab.reloading && !tab.dirty;
    });
    assert.deepEqual(await page.evaluate(() => {
      const h = window.__conflictAcceptance;
      return { activeId: h.tabs.getState().activeId === h.secondId, code: h.nb.getState().cells[0]?.code,
        currentId: h.session.getState().currentId };
    }), { activeId: true, code: 'x = 100\nx', currentId: secondSession });
    await page.evaluate(async () => {
      const h = window.__conflictAcceptance;
      await h.nb.getState().switchTab(h.firstId);
    });
    const cold = await page.evaluate(() => {
      const h = window.__conflictAcceptance;
      return h.nb.getState().cells.map((cell) => ({ id: cell.id, code: cell.code, count: cell.execCount,
        output: cell.output }));
    });
    assert.deepEqual(cold.map((cell) => cell.id), ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']);
    assert.equal(cold[0].code, 'x = 9');
    assert.ok(cold.every((cell) => cell.count === 0 || cell.count === null));
    assert.ok(cold.every((cell) => cell.output === null), 'cold cells have no previous output');
    assert.equal(await readFile(notebookPath, 'utf8'), external);
    console.log('conflict acceptance: explicit background reload preserves focus/session and cold-loads disk without old outputs or REPL');

    await page.evaluate(() => { window.setTimeout = window.__conflictAcceptance.originalSetTimeout; });
    // Let the production self-write suppression window expire before testing a watcher event.
    await page.waitForTimeout(650);
    // A real watcher event must notify without loading over the visible local source.
    const laterExternal = external.replace('x = 9', 'x = 10');
    await writeFile(notebookPath, laterExternal, 'utf8');
    await page.waitForFunction(() => {
      const h = window.__conflictAcceptance;
      return Boolean(h.tabs.getState().tabs.find((item) => item.notebookId === h.firstId)?.conflict);
    });
    assert.equal(await page.evaluate(() => window.__conflictAcceptance.nb.getState().cells[0]?.code), 'x = 9');
    await page.locator('[data-cell-id="aaaaaaaa"] .cm-content').fill('x = 12');
    await page.waitForFunction(() => window.__conflictAcceptance.nb.getState().cells[0]?.code === 'x = 12');
    const moved = `${notebookPath}.external`;
    await rename(notebookPath, moved);
    try {
      await page.getByRole('button', { name: '保留本地副本并加载磁盘版本', exact: true }).click();
      await page.waitForFunction(() => {
        const h = window.__conflictAcceptance;
        const tab = h.tabs.getState().tabs.find((item) => item.notebookId === h.firstId);
        return tab?.conflict?.message && !tab.reloading;
      });
      assert.equal(await page.evaluate(() => window.__conflictAcceptance.nb.getState().cells[0]?.code), 'x = 12');
      assert.equal(await readFile(moved, 'utf8'), laterExternal);
    } finally {
      await rename(moved, notebookPath);
    }
    await page.getByRole('button', { name: '保留本地副本并加载磁盘版本', exact: true }).click();
    await page.waitForFunction(() => {
      const h = window.__conflictAcceptance;
      return !h.tabs.getState().tabs.find((item) => item.notebookId === h.firstId)?.conflict && h.nb.getState().cells[0]?.code === 'x = 10';
    });
    const recoveryPath = await page.evaluate(() => {
      const h = window.__conflictAcceptance;
      return h.tabs.getState().tabs.find((item) => item.notebookId === h.firstId)?.recoveryPath;
    });
    assert.ok(recoveryPath);
    const recoverySource = await readFile(recoveryPath, 'utf8');
    assert.match(recoverySource, /x = 12/);
    assert.doesNotMatch(recoverySource, /OLD_REPL/);
    assert.equal(await readFile(notebookPath, 'utf8'), laterExternal);
    const reopened = await nodeBridge.rpc('notebook.open', { path: recoveryPath });
    assert.deepEqual(reopened.state.cells.map((cell) => cell.id), ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']);
    assert.equal(reopened.state.cells[0].code, 'x = 12');
    assert.ok(Object.values(reopened.state.execCounts).every((count) => count === 0));
    assert.deepEqual(errors, []);
    await page.close();
    console.log('conflict acceptance: watcher preserves local code; failed disk load retains draft; explicit retry keeps latest local backup and external bytes');
  }, { timeoutMs: 120_000 });
  console.log('FILE_CONFLICT_SMOKE_OK');
} finally {
  await browser.close();
}
