import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const ORIGIN = 'http://127.0.0.1:5199';
const FOREIGN = 'https://novalab-security-test.invalid';
const sockets = new Set<WebSocket>();
let child: ChildProcess;
let dataDir: string;
let info: { pid: number; wsUrl: string; wsPort: number; llmPort: number; token: string };
let nextId = 0;

async function launch(): Promise<void> {
  dataDir = mkdtempSync(path.join(tmpdir(), 'novalab-auth-acceptance-'));
  const env: NodeJS.ProcessEnv = { ...process.env, NOVALAB_DATA_DIR: dataDir, NOVALAB_PY_DIR: path.join(root, 'py'), NOVALAB_PACKAGED: '0' };
  delete env.NOVALAB_BRIDGE_TOKEN;
  child = spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, path.join(root, 'bridge/src/main.ts')], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  // Startup evidence stays local; never echo the manifest/discovery token.
  let log = '';
  child.stdout?.on('data', (chunk) => { log += String(chunk); });
  child.stderr?.on('data', (chunk) => { log += String(chunk); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`test bridge exited: ${log}`);
    try {
      const candidate = JSON.parse(readFileSync(path.join(dataDir, 'bridge.json'), 'utf8'));
      assert.equal(candidate.pid, child.pid, 'manifest must belong to the test child');
      const response = await fetch(`http://127.0.0.1:${candidate.wsPort}/bridge-info`, {
        headers: { origin: ORIGIN }, signal: AbortSignal.timeout(500),
      });
      const discovered = await response.json() as typeof info;
      if (response.status === 200 && discovered.token === candidate.token && discovered.llmPort === candidate.llmPort) {
        info = { ...discovered, pid: candidate.pid };
        return;
      }
    } catch { /* The child's private manifest is the only discovery source. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`test bridge startup timed out: ${log}`);
}

async function stop(): Promise<void> {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  if (child?.exitCode === null) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    await exited;
  }
}

function connect(origin: string | null = ORIGIN): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(info.wsUrl, { ...(origin ? { origin } : {}), handshakeTimeout: 2_000 });
    sockets.add(socket);
    socket.once('open', () => resolve(socket));
    socket.on('error', reject);
    socket.once('close', () => sockets.delete(socket));
  });
}

function rpc(socket: WebSocket, method: string, params: unknown = {}): Promise<unknown> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const finish = (err?: Error, value?: unknown) => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
      err ? reject(err) : resolve(value);
    };
    const onClose = () => finish(new Error('test socket closed during RPC'));
    const onMessage = (raw: WebSocket.RawData) => {
      const result = JSON.parse(String(raw));
      if (result.id !== id) return;
      finish(result.error ? new Error(result.error.message) : undefined, result.result);
    };
    const timer = setTimeout(() => finish(new Error(`test RPC timed out: ${method}`)), 15_000);
    socket.on('message', onMessage);
    socket.once('close', onClose);
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), (err) => { if (err) finish(err); });
  });
}

async function authenticated(): Promise<WebSocket> {
  const socket = await connect();
  expect(await rpc(socket, 'bridge.auth', { token: info.token })).toMatchObject({ ok: true });
  return socket;
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('authentication rejection did not close the socket')), 5_000);
    socket.once('close', (code) => { clearTimeout(timer); resolve(code); });
  });
}

beforeAll(launch, 20_000);
afterAll(stop, 20_000);

describe('real Bridge · isolated security acceptance', () => {
  it('discovery and WS upgrade reject missing/foreign Origin; allowed discovery is usable', async () => {
    const url = `http://127.0.0.1:${info.wsPort}/bridge-info`;
    for (const origin of [null, FOREIGN]) {
      const response = await fetch(url, { headers: origin ? { origin } : {}, signal: AbortSignal.timeout(2_000) });
      expect(response.status).toBe(403);
      expect(await response.json()).not.toHaveProperty('token');
      await expect(connect(origin)).rejects.toThrow('403');
    }
    const response = await fetch(url, { headers: { origin: ORIGIN } });
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const socket = await authenticated();
    expect(await rpc(socket, 'ping')).toHaveProperty('pong');
    socket.close();
  });

  it('wrong token, wrong first method and malformed JSON close without granting access', async () => {
    for (const payload of [
      JSON.stringify({ id: 1, method: 'bridge.auth', params: { token: 'synthetic-wrong-token' } }),
      JSON.stringify({ id: 1, method: 'ping' }),
      '{invalid-json',
      'null',
      '[]',
      '42',
      '"text"',
    ]) {
      const socket = await connect();
      const messages: string[] = [];
      socket.on('message', (raw) => messages.push(String(raw)));
      const ended = closed(socket);
      socket.send(payload);
      expect(await ended).toBe(1008);
      expect(messages).toEqual([]);
    }
    const malformedAuthenticated = await authenticated();
    const authenticatedEnded = closed(malformedAuthenticated);
    malformedAuthenticated.send('null');
    expect(await authenticatedEnded).toBe(1008);
    const good = await authenticated();
    expect(await rpc(good, 'ping')).toHaveProperty('pong');
    good.close();
  });

  it('unauthenticated clients receive no notebook broadcasts and expire after authentication deadline', async () => {
    const idle = await connect();
    const messages: string[] = [];
    idle.on('message', (raw) => messages.push(String(raw)));
    const ended = closed(idle);
    const good = await authenticated();
    const observed: string[] = [];
    good.on('message', (raw) => { const msg = JSON.parse(String(raw)); if (!('id' in msg)) observed.push(msg.method); });
    const notebook = path.join(dataDir, 'broadcast-fixture.py');
    writeFileSync(notebook, '# %% [cell-id: a]\nx = 1\n');
    let notebookId: string | undefined;
    try {
      const opened = await rpc(good, 'notebook.open', { path: notebook }) as { notebookId: string };
      notebookId = opened.notebookId;
      expect(observed).toContain('session.started');
      expect(await ended).toBe(1008);
      expect(messages).toEqual([]);
    } finally {
      if (notebookId) await rpc(good, 'notebook.close', { notebookId });
      good.close();
    }
  }, 20_000);

  it('production proxy rejects unauthorized traffic, strips local headers and survives unreachable upstream', async () => {
    const seen: { headers: http.IncomingHttpHeaders; body: string }[] = [];
    const upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => { seen.push({ headers: req.headers, body }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as import('node:net').AddressInfo).port;
    const good = await authenticated();
    try {
      await rpc(good, 'providers.set', {
        id: 'local-acceptance', kind: 'anthropic-compat', name: 'Synthetic local upstream',
        baseURL: `http://127.0.0.1:${upstreamPort}/v1`, model: 'synthetic',
      });
      const url = `http://127.0.0.1:${info.llmPort}/llm/local-acceptance/v1/messages`;
      for (const token of [undefined, 'wrong-synthetic-token']) {
        const response = await fetch(url, { method: 'POST', headers: { origin: ORIGIN, ...(token ? { 'x-novalab-bridge-token': token } : {}) }, body: '{}' });
        expect(response.status).toBe(401);
      }
      const foreign = await fetch(url, { method: 'POST', headers: { origin: FOREIGN, 'x-novalab-bridge-token': info.token }, body: '{}' });
      expect(foreign.status).toBe(403);
      expect(seen).toEqual([]);
      const preflight = await fetch(url, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-novalab-bridge-token' } });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(ORIGIN);
      const response = await fetch(url, {
        method: 'POST', body: '{"synthetic":"request"}',
        headers: { origin: ORIGIN, 'x-novalab-bridge-token': info.token, authorization: 'Bearer proxy', 'x-api-key': 'proxy', cookie: 'synthetic=private', 'content-type': 'application/json' },
      });
      expect(response.status).toBe(200);
      expect(seen).toHaveLength(1);
      for (const key of ['x-novalab-bridge-token', 'authorization', 'x-api-key', 'cookie', 'origin']) expect(seen[0]!.headers).not.toHaveProperty(key);
      expect(seen[0]!.body).toBe('{"synthetic":"request"}');
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      const unreachable = await fetch(url, { method: 'POST', headers: { origin: ORIGIN, 'x-novalab-bridge-token': info.token }, body: '{}', signal: AbortSignal.timeout(3_000) });
      expect(unreachable.status).toBe(502);
      expect(await rpc(good, 'ping')).toHaveProperty('pong');
    } finally {
      good.close();
      upstream.closeAllConnections();
      upstream.close();
    }
  }, 20_000);

  it('restart rotates the token and the previous token cannot authenticate to the new process', async () => {
    const previousToken = info.token;
    await stop();
    await launch();
    expect(info.token === previousToken).toBe(false);
    const stale = await connect();
    const ended = closed(stale);
    stale.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'bridge.auth', params: { token: previousToken } }));
    expect(await ended).toBe(1008);
    const good = await authenticated();
    expect(await rpc(good, 'ping')).toHaveProperty('pong');
    good.close();
  }, 20_000);
});
