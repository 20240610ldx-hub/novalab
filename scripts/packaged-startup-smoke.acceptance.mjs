/** Real bundled-process regressions. Run after building the sidecar artifacts. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { prewarmPackagedPython, runPackagedStartupSmoke } from './packaged-startup-smoke.mjs';

const runFile = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
let decoyRequests = 0;
function recordDecoyRequest(req, kind) {
  decoyRequests += 1;
  // Diagnostic metadata only: never log authentication headers or query strings.
  console.error(`unexpected decoy ${kind}: method=${req.method} path=${new URL(req.url, 'http://127.0.0.1').pathname} origin=${req.headers.origin ?? '(none)'} user-agent=${req.headers['user-agent'] ?? '(none)'}`);
}
const decoy = http.createServer((req, res) => {
  recordDecoyRequest(req, 'http');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ wsUrl: 'ws://127.0.0.1:7788/', token: 'decoy-only', llmProxyOrigin: 'http://127.0.0.1:7789' }));
});
decoy.on('upgrade', (req, socket) => {
  recordDecoyRequest(req, 'upgrade');
  socket.destroy();
});
let originalDemos;

async function demoHashes(dir = path.join(root, 'demos')) {
  const hashes = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // Notebook sidecars and historical evidence must never be touched by this suite.
    if (entry.name === '.novalab' || entry.name === '__pycache__') continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(hashes, await demoHashes(file));
    else if (entry.isFile()) hashes[path.relative(root, file)] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  return hashes;
}

async function processes() {
  if (process.platform === 'win32') {
    const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 15_000 });
    return JSON.parse(stdout).map((p) => ({ pid: p.ProcessId, parent: p.ParentProcessId, executable: p.ExecutablePath }));
  }
  const { stdout } = await runFile('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'comm='], { timeout: 15_000 });
  return stdout.trim().split('\n').map((line) => {
    const [, pid, parent, executable] = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return { pid: Number(pid), parent: Number(parent), executable };
  });
}

async function descendants(pid) {
  const rows = await processes();
  const owned = new Set([pid]);
  let changed;
  do {
    changed = false;
    for (const row of rows) {
      if (owned.has(row.parent) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
    }
  } while (changed);
  return rows.filter((row) => owned.has(row.pid));
}

const samePath = (a, b) => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b);

async function runCase(t, options = {}, expectedError) {
  let observed;
  let successMarkers = 0;
  let cleanupLogged = false;
  const log = console.log;
  const discovery = t.mock.method(globalThis, 'fetch', () => { throw new Error('packaged smoke must not perform HTTP discovery'); });
  t.mock.method(console, 'log', (...args) => {
    const line = args.join(' ');
    if (line.startsWith('smoke cleanup:')) cleanupLogged = true;
    if (line.startsWith('PACKAGED_STARTUP_SMOKE_OK')) {
      successMarkers += 1;
      assert.equal(cleanupLogged, true, 'success must follow cleanup confirmation');
      assert.equal(existsSync(observed.work), false, 'temp must already be removed when success is printed');
      for (const pid of observed.pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `success printed with pid ${pid} alive`);
    }
    log(...args);
  });
  const operation = runPackagedStartupSmoke({
    ...options,
    onStage: async (stage, context) => {
      if (stage === 'spawned') observed = { child: context.child, work: context.work, pids: [context.child.pid] };
      if (stage === 'connected') {
        observed.pids = (await descendants(context.child.pid)).map((row) => row.pid);
        const manifest = JSON.parse(await readFile(path.join(context.work, 'data', 'bridge.json'), 'utf8'));
        assert.equal(manifest.pid, context.child.bridgePid ?? context.child.pid);
        assert.equal(manifest.token, context.bridge.info.token);
        assert.ok(manifest.token.length >= 40);
        assert.equal(manifest.wsUrl, `ws://127.0.0.1:${manifest.wsPort}/`);
        assert.equal(manifest.llmProxyOrigin, `http://127.0.0.1:${manifest.llmPort}`);
        assert.equal(path.dirname(context.notebookPath), context.work);
      }
      if (stage === 'opened') {
        const rows = await descendants(context.child.pid);
        observed.pids = rows.map((row) => row.pid);
        assert.ok(observed.pids.length >= 3, 'real bridge/uv/Python descendants must exist');
        if (process.platform === 'win32') {
          const binaries = path.join(root, 'app', 'src-tauri', 'binaries');
          for (const name of ['node', 'uv']) {
            const expected = path.join(binaries, `${name}-x86_64-pc-windows-msvc.exe`);
            assert.ok(rows.some((row) => row.executable && samePath(row.executable, expected)), `bundled ${name} must actually execute`);
          }
          assert.ok(rows.some((row) => /python[^\\/]*\.exe$/i.test(row.executable ?? '')), 'real Python must execute');
        }
        log(`packaged regression owned pids=${observed.pids.join(',')}`);
      }
      await options.onStage?.(stage, context);
    },
  });
  if (expectedError) await assert.rejects(operation, expectedError);
  else await operation;
  assert.ok(observed, 'must launch its own child');
  const alive = new Set((await processes()).map((p) => p.pid));
  for (const pid of observed.pids) assert.equal(alive.has(pid), false, `owned pid ${pid} leaked`);
  await assert.rejects(stat(observed.work), { code: 'ENOENT' });
  assert.equal(discovery.mock.callCount(), 0, 'packaged path must never invoke HTTP discovery');
  assert.equal(decoyRequests, 0, 'default-port service must receive zero HTTP/WS requests');
  assert.equal(decoy.listening, true, 'existing service must survive');
  assert.equal(successMarkers, expectedError ? 0 : 1, 'failure must never print success');
  assert.deepEqual(await demoHashes(), originalDemos, 'demo files must remain byte-identical');
  log(`packaged regression verified exited pids=${observed.pids.join(',')}; temp removed; decoy requests=0`);
}

// Each test gets its own Bridge/kernel tree; tests intentionally run serially.
// 干净机器首启要下载解释器与依赖（>60 s），会把第一个用例拖超时，超时用例的后台操作再污染后续用例的
// 成功计数。先按产品同款命令预热（产品自身首启预算 300 s），用例只考核启动/清理生命周期。
before(() => {
  prewarmPackagedPython();
}, { timeout: 330_000 });
before(async () => {
  originalDemos = await demoHashes();
  await new Promise((resolve, reject) => {
    decoy.once('error', reject);
    decoy.listen(7788, '127.0.0.1', resolve);
  });
});
after(async () => {
  if (decoy.listening) await new Promise((resolve) => decoy.close(resolve));
});

test('bundled success ignores discoverable 7788 decoy and reports only after all cleanup', { timeout: 60_000 }, async (t) => {
  await runCase(t);
});

for (const stage of ['connected', 'opened']) {
  test(`${stage} callback failure reaps the packaged tree without success`, { timeout: 60_000 }, async (t) => {
    await runCase(t, { onStage: (name) => {
      if (name === stage) throw new Error(`injected ${stage} callback failure`);
    } }, new RegExp(`injected ${stage}`));
  });
}

for (const port of ['bridgePort', 'llmPort']) {
  test(`${port} conflict never scans or kills the decoy`, { timeout: 30_000 }, async (t) => {
    await runCase(t, { [port]: 7788 }, /退出/);
  });
}

test('Python result mismatch fails after real execution and full cleanup', { timeout: 60_000 }, async (t) => {
  await runCase(t, { fixture: '# %% [cell-id: abcdef01]\n6 * 6\n' }, /计算结果应为 42/);
});

test('RPC timeout with a running Python kernel reaps all packaged descendants', { timeout: 60_000 }, async (t) => {
  await runCase(t, { onStage: async (stage, { bridge }) => {
    if (stage === 'opened') await bridge.rpc('kernel.repl', { code: 'import time; time.sleep(60)' }, { timeoutMs: 100 });
  } }, /RPC 超时.*kernel.repl/);
});

test('total timeout interrupts a callback with a live Python kernel', { timeout: 60_000 }, async (t) => {
  await runCase(t, { timeoutMs: 10_000, onStage: async (stage, { bridge }) => {
    if (stage === 'opened') await bridge.rpc('kernel.repl', { code: 'import time; time.sleep(60)' });
  } }, /总超时/);
});

test('bridge death during Python execution still reaps its descendants', { timeout: 60_000 }, async (t) => {
  await runCase(t, { onStage: async (stage, { child, bridge }) => {
    if (stage !== 'opened') return;
    const running = bridge.rpc('kernel.repl', { code: 'import time; time.sleep(60)' }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.kill(child.bridgePid ?? child.pid, 'SIGKILL');
    await running;
    return new Promise(() => {}); // Lifetime monitoring must not depend on callback completion.
  } }, /退出|关闭/);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`${signal} reaps the packaged bridge and kernel`, { timeout: 60_000 }, async (t) => {
    await runCase(t, { onStage: (stage) => {
      if (stage === 'opened') process.emit(signal);
    } }, (error) => error.signal === signal);
  });
}
