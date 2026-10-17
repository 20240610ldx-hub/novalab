#!/usr/bin/env node
/**
 * Real Chromium + owned bridge/kernel acceptance for the agent-safety package:
 *  1. execute_cell interim confirmation — agent.executeCell shows a dialog in the page;
 *     Deny runs nothing, Allow runs the cell (the Node client stands in for the agent tool host).
 *  2. F2 diff queue — a definition move is queued with dependsOn, the page shows the
 *     dependency chip, an out-of-order Accept is refused with an inline error, in-order Accept lands.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { withSmokeBridge } from './smoke-runtime.mjs';

const appURL = process.argv[2] ?? 'http://127.0.0.1:5299/';
const appOrigin = new URL(appURL).origin;
const HELPER = 'def helper(v):\n    return v + 1';
/** ADR-013：未经影子运行的改动照常入队，只标注 unverified（软约束）。 */
const UNVERIFIED = { status: 'unverified', level: 'V1', missing: ['shadow_run'] };
const fixture = `# %% [cell-id: aaaaaaaa]\n${HELPER}\n\ny = helper(1)\nprint("RAN", y)\n\n# %% [cell-id: bbbbbbbb]\nz = y * 2\n`;
const browser = await chromium.launch({ headless: true });
const errors = [];

try {
  await withSmokeBridge(fixture, async ({ bridge: agent, notebookPath }) => {
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/bridge-info' && ['127.0.0.1', 'localhost'].includes(url.hostname)) {
        return route.fulfill({ status: 200, headers: {
          'Content-Type': 'application/json', 'Access-Control-Allow-Origin': appOrigin,
        }, body: JSON.stringify(agent.info) });
      }
      if (url.origin === appOrigin || url.origin === agent.info.llmProxyOrigin) return route.continue();
      return route.abort();
    });
    await page.goto(`${appURL}?path=${encodeURIComponent(notebookPath)}`);
    await page.evaluate(async () => {
      const { useNotebook: nb } = await import('/src/store/notebook.ts');
      window.__safety = { nb };
    });
    await page.waitForFunction((file) => {
      const s = window.__safety.nb.getState();
      return s.notebookPath === file && s.cells.length === 2 && s.bridgeConnected;
    }, notebookPath);
    const execCount = () => page.evaluate(() => window.__safety.nb.getState().cells.find((c) => c.id === 'aaaaaaaa')?.execCount ?? null);
    const before = await execCount();

    // ---- 1a. Deny: dialog shows the exact source; nothing runs ----
    const dialog = page.getByTestId('run-confirm-dialog');
    const denied = agent.rpc('agent.executeCell', { cellId: 'aaaaaaaa' });
    await dialog.waitFor({ state: 'visible' });
    assert.ok((await dialog.locator('pre').textContent()).includes('y = helper(1)'), 'dialog must show the cell source');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'run-confirm-deny', 'default focus is Deny');
    await page.getByTestId('run-confirm-deny').click();
    assert.deepEqual(await denied, {
      denied: true,
      reason: 'user-declined',
      message: 'The user declined to run this cell, so nothing was executed.',
    });
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await execCount(), before, 'denied run must not execute');

    // ---- 1b. Allow: the cell runs in the user kernel ----
    const allowed = agent.rpc('agent.executeCell', { cellId: 'aaaaaaaa' });
    await dialog.waitFor({ state: 'visible' });
    await page.getByTestId('run-confirm-allow').click();
    const report = await allowed;
    assert.equal(report.cellId, 'aaaaaaaa');
    assert.equal(report.ok, true);
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction((n) => (window.__safety.nb.getState().cells.find((c) => c.id === 'aaaaaaaa')?.execCount ?? 0) > (n ?? 0), before);

    // ---- 2. F2: move helper into its own cell via two queued diffs ----
    assert.deepEqual(await agent.rpc('diff.stage', { targetCellId: 'aaaaaaaa', action: 'update', newCode: 'y = helper(1)\nprint("RAN", y)' }), { diffId: 'diff-1', verification: UNVERIFIED });
    assert.deepEqual(await agent.rpc('diff.stage', { targetCellId: 'aaaaaaaa', action: 'insert_below', newCode: HELPER }), { diffId: 'diff-2', dependsOn: ['diff-1'], verification: UNVERIFIED });
    const chip = page.getByTestId('diff-depends-on');
    await chip.waitFor({ state: 'visible' });
    assert.equal((await chip.textContent()).trim(), '依赖 diff-1');

    await page.evaluate(() => window.__safety.nb.getState().acceptDiff('diff-2'));
    const acceptError = page.getByTestId('diff-accept-error');
    await acceptError.waitFor({ state: 'visible' });
    assert.match(await acceptError.textContent(), /accept diff-1 first/);
    assert.equal(await page.evaluate(() => window.__safety.nb.getState().cells.length), 2, 'refused accept must not change the notebook');

    await page.evaluate(async () => {
      await window.__safety.nb.getState().acceptDiff('diff-1');
      await window.__safety.nb.getState().acceptDiff('diff-2');
    });
    await page.waitForFunction(() => {
      const s = window.__safety.nb.getState();
      return s.cells.length === 3 && s.cells.some((c) => c.code === 'def helper(v):\n    return v + 1') && s.diffs.every((d) => d.state === 'accepted');
    });
    const code = await agent.rpc('agent.cellCode', { cellId: 'aaaaaaaa' });
    assert.equal(code.code, 'y = helper(1)\nprint("RAN", y)');
    assert.equal(errors.length, 0, `page errors: ${errors.join('; ')}`);
    await page.close();
  }, { timeoutMs: 180_000 });
  console.log('AGENT_SAFETY_SMOKE_OK');
} finally {
  await browser.close();
}
