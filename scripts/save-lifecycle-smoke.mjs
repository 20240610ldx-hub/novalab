#!/usr/bin/env node
/** Browser + real-file acceptance of notebook-bound saving and close recovery.
 * Start the Vite app with the preview launcher, then pass its URL. The owned
 * Bridge and notebook/data fixtures use a private temporary directory. Discovery
 * is routed to that exact child, so no existing local Bridge is contacted.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { withSmokeBridge } from './smoke-runtime.mjs';

const appURL = process.argv[2] ?? 'http://127.0.0.1:5299/';
const appOrigin = new URL(appURL).origin;
const fixture = '# %% [cell-id: aaaaaaaa]\nx = 1\n\n# %% [cell-id: bbbbbbbb]\ny = x + 1\n';
const browser = await chromium.launch({ headless: true });
const errors = [];

try {
  await withSmokeBridge(fixture, async ({ bridge: nodeBridge, notebookPath }) => {
    const secondPath = path.join(path.dirname(notebookPath), 'second.py');
    await writeFile(secondPath, '# %% [cell-id: aaaaaaaa]\nx = 100\n', 'utf8');
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/bridge-info' && ['127.0.0.1', 'localhost'].includes(url.hostname)) {
        return route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': appOrigin },
          body: JSON.stringify(nodeBridge.info),
        });
      }
      if (url.origin === appOrigin || url.origin === nodeBridge.info.llmProxyOrigin) return route.continue();
      return route.abort();
    });
    await page.goto(`${appOrigin}/?path=${encodeURIComponent(notebookPath)}`);
    await page.evaluate(async () => {
      const { useNotebook } = await import('/src/store/notebook.ts');
      const { useNotebooks } = await import('/src/store/notebooks.ts');
      const { bridge } = await import('/src/bridge/client.ts');
      window.__saveAcceptance = { nb: useNotebook, tabs: useNotebooks, bridge };
    });
    try {
      await page.waitForFunction((file) => {
        const { nb, tabs } = window.__saveAcceptance;
        return nb.getState().notebookPath === file && tabs.getState().activeId && nb.getState().cells.length === 2;
      }, notebookPath);
    } catch (error) {
      console.error('save acceptance open state:', await page.evaluate(() => {
        const { nb, tabs } = window.__saveAcceptance;
        return { connected: nb.getState().bridgeConnected, notebookPath: nb.getState().notebookPath,
          activeId: tabs.getState().activeId, cells: nb.getState().cells.map((c) => ({ id: c.id, code: c.code })),
          pageText: document.body.innerText.slice(0, 1200) };
      }));
      throw error;
    }

    // Hold only the first real save ACK; Python has completed it before release.
    await page.evaluate(async () => {
      const h = window.__saveAcceptance;
      h.firstId = h.tabs.getState().activeId;
      h.originalRpc = h.bridge.rpc.bind(h.bridge);
      // Keep autosave pending deterministically during the ACK interleaving.
      // The later CodeMirror/close case uses the normal production delay.
      h.originalSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => h.originalSetTimeout(callback, delay === 300 ? 60_000 : delay, ...args);
      let held = false;
      h.release = null;
      const gate = new Promise((resolve) => { h.release = resolve; });
      h.bridge.rpc = async (method, params = {}) => {
        const result = await h.originalRpc(method, params);
        if (!held && method === 'cell.save' && params.notebookId === h.firstId && params.code === 'x = 2') {
          held = true;
          h.ackHeld = true;
          await gate;
        }
        return result;
      };
      h.nb.getState().setCellCode('aaaaaaaa', 'x = 2');
      h.firstSave = h.nb.getState().saveCell('aaaaaaaa', 'x = 2');
    });
    await page.waitForFunction(() => window.__saveAcceptance.ackHeld === true);
    const beforeRelease = await page.evaluate(() => {
      const h = window.__saveAcceptance;
      h.nb.getState().setCellCode('aaaaaaaa', 'x = 3');
      return h.tabs.getState().tabs.find((tab) => tab.notebookId === h.firstId).dirty;
    });
    assert.equal(beforeRelease, true);
    const staleAck = await page.evaluate(async () => {
      const h = window.__saveAcceptance;
      h.release();
      await h.firstSave;
      return {
        code: h.nb.getState().cells.find((cell) => cell.id === 'aaaaaaaa').code,
        dirty: h.tabs.getState().tabs.find((tab) => tab.notebookId === h.firstId).dirty,
      };
    });
    assert.deepEqual(staleAck, { code: 'x = 3', dirty: true }, 'old ACK must not confirm a newer draft');

    // Same cell IDs across tabs must still save to their originating notebook.
    await page.evaluate(async ({ secondPath }) => {
      const h = window.__saveAcceptance;
      h.bridge.rpc = h.originalRpc;
      await h.nb.getState().openNotebook(secondPath);
      h.secondId = h.tabs.getState().activeId;
      h.nb.getState().setCellCode('aaaaaaaa', 'x = 101');
      await h.nb.getState().saveCell('aaaaaaaa', 'x = 101');
      await h.nb.getState().closeTab(h.firstId);
    }, { secondPath });
    assert.match(await readFile(notebookPath, 'utf8'), /x = 3/);
    assert.match(await readFile(secondPath, 'utf8'), /x = 101/);
    console.log('save acceptance: stale ACK stays dirty; background close flushes its latest draft; same-ID second notebook remains intact');

    await page.evaluate(() => { window.setTimeout = window.__saveAcceptance.originalSetTimeout; });
    // Exercise CodeMirror -> store debounce -> actual close-button wiring.
    await page.locator('[data-cell-id="aaaaaaaa"] .cm-content').fill('x = 102');
    await page.waitForFunction(() => window.__saveAcceptance.nb.getState().cells[0]?.code === 'x = 102');
    await page.getByRole('button', { name: 'close second.py', exact: true }).click();
    await page.waitForFunction(() => window.__saveAcceptance.tabs.getState().tabs.length === 0);
    assert.match(await readFile(secondPath, 'utf8'), /x = 102/);
    console.log('save acceptance: CodeMirror edit followed by UI close persists latest code');
    await page.evaluate(async (file) => {
      const h = window.__saveAcceptance;
      await h.nb.getState().openNotebook(file);
      h.secondId = h.tabs.getState().activeId;
    }, secondPath);

    // Real filesystem failure is limited to this run's disposable fixture.
    const backup = `${secondPath}.saved`;
    await rename(secondPath, backup);
    await mkdir(secondPath);
    try {
      await page.evaluate(async () => {
        const h = window.__saveAcceptance;
        h.nb.getState().setCellCode('aaaaaaaa', 'x = 103');
        await h.nb.getState().closeTab(h.secondId);
      });
      const retained = await page.evaluate(() => {
        const h = window.__saveAcceptance;
        const tab = h.tabs.getState().tabs.find((tab) => tab.notebookId === h.secondId);
        return { exists: Boolean(tab), dirty: tab?.dirty, code: h.nb.getState().cells.find((cell) => cell.id === 'aaaaaaaa')?.code };
      });
      assert.deepEqual(retained, { exists: true, dirty: true, code: 'x = 103' }, 'failed save/close must retain the draft and tab');
      assert.match(await readFile(backup, 'utf8'), /x = 102/);
      await page.getByRole('alert').waitFor();
    } finally {
      await rmdir(secondPath);
      await rename(backup, secondPath);
    }
    await page.getByRole('alert').getByRole('button', { name: /retry|重试/i }).click();
    await page.waitForFunction(() => window.__saveAcceptance.tabs.getState().tabs.length === 0);
    assert.match(await readFile(secondPath, 'utf8'), /x = 103/);
    const finalTabs = await page.evaluate(() => window.__saveAcceptance.tabs.getState().tabs.length);
    assert.equal(finalTabs, 0, 'retry closes only after the latest draft is persisted');
    assert.deepEqual(errors, [], 'no page runtime errors');
    await page.close();
    console.log('save acceptance: filesystem failure preserves tab/draft and visible error; retry writes latest code before closing');
  }, { timeoutMs: 120_000 });
  console.log('SAVE_LIFECYCLE_SMOKE_OK');
} finally {
  await browser.close();
}
