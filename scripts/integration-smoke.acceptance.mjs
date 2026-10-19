/** Real local-process regressions; no provider calls or user storage access. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { SMOKE_FIXTURE, runIntegrationSmoke } from './integration-smoke.mjs';
import { verifyOwnedManifest } from './smoke-runtime.mjs';

const runFile = promisify(execFile);
const decoy = http.createServer((req, res) => {
  decoyRequests += 1;
  // Discoverable decoy represents a user's already running default-port service.
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ wsUrl: 'ws://127.0.0.1:7788/', token: 'decoy-only', llmProxyOrigin: 'http://127.0.0.1:7789' }));
});
let decoyRequests = 0;
let demoBytes;
let observed;

async function processes() {
  if (process.platform === 'win32') {
    const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{n="Created";e={if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }}} | ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 15_000 });
    return JSON.parse(stdout).map((p) => ({ pid: p.ProcessId, parent: p.ParentProcessId, created: Number(p.Created) || 0 }));
  }
  const { stdout } = await runFile('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { timeout: 15_000 });
  return stdout.trim().split('\n').map((line) => {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    return { pid, parent };
  });
}

/**
 * Windows 的 ParentProcessId 不随父进程退出而更新：长寿的系统进程可能指向一个已退出、
 * 且 PID 恰被本次自有进程复用的"父进程"。只认创建时间不早于父进程的子进程（POSIX 无此问题，created 缺省）。
 */
async function descendants(pid) {
  const rows = await processes();
  const createdOf = new Map(rows.map((r) => [r.pid, r.created]));
  const owned = new Set([pid]);
  let changed;
  do {
    changed = false;
    for (const row of rows) {
      if (!owned.has(row.parent) || owned.has(row.pid)) continue;
      const parentCreated = createdOf.get(row.parent);
      if (row.created && parentCreated && row.created < parentCreated) continue; // PPID 复用：不是本次的后代
      owned.add(row.pid);
      changed = true;
    }
  } while (changed);
  return [...owned];
}

function observer(action = () => {}) {
  return async (stage, context) => {
    if (stage === 'spawned') observed = { pid: context.child.pid, work: context.work, pids: [context.child.pid] };
    if (stage === 'opened') {
      observed.pids = await descendants(context.child.pid);
      assert.ok(observed.pids.length >= 2, 'real bridge must have launched a kernel descendant');
      console.log(`regression observed owned pids=${observed.pids.join(',')}`);
    }
    await action(stage, context);
  };
}

async function verifyCleanup() {
  assert.ok(observed, 'spawned stage should have been observed');
  const alive = new Set((await processes()).map((p) => p.pid));
  for (const pid of observed.pids) assert.equal(alive.has(pid), false, `owned pid ${pid} leaked`);
  await assert.rejects(stat(observed.work), { code: 'ENOENT' });
  assert.deepEqual(await readFile(new URL('../demos/demo.py', import.meta.url)), demoBytes);
  assert.equal(decoyRequests, 0, 'smoke must never discover or authenticate with the existing service');
  assert.equal(decoy.listening, true, 'existing service must survive smoke cleanup');
  console.log(`regression verified exited pids=${observed.pids.join(',')} temp removed; default-port decoy untouched`);
}

before(async () => {
  demoBytes = await readFile(new URL('../demos/demo.py', import.meta.url));
  await new Promise((resolve, reject) => {
    decoy.once('error', reject);
    decoy.listen(7788, '127.0.0.1', resolve);
  });
});
after(async () => {
  if (decoy.listening) await new Promise((resolve) => decoy.close(resolve));
});

test('manifest rejects wrong PID, token, port or address before connecting', () => {
  const info = { pid: 123, token: 'only-this-run', wsPort: 40001, wsUrl: 'ws://127.0.0.1:40001/', llmPort: 40002, llmProxyOrigin: 'http://127.0.0.1:40002' };
  assert.equal(verifyOwnedManifest(info, 123, 'only-this-run'), info);
  for (const patch of [{ pid: 456 }, { token: 'wrong' }, { wsPort: 0 }, { wsUrl: 'ws://example.com:40001/' }, { llmProxyOrigin: 'http://localhost:40002' }]) {
    assert.throws(() => verifyOwnedManifest({ ...info, ...patch }, 123, 'only-this-run'), /清单/);
  }
});

test('success uses only its child, temporary notebook and data when 7788 already serves discovery', { timeout: 60_000 }, async () => {
  await runIntegrationSmoke({ onStage: observer() });
  await verifyCleanup();
});

test('startup port conflict exits instead of scanning or killing the existing service', { timeout: 30_000 }, async () => {
  await assert.rejects(runIntegrationSmoke({ bridgePort: 7788, onStage: observer() }), /退出/);
  await verifyCleanup();
});

test('LLM listener port conflict never advertises a ready manifest or connects', { timeout: 30_000 }, async () => {
  let connected = false;
  await assert.rejects(runIntegrationSmoke({ timeoutMs: 7_000, llmPort: 7788, onStage: observer((stage) => {
    if (stage === 'connected') connected = true;
  }) }), /退出/);
  assert.equal(connected, false, 'a failed proxy listener must never publish usable discovery');
  await verifyCleanup();
});

test('assertion failure after opening a real kernel awaits all owned exits', { timeout: 60_000 }, async () => {
  const oneCell = '# %% [cell-id: abcdef01]\nx = 1\nx\n';
  await assert.rejects(runIntegrationSmoke({ fixture: oneCell, onStage: observer() }), /cells=1/);
  await verifyCleanup();
});

test('unexpected child exit with an executing kernel still reaps owned descendants', { timeout: 60_000 }, async () => {
  await assert.rejects(runIntegrationSmoke({ onStage: observer(async (stage, { child, bridge }) => {
    if (stage === 'opened') {
      const running = bridge.rpc('kernel.repl', { code: 'import time; time.sleep(60)' }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 200));
      process.kill(child.bridgePid ?? child.pid, 'SIGKILL');
      await running;
      return new Promise(() => {}); // Exit monitoring must work independently of RPC failure.
    }
  }) }), /退出|关闭/);
  await verifyCleanup();
});

test('connection-stage exception still reaps the owned bridge', { timeout: 30_000 }, async () => {
  await assert.rejects(runIntegrationSmoke({ onStage: observer((stage) => {
    if (stage === 'connected') throw new Error('injected connection-stage failure');
  }) }), /connection-stage failure/);
  await verifyCleanup();
});

test('per-call RPC timeout during real Python execution still reaps the kernel', { timeout: 60_000 }, async () => {
  await assert.rejects(runIntegrationSmoke({ onStage: observer(async (stage, { bridge }) => {
    if (stage === 'opened') await bridge.rpc('kernel.repl', { code: 'import time; time.sleep(60)' }, { timeoutMs: 100 });
  }) }), /超时.*kernel.repl/);
  await verifyCleanup();
});

test('total timeout interrupts real Python execution with a kernel alive', { timeout: 60_000 }, async () => {
  await assert.rejects(runIntegrationSmoke({ timeoutMs: 10_000, onStage: observer(async (stage, { bridge }) => {
    if (stage === 'opened') await bridge.rpc('kernel.repl', { code: 'import time; time.sleep(60)' });
  }) }), /总超时/);
  await verifyCleanup();
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`${signal} handler stops only owned bridge/kernel and awaits their exits`, { timeout: 60_000 }, async () => {
    await assert.rejects(runIntegrationSmoke({ onStage: observer((stage) => {
      if (stage === 'opened') process.emit(signal);
    }) }), (error) => error.signal === signal);
    await verifyCleanup();
  });
}

test('two concurrent runs keep their ports and notebook/data directories separate', { timeout: 60_000 }, async () => {
  const contexts = [];
  const onStage = async (stage, context) => {
    if (stage === 'opened') contexts.push({ pid: context.child.pid, work: context.work, pids: await descendants(context.child.pid), wsPort: context.bridge.info.wsPort });
  };
  await Promise.all([runIntegrationSmoke({ onStage }), runIntegrationSmoke({ onStage })]);
  assert.equal(contexts.length, 2);
  assert.notEqual(contexts[0].wsPort, contexts[1].wsPort);
  assert.notEqual(contexts[0].work, contexts[1].work);
  for (const context of contexts) {
    observed = context;
    await verifyCleanup();
  }
});
