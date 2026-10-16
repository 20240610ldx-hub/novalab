/** Isolated, owned Bridge lifetime for the real integration smoke. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BridgeClient } from './bridge-client.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'bridge', 'package.json'));

export function verifyOwnedManifest(info, pid, token) {
  if (info?.pid !== pid || info?.token !== token) throw new Error('bridge 清单不属于本次 child');
  const validPort = (port) => Number.isInteger(port) && port > 0 && port <= 65535;
  if (
    !validPort(info.wsPort) || !validPort(info.llmPort) ||
    info.wsUrl !== `ws://127.0.0.1:${info.wsPort}/` ||
    info.llmProxyOrigin !== `http://127.0.0.1:${info.llmPort}`
  ) throw new Error('bridge 清单地址无效');
  return info;
}

export async function waitForManifest(file, child, token, signal) {
  for (;;) {
    signal.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('bridge 在就绪前退出');
    let info;
    try {
      info = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    // Never retry ownership/URL mismatches or fall back to conventional-port discovery.
    if (info && (process.platform !== 'win32' || child.bridgePid)) {
      return verifyOwnedManifest(info, child.bridgePid ?? child.pid, token);
    }
    await delay(50, undefined, { signal });
  }
}

export async function stopOwnedTree(child, closed) {
  if (!child.pid) return;
  let forceTimer;
  if (process.platform === 'win32') {
    // The launcher owns a Job Object established before Bridge can spawn descendants.
    // It terminates the job and waits for ActiveProcesses=0, even if Bridge died first.
    if (!child.stdin.destroyed) child.stdin.end();
    forceTimer = setTimeout(() => child.kill(), 15_000);
  } else {
    // detached spawn creates a new process group, containing only this run's children.
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  let timer;
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('等待 smoke child 退出超时')), 20_000);
      }),
    ]);
    if (process.platform === 'win32' && !child.jobEmpty) throw new Error('smoke Job launcher 未确认全部进程退出');
    if (process.platform !== 'win32') {
      const deadline = Date.now() + 15_000;
      for (;;) {
        try {
          process.kill(-child.pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') break;
          throw error;
        }
        if (Date.now() >= deadline) throw new Error('等待 smoke 进程组退出超时');
        await delay(25);
      }
    }
  } finally {
    clearTimeout(timer);
    clearTimeout(forceTimer);
  }
}

// launch(work) may select bundled artifacts; ownership/ports/data remain enforced here.
export async function withSmokeBridge(fixture, check, { timeoutMs = 120_000, bridgePort = 0, llmPort = 0, onStage = () => {}, launch } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('smoke timeoutMs 必须为正数');
  const controller = new AbortController();
  const signal = controller.signal;
  const bridge = new BridgeClient({ rpcTimeoutMs: 15_000, runTimeoutMs: 60_000 });
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((name) => [name, () => {
    const error = new Error(`smoke 收到 ${name}`);
    error.signal = name;
    controller.abort(error);
  }]));
  for (const [name, handler] of handlers) process.on(name, handler);
  const timer = setTimeout(() => controller.abort(new Error(`smoke 总超时 (${timeoutMs}ms)`)), timeoutMs);
  let work;
  let child;
  let closed;
  let abortWork;
  const aborted = new Promise((_, reject) => {
    abortWork = () => reject(signal.reason);
    signal.addEventListener('abort', abortWork, { once: true });
  });
  const setup = (async () => {
    work = await mkdtemp(join(tmpdir(), 'novalab-integration-smoke-'));
    signal.throwIfAborted();
    const notebookPath = join(work, 'smoke.py');
    await writeFile(notebookPath, fixture, 'utf8');
    return notebookPath;
  })();
  const operation = (async () => {
    const notebookPath = await setup;
    signal.throwIfAborted();
    const token = randomBytes(32).toString('base64url');
    const spec = launch ? launch(work) : {
      node: process.execPath,
      loader: pathToFileURL(require.resolve('tsx')).href,
      main: join(root, 'bridge', 'src', 'main.ts'),
      cwd: join(root, 'bridge'),
    };
    const windows = process.platform === 'win32';
    child = spawn(windows ? 'powershell.exe' : spec.node, windows
      ? ['-NoProfile', '-NonInteractive', '-File', join(root, 'scripts', 'smoke-win32.ps1'),
        '-Node', spec.node, '-Main', spec.main, ...(spec.loader ? ['-Loader', spec.loader] : [])]
      : [...(spec.loader ? ['--import', spec.loader] : []), spec.main], {
      cwd: spec.cwd,
      env: {
        ...process.env,
        NOVALAB_PACKAGED: '0',
        NOVALAB_PY_DIR: join(root, 'py'),
        NOVALAB_UV_BIN: 'uv',
        ...spec.env,
        NOVALAB_DATA_DIR: join(work, 'data'),
        NOVALAB_BRIDGE_TOKEN: token,
        NOVALAB_BRIDGE_PORT: String(bridgePort),
        NOVALAB_LLM_PORT: String(llmPort),
      },
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: [windows ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    closed = new Promise((resolve) => child.once('close', resolve));
    child.once('error', (error) => controller.abort(error));
    child.once('exit', (code, exitSignal) => {
      controller.abort(new Error(`smoke bridge 提前退出 (${code ?? exitSignal})`));
    });
    child.stdin?.on('error', () => {}); // Launcher may have already exited on Bridge failure.
    let startupOutput = '';
    child.stdout.on('data', (d) => {
      startupOutput += String(d);
      const match = /NOVALAB_SMOKE_BRIDGE_PID=(\d+)/.exec(startupOutput);
      if (match) child.bridgePid = Number(match[1]);
      if (startupOutput.includes('NOVALAB_SMOKE_JOB_EMPTY')) child.jobEmpty = true;
      if (startupOutput.length > 4096) startupOutput = startupOutput.slice(-4096);
      process.stdout.write(`[bridge] ${d}`);
    });
    child.stderr.on('data', (d) => process.stderr.write(`[bridge!] ${d}`));
    console.log(`smoke child: pid=${child.pid} work=${work}`);
    await onStage('spawned', { child, work, notebookPath });
    const info = await waitForManifest(join(work, 'data', 'bridge.json'), child, token, signal);
    signal.throwIfAborted();
    await bridge.connect(info);
    signal.throwIfAborted();
    console.log(`smoke owned bridge: pid=${info.pid} wsPort=${info.wsPort} llmPort=${info.llmPort}`);
    await onStage('connected', { child, work, notebookPath, bridge });
    signal.throwIfAborted();
    await check({ bridge, notebookPath, signal, stage: async (name) => {
      signal.throwIfAborted();
      await onStage(name, { child, work, notebookPath, bridge });
      signal.throwIfAborted();
    } });
  })();
  let failure;
  try {
    await Promise.race([operation, aborted]);
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abortWork);
    bridge.close();
    try {
      // Allow setup to finish its current fs operation, but never spawn after cancellation.
      if (!signal.aborted) controller.abort(new Error('smoke 完成，开始清理'));
      await setup.catch(() => {});
      if (child) await stopOwnedTree(child, closed);
      if (work) await rm(work, { recursive: true, force: true });
      console.log('smoke cleanup: owned process tree exited; temporary files removed');
    } catch (error) {
      if (failure) {
        const cleanupFailure = new Error(`${failure.message}; cleanup: ${error.message}`, { cause: failure });
        cleanupFailure.signal = failure.signal;
        failure = cleanupFailure;
      } else {
        failure = error;
      }
    } finally {
      for (const [name, handler] of handlers) process.removeListener(name, handler);
    }
  }
  if (failure) throw failure;
}
