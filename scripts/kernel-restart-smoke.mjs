#!/usr/bin/env node
/** Real Chromium + owned bridge/kernel acceptance for dead-tab restart. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { withSmokeBridge } from './smoke-runtime.mjs';

const runFile = promisify(execFile);
const appURL = process.argv[2] ?? 'http://127.0.0.1:5299/';
const appOrigin = new URL(appURL).origin;
const fixture = '# %% [cell-id: aaaaaaaa]\nprint("BEFORE_RESTART")\nx = 1\nx\n\n# %% [cell-id: bbbbbbbb]\ny = x + 1\n';
const browser = await chromium.launch({ headless: true });
const errors = [];
let owned;

async function processes() {
  if (process.platform === 'win32') {
    const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 15_000 });
    const raw = stdout.trim() ? JSON.parse(stdout) : [];
    const rows = Array.isArray(raw) ? raw : [raw];
    return rows.map((row) => ({ pid: Number(row.ProcessId), parent: Number(row.ParentProcessId), command: String(row.CommandLine ?? '') }));
  }
  const { stdout } = await runFile('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'command='], { timeout: 15_000 });
  return stdout.trim().split('\n').filter(Boolean).map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? { pid: Number(match[1]), parent: Number(match[2]), command: match[3] } : null;
  }).filter(Boolean);
}

function ownedDescendants(rows, rootPid) {
  const ownedPids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (ownedPids.has(row.parent) && !ownedPids.has(row.pid)) {
        ownedPids.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => ownedPids.has(row.pid));
}

async function kernelPids() {
  assert.ok(owned, 'owned bridge context must be captured');
  const rootPid = owned.bridgePid ?? owned.child.pid;
  const rows = ownedDescendants(await processes(), rootPid);
  const candidates = rows.filter((row) => {
    const command = row.command.toLowerCase();
    return row.pid !== rootPid && command.includes('novakernel.server') && /python(?:\.exe)?/.test(command);
  });
  const candidatePids = new Set(candidates.map((row) => row.pid));
  return candidates.filter((row) => !candidates.some((other) => other.parent === row.pid && candidatePids.has(other.pid))).map((row) => row.pid);
}

async function waitForKernelCount(count, timeoutMs = 15_000) {
  const started = Date.now();
  for (;;) {
    const pids = await kernelPids();
    if (pids.length >= count) return pids;
    if (Date.now() - started > timeoutMs) throw new Error(`owned kernel count ${pids.length} < ${count}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function killOwnedKernel(pid) {
  assert.ok((await kernelPids()).includes(pid), `refusing to kill non-owned kernel pid ${pid}`);
  if (process.platform === 'win32') {
    await runFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 });
  } else {
    process.kill(pid, 'SIGKILL');
  }
}

try {
  await withSmokeBridge(fixture, async ({ bridge: nodeBridge, notebookPath }) => {
    const secondPath = path.join(path.dirname(notebookPath), 'second.py');
    await writeFile(secondPath, '# %% [cell-id: aaaaaaaa]\ny = 100\n', 'utf8');
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
    await page.goto(`${appURL}?path=${encodeURIComponent(notebookPath)}`);
    await page.evaluate(async () => {
      const { useNotebook: nb } = await import('/src/store/notebook.ts');
      const { useNotebooks: tabs } = await import('/src/store/notebooks.ts');
      const { useSession: session } = await import('/src/store/session.ts');
      const { useI18nStore: i18n } = await import('/src/i18n/index.ts');
      const { bridge } = await import('/src/bridge/client.ts');
      i18n.getState().setLang('en');
      window.__restartAcceptance = { nb, tabs, session, bridge };
    });
    await page.waitForFunction((file) => {
      const h = window.__restartAcceptance;
      return h.nb.getState().notebookPath === file && h.nb.getState().cells.length === 2 && h.tabs.getState().activeId;
    }, notebookPath);
    owned = await new Promise((resolve) => resolve(owned));
    const firstKernel = (await waitForKernelCount(1))[0];

    const initial = await page.evaluate(async () => {
      const h = window.__restartAcceptance;
      const firstId = h.tabs.getState().activeId;
      await h.nb.getState().runCell('aaaaaaaa');
      await h.nb.getState().runRepl('print("OLD_REPL")');
      return { firstId, firstSession: h.session.getState().currentId };
    });
    assert.ok(initial.firstId);
    assert.ok(initial.firstSession);

    await page.evaluate(async (file) => {
      const h = window.__restartAcceptance;
      await h.nb.getState().openNotebook(file);
      h.secondId = h.tabs.getState().activeId;
    }, secondPath);
    await page.waitForFunction((file) => {
      const h = window.__restartAcceptance;
      return h.nb.getState().notebookPath === file && h.tabs.getState().activeId === h.secondId;
    }, secondPath);
    const kernelsWithB = await waitForKernelCount(2);
    const secondKernel = kernelsWithB.find((pid) => pid !== firstKernel);
    assert.ok(secondKernel, 'second notebook must own a distinct kernel');
    const secondBefore = await page.evaluate(() => window.__restartAcceptance.nb.getState().cells.map((cell) => cell.code));

    await page.evaluate(async (id) => { await window.__restartAcceptance.nb.getState().switchTab(id); }, initial.firstId);
    await page.waitForFunction((id) => window.__restartAcceptance.tabs.getState().activeId === id, initial.firstId);
    await killOwnedKernel(firstKernel);
    await page.waitForFunction((id) => {
      const h = window.__restartAcceptance;
      const tab = h.tabs.getState().tabs.find((item) => item.notebookId === id);
      return tab?.ended === true && tab.kernelState === 'dead' && h.session.getState().readOnly === true;
    }, initial.firstId);

    const delayed = await page.evaluate(() => {
      const h = window.__restartAcceptance;
      const originalRpc = h.bridge.rpc.bind(h.bridge);
      h.restartCalls = 0;
      h.restartRelease = null;
      h.bridge.rpc = async (method, params = {}) => {
        if (method === 'kernel.restart') {
          h.restartCalls += 1;
          const result = await originalRpc(method, params);
          h.restartResult = result;
          await new Promise((resolve) => { h.restartRelease = resolve; });
          return result;
        }
        return originalRpc(method, params);
      };
      return { secondId: h.secondId, before: h.nb.getState().cells.map((cell) => cell.code) };
    });
    const statusButton = page.locator('button[title*="kernel session ended"]');
    await statusButton.click();
    await page.getByRole('button', { name: /restart kernel/i }).click();
    await page.waitForFunction(() => typeof window.__restartAcceptance.restartRelease === 'function');
    await page.evaluate(async (id) => { await window.__restartAcceptance.nb.getState().switchTab(id); }, delayed.secondId);
    await page.waitForFunction((id) => window.__restartAcceptance.tabs.getState().activeId === id, delayed.secondId);
    await page.evaluate(() => window.__restartAcceptance.restartRelease());
    await page.waitForFunction((id) => {
      const h = window.__restartAcceptance;
      const tab = h.tabs.getState().tabs.find((item) => item.notebookId === id);
      return tab?.ended === false && tab.kernelState === 'idle' && h.tabs.getState().activeId === h.secondId;
    }, initial.firstId);
    const isolated = await page.evaluate((id) => {
      const h = window.__restartAcceptance;
      return {
        activeId: h.tabs.getState().activeId,
        visible: h.nb.getState().cells.map((cell) => cell.code),
        secondCache: h.tabs.getState().readCache(id)?.cells.map((cell) => cell.code),
        firstCache: h.tabs.getState().readCache(h.tabs.getState().tabs.find((tab) => tab.notebookId !== id)?.notebookId ?? '')?.cells.map((cell) => cell.code),
        restartCalls: h.restartCalls,
        counts: h.tabs.getState().tabs.map((tab) => ({ id: tab.notebookId, ended: tab.ended, dirty: tab.dirty })),
      };
    }, delayed.secondId);
    assert.equal(isolated.activeId, delayed.secondId);
    assert.deepEqual(isolated.visible, secondBefore);
    assert.equal(isolated.restartCalls, 1);
    assert.deepEqual(isolated.firstCache, ['print("BEFORE_RESTART")\nx = 1\nx', 'y = x + 1']);
    assert.deepEqual(isolated.secondCache, secondBefore);
    assert.ok(isolated.counts.some((tab) => tab.id === delayed.secondId && !tab.ended));
    assert.equal(errors.length, 0, `page errors: ${errors.join('; ')}`);

    await page.evaluate(async (id) => { await window.__restartAcceptance.nb.getState().switchTab(id); }, initial.firstId);
    await page.waitForFunction((id) => window.__restartAcceptance.tabs.getState().activeId === id, initial.firstId);
    const aKernelAfterRestart = (await waitForKernelCount(2)).find((pid) => pid !== secondKernel);
    assert.ok(aKernelAfterRestart, 'A restart must create a replacement kernel');
    await page.evaluate(() => {
      const h = window.__restartAcceptance;
      h.originalSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => h.originalSetTimeout(callback, delay === 300 ? 60_000 : delay, ...args);
      h.nb.getState().setCellCode('aaaaaaaa', 'x = 99');
    });
    await page.waitForFunction(() => window.__restartAcceptance.tabs.getState().activeTab()?.dirty === true);
    await killOwnedKernel(aKernelAfterRestart);
    await page.waitForFunction((id) => window.__restartAcceptance.tabs.getState().tabs.find((tab) => tab.notebookId === id)?.ended === true, initial.firstId);
    const beforeDirtyRestart = await page.evaluate(() => window.__restartAcceptance.restartCalls);
    await page.locator('button[title*="kernel session ended"]').click();
    await page.getByRole('button', { name: /restart kernel/i }).click();
    await page.waitForFunction((id) => {
      const h = window.__restartAcceptance;
      const tab = h.tabs.getState().tabs.find((item) => item.notebookId === id);
      return tab?.error?.operation === 'restart' && tab.dirty === true && tab.ended === true;
    }, initial.firstId);
    const dirtyResult = await page.evaluate((id) => {
      const h = window.__restartAcceptance;
      return { calls: h.restartCalls, code: h.tabs.getState().readCache(id)?.cells[0]?.code, error: h.tabs.getState().tabs.find((tab) => tab.notebookId === id)?.error };
    }, initial.firstId);
    assert.equal(dirtyResult.calls, beforeDirtyRestart);
    assert.equal(dirtyResult.code, 'x = 99');
    assert.equal(dirtyResult.error.operation, 'restart');
    await page.evaluate(() => { window.setTimeout = window.__restartAcceptance.originalSetTimeout; });
    assert.equal(errors.length, 0, `page errors: ${errors.join('; ')}`);
    await page.close();
  }, {
    timeoutMs: 180_000,
    onStage: async (stage, context) => {
      if (stage === 'connected') owned = { child: context.child, bridgePid: context.child.bridgePid, work: context.work };
    },
  });
  console.log('KERNEL_RESTART_SMOKE_OK');
} finally {
  await browser.close();
}
