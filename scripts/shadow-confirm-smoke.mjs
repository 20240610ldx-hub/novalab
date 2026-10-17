#!/usr/bin/env node
/**
 * Real Chromium + owned bridge/kernel/shadow acceptance for ADR-013 S1/S2:
 *  1. Per-turn shadow confirmation (O1 = b) — the first shadow.run of a turn shows the shadow dialog
 *     (change summary + "your kernel and files won't be changed"); Deny settles the whole turn
 *     (a second run is denied with no dialog); a new turn asks again; Allow lets every later run
 *     of that turn through without a dialog.
 *  2. The user's kernel is untouched by shadow runs (execCount / cell source unchanged).
 *  3. Verification badge — a verified diff shows「已影子核验」; saving an upstream cell flips it to「核验已过期」.
 * The Node client stands in for the agent tool host. All data is synthetic (canary column).
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { withSmokeBridge } from './smoke-runtime.mjs';

const appURL = process.argv[2] ?? 'http://127.0.0.1:5299/';
const evidencePath = process.argv[3];
const appOrigin = new URL(appURL).origin;
const CANARY = 'CANARY_ROW_7f3a';
const fixture = [
  '# %% [cell-id: aaaaaaaa]',
  'import pandas as pd',
  `raw = pd.DataFrame({"g": ["A", "B"] * 50, "v": list(range(100)), "tag": ["${CANARY}"] * 100})`,
  '',
  '# %% [cell-id: bbbbbbbb]',
  'clean = raw[raw["v"] >= 0]',
  '',
].join('\n');
const CHANGE = { targetCellId: 'bbbbbbbb', action: 'update', newCode: 'clean = raw[raw["v"] >= 10]' };
const browser = await chromium.launch({ headless: true });
const errors = [];
const evidence = {};

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
      window.__shadow = { nb };
    });
    await page.waitForFunction((file) => {
      const s = window.__shadow.nb.getState();
      return s.notebookPath === file && s.cells.length === 2 && s.bridgeConnected;
    }, notebookPath);
    await agent.rpc('cell.run', { cellId: 'aaaaaaaa', cascade: true });
    const userState = () => page.evaluate(() => window.__shadow.nb.getState().cells.map((c) => [c.id, c.execCount, c.code]));
    await page.waitForFunction(() => window.__shadow.nb.getState().cells.every((c) => c.execCount > 0));
    const before = await userState();

    const dialog = page.getByTestId('run-confirm-dialog');
    const noDialogFor = async (ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        assert.equal(await dialog.count(), 0, 'no dialog expected');
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    // ---- 1a. Turn t1: first run asks; Deny settles the turn ----
    await agent.rpc('agent.turnBegin', { turnId: 't1' });
    const denied = agent.rpc('shadow.run', { changes: [CHANGE] });
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await dialog.getAttribute('data-kind'), 'shadow_run');
    assert.match(await page.getByTestId('shadow-confirm-changes').textContent(), /bbbbbbbb · 改写：clean = raw\[raw\["v"\] >= 10\]/);
    assert.match(await page.getByTestId('shadow-confirm-safety').textContent(), /你的 kernel、变量和文件都不会被改动/);
    assert.match(await dialog.textContent(), /允许本轮影子运行/);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'run-confirm-deny', 'default focus is Deny');
    await page.getByTestId('run-confirm-deny').click();
    const d1 = await denied;
    assert.equal(d1.denied, true);
    assert.equal(d1.reason, 'user-declined');
    await dialog.waitFor({ state: 'hidden' });
    const again = agent.rpc('shadow.run', { changes: [CHANGE] });
    await noDialogFor(600);
    assert.equal((await again).reason, 'user-declined', 'declined turn stays declined without asking');

    // ---- 1b. Turn t2: asks again; Allow covers the rest of the turn ----
    await agent.rpc('agent.turnBegin', { turnId: 't2' });
    const allowed = agent.rpc('shadow.run', { changes: [CHANGE] });
    await dialog.waitFor({ state: 'visible' });
    await page.getByTestId('run-confirm-allow').click();
    const r1 = await allowed;
    assert.equal(r1.status, 'ok');
    await dialog.waitFor({ state: 'hidden' });
    const second = agent.rpc('shadow.run', { changes: [CHANGE] });
    await noDialogFor(300);
    const r2 = await second;
    assert.equal(r2.status, 'ok');
    assert.equal(r2.budget.runsUsed, 2);
    const clean = r2.vars.find((v) => v.name === 'clean');
    assert.deepEqual(clean.delta.shape, { before: [100, 3], after: [90, 3] });
    assert.ok(!JSON.stringify([r1, r2]).includes(CANARY), 'shadow reports carry no row data');

    // ---- 2. user kernel untouched ----
    assert.deepEqual(await userState(), before, 'shadow runs must not touch the user kernel or cells');

    // ---- 3. verification badge: verified → expired after an upstream save ----
    const ver = await agent.rpc('shadow.verify', {
      runId: r2.runId,
      contracts: [{ kind: 'row_count', target: 'clean', op: '<=', ref: { target: 'clean', phase: 'before' } }],
    });
    assert.equal(ver.status, 'pass');
    const staged = await agent.rpc('diff.stage', { ...CHANGE, verificationId: ver.verificationId });
    assert.deepEqual(staged.verification, { status: 'verified', level: 'V2', missing: [] });
    const badge = page.getByTestId('diff-verification');
    await badge.waitFor({ state: 'visible' });
    assert.equal(await badge.getAttribute('data-status'), 'verified');
    assert.equal((await badge.textContent()).trim(), '已影子核验');
    await agent.rpc('cell.save', { cellId: 'aaaaaaaa', code: fixture.split('\n').slice(1, 3).join('\n').replace('range(100)', 'range(200)') });
    await page.waitForFunction(() => document.querySelector('[data-testid="diff-verification"]')?.getAttribute('data-status') === 'expired');
    assert.equal((await badge.textContent()).trim(), '核验已过期');
    assert.ok(!(await page.content()).includes('>CANARY_ROW_7f3a<'), 'page shows no shadow row data');

    assert.equal(errors.length, 0, `page errors: ${errors.join('; ')}`);
    Object.assign(evidence, {
      turnDeclineSticky: true,
      newTurnAsksAgain: true,
      allowCoversTurn: true,
      userKernelUntouched: true,
      badge: ['verified', 'expired'],
      shadowDeltaShape: clean.delta.shape,
      pageErrors: errors.length,
    });
    await page.close();
  }, { timeoutMs: 240_000 });
  if (evidencePath) writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log('SHADOW_CONFIRM_SMOKE_OK');
} finally {
  await browser.close();
}
