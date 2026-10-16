import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import { BridgeClient } from './bridge-client.mjs';

const require = createRequire(new URL('../bridge/package.json', import.meta.url));
const { WebSocketServer } = require('ws');

async function within(promise, timeoutMs = 1000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('test deadline exceeded')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(t, options = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const client = new BridgeClient(options);
  t.after(async () => {
    client.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  await once(server, 'listening');

  // Only discovery is replaced. Authentication and RPCs use real loopback sockets.
  const token = 'synthetic-test-token';
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/bridge-info$/);
    assert.equal(init.headers.Origin, 'http://127.0.0.1:5199');
    return new Response(JSON.stringify({
      wsUrl: `ws://127.0.0.1:${server.address().port}`,
      token,
      llmProxyOrigin: 'http://127.0.0.1:1',
    }));
  });

  const requests = [];
  const waiters = [];
  const authWaiters = [];
  let allowAuthentication = true;
  server.on('connection', (socket) => {
    let authenticated = false;
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (!authenticated) {
        assert.equal(message.method, 'bridge.auth');
        assert.equal(message.params.token, token);
        authenticated = true;
        if (allowAuthentication) {
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } }));
        }
        if (authWaiters.length) authWaiters.shift()({ socket, message });
        return;
      }
      const request = { socket, message };
      if (waiters.length) waiters.shift()(request);
      else requests.push(request);
    });
  });
  await within(client.connect());
  return {
    client,
    holdNextAuthentication: () => {
      allowAuthentication = false;
      return within(new Promise((resolve) => authWaiters.push(resolve)));
    },
    nextRequest: () => within(requests.length
      ? Promise.resolve(requests.shift())
      : new Promise((resolve) => waiters.push(resolve))),
  };
}

function trackTimers(t) {
  const active = new Map();
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    const timer = set(() => {
      active.delete(timer);
      callback(...args);
    }, delay);
    // Count client deadlines, excluding ws's close-handshake and test watchdog timers.
    const stack = new Error().stack;
    if (stack.includes('bridge-client.mjs:') && !stack.includes('node_modules')) active.set(timer, delay);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer) => {
    active.delete(timer);
    clear(timer);
  });
  return active;
}

function reply({ socket, message }, result) {
  socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
}

test('authenticated disconnect rejects every in-flight RPC and empties pending', { timeout: 3000 }, async (t) => {
  const { client, nextRequest } = await fixture(t);
  const timers = trackTimers(t);
  const results = Promise.allSettled([
    client.rpc('notebook.state'),
    client.rpc('kernel.vars'),
    client.rpc('cell.run', { cellId: 'long-running-cell' }),
  ]);
  const { socket } = await nextRequest();
  await nextRequest();
  await nextRequest();
  assert.equal(client.pending.size, 3);
  assert.deepEqual([...timers.values()], [20_000, 20_000]); // Execution RPCs have no default deadline.

  const closed = once(client.ws, 'close');
  socket.terminate();
  await within(closed);
  assert.equal(client.pending.size, 0);
  const settled = await within(results);
  assert.ok(settled.every((result) => result.status === 'rejected'));
  for (const result of settled) assert.match(result.reason.message, /连接关闭/);
  assert.equal(timers.size, 0);
  await assert.rejects(client.rpc('notebook.state'), /未连接/);
});

test('close immediately rejects pending RPCs and releases timers', { timeout: 3000 }, async (t) => {
  const { client, nextRequest } = await fixture(t);
  const timers = trackTimers(t);
  const result = Promise.allSettled([client.rpc('notebook.state'), client.rpc('cell.run')]);
  await nextRequest();
  await nextRequest();
  client.close();
  assert.equal(client.pending.size, 0);
  assert.equal(timers.size, 0);
  assert.ok((await within(result)).every((item) => item.status === 'rejected'));
  await assert.rejects(client.rpc('notebook.state'), /未连接/);
  client.close(); // Idempotent, including before the close handshake completes.
});

test('successful results and RPC errors clean up, preserving notifications', { timeout: 3000 }, async (t) => {
  const { client, nextRequest } = await fixture(t);
  const timers = trackTimers(t);
  const success = client.rpc('notebook.state');
  const failure = assert.rejects(client.rpc('unknown.method'), /-32601: synthetic RPC error/);
  const first = await nextRequest();
  const second = await nextRequest();
  first.socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'kernel.status', params: { state: 'idle' } }));
  reply(first, { cells: [] });
  second.socket.send(JSON.stringify({
    jsonrpc: '2.0', id: second.message.id, error: { code: -32601, message: 'synthetic RPC error' },
  }));
  assert.deepEqual(await within(success), { cells: [] });
  await within(failure);
  assert.equal(client.pending.size, 0);
  assert.equal(timers.size, 0);
  assert.deepEqual(client.notifications, [{ method: 'kernel.status', params: { state: 'idle' } }]);
});

test('a silent RPC times out without poisoning the connection or late replies', { timeout: 3000 }, async (t) => {
  const { client, nextRequest } = await fixture(t, { rpcTimeoutMs: 60 });
  const timers = trackTimers(t);
  const timedOut = assert.rejects(client.rpc('notebook.state'), /RPC 超时.*notebook.state.*60/);
  const late = await nextRequest();
  await within(timedOut);
  assert.equal(client.pending.size, 0);
  assert.equal(timers.size, 0);

  reply(late, { stale: true });
  const next = client.rpc('kernel.vars');
  reply(await nextRequest(), { schemas: [] });
  assert.deepEqual(await within(next), { schemas: [] });
  assert.equal(client.pending.size, 0);
  assert.equal(timers.size, 0);
  assert.deepEqual(client.notifications, []);
});

test('send throws, send callback errors, and serialization errors all clean up', { timeout: 3000 }, async (t) => {
  const { client, nextRequest } = await fixture(t);
  const timers = trackTimers(t);
  const send = client.ws.send;
  t.mock.method(client.ws, 'send', () => { throw new Error('synthetic send throw'); });
  await assert.rejects(client.rpc('notebook.state'), /synthetic send throw/);
  assert.equal(client.pending.size, 0);
  assert.equal(timers.size, 0);

  t.mock.method(client.ws, 'send', (_data, callback) => {
    queueMicrotask(() => callback(new Error('synthetic send callback error')));
  });
  await assert.rejects(client.rpc('notebook.state'), /synthetic send callback error/);
  assert.equal(client.pending.size, 0);
  assert.equal(timers.size, 0);

  t.mock.method(client.ws, 'send', send);
  const circular = {};
  circular.self = circular;
  await assert.rejects(client.rpc('notebook.state', circular), /circular/i);
  assert.equal(client.pending.size, 0);
  assert.equal(timers.size, 0);
  const next = client.rpc('kernel.vars');
  reply(await nextRequest(), { schemas: [] });
  assert.deepEqual(await within(next), { schemas: [] });
  assert.equal(timers.size, 0);
});

test('per-request deadlines override the client default, including zero', { timeout: 3000 }, async (t) => {
  const { client, nextRequest } = await fixture(t, { rpcTimeoutMs: 60 });
  const timers = trackTimers(t);
  const disabled = client.rpc('notebook.state', {}, { timeoutMs: 0 });
  const waiting = await nextRequest();
  const timeout = assert.rejects(client.rpc('kernel.vars', {}, { timeoutMs: 100 }), /RPC 超时.*kernel.vars.*100/);
  await nextRequest();
  await within(timeout);
  assert.equal(client.pending.size, 1);
  assert.equal(timers.size, 0);
  reply(waiting, { cells: [] });
  assert.deepEqual(await within(disabled), { cells: [] });
  assert.equal(client.pending.size, 0);
});

test('long execution RPCs ignore the ordinary deadline by default', { timeout: 3000 }, async (t) => {
  const { client, nextRequest } = await fixture(t, { rpcTimeoutMs: 60 });
  const timers = trackTimers(t);
  const methods = ['cell.run', 'kernel.repl', 'diff.accept', 'control.set'];
  const results = Promise.all(methods.map((method) => client.rpc(method)));
  const requests = [];
  for (const method of methods) {
    const request = await nextRequest();
    assert.equal(request.message.method, method);
    requests.push(request);
  }
  const timedOut = assert.rejects(client.rpc('notebook.state'), /RPC 超时/);
  await nextRequest();
  await within(timedOut);
  assert.equal(client.pending.size, methods.length);
  assert.equal(timers.size, 0);
  for (const request of requests) reply(request, { ok: true });
  assert.deepEqual(await within(results), methods.map(() => ({ ok: true })));
  assert.equal(client.pending.size, 0);
});

test('execution deadlines can be set separately and overridden per request', { timeout: 3000 }, async (t) => {
  const { client, nextRequest } = await fixture(t, { rpcTimeoutMs: 60, runTimeoutMs: 100 });
  const timers = trackTimers(t);
  const runTimeout = assert.rejects(client.rpc('cell.run'), /RPC 超时.*cell.run.*100/);
  const override = assert.rejects(client.rpc('kernel.repl', {}, { timeoutMs: 80 }), /RPC 超时.*kernel.repl.*80/);
  await nextRequest();
  await nextRequest();
  await within(Promise.all([runTimeout, override]));
  assert.equal(client.pending.size, 0);
  assert.equal(timers.size, 0);
});

test('bootstrap RPCs survive the ordinary deadline and return their results', { timeout: 3000 }, async (t) => {
  const { client, nextRequest } = await fixture(t, { rpcTimeoutMs: 60 });
  const timers = trackTimers(t);
  const methods = ['notebook.open', 'kernel.restart', 'notebook.reload'];
  const results = Promise.allSettled(methods.map((method) => client.rpc(method)));
  const requests = [];
  for (const method of methods) {
    const request = await nextRequest();
    assert.equal(request.message.method, method);
    requests.push(request);
  }
  const ordinaryTimeout = assert.rejects(client.rpc('notebook.state'), /RPC 超时/);
  await nextRequest();
  await within(ordinaryTimeout);
  assert.equal(client.pending.size, methods.length);
  assert.equal(timers.size, 0);
  requests.forEach((request, index) => reply(request, { ready: methods[index] }));
  assert.deepEqual(await within(results), methods.map((method) => ({
    status: 'fulfilled', value: { ready: method },
  })));
  assert.equal(client.pending.size, 0);
  assert.equal(timers.size, 0);
});

test('bootstrap RPCs share runTimeoutMs and allow individual deadline overrides', { timeout: 3000 }, async (t) => {
  const { client, nextRequest } = await fixture(t, { rpcTimeoutMs: 60, runTimeoutMs: 100 });
  const timers = trackTimers(t);
  const openTimeout = assert.rejects(client.rpc('notebook.open'), /RPC 超时.*notebook.open.*100/);
  const restartTimeout = assert.rejects(client.rpc('kernel.restart', {}, { timeoutMs: 80 }), /RPC 超时.*kernel.restart.*80/);
  const reloadTimeout = assert.rejects(client.rpc('notebook.reload'), /RPC 超时.*notebook.reload.*100/);
  const withoutDeadline = Promise.allSettled([client.rpc('notebook.open', {}, { timeoutMs: 0 })]);
  await nextRequest();
  await nextRequest();
  await nextRequest();
  const waiting = await nextRequest();
  await within(Promise.all([openTimeout, restartTimeout, reloadTimeout]));
  assert.equal(client.pending.size, 1);
  assert.equal(timers.size, 0);
  reply(waiting, { ready: true });
  assert.deepEqual(await within(withoutDeadline), [{ status: 'fulfilled', value: { ready: true } }]);
  assert.equal(client.pending.size, 0);
});

for (const payload of ['{invalid-json', 'null', '[]', '42', '"text"', 'true']) {
  test(`invalid bridge message ${payload} rejects pending work and clears timers`, { timeout: 3000 }, async (t) => {
    const { client, nextRequest } = await fixture(t);
    const timers = trackTimers(t);
    const results = Promise.allSettled([client.rpc('notebook.state'), client.rpc('cell.run')]);
    const { socket } = await nextRequest();
    await nextRequest();
    socket.send(payload);
    const settled = await within(results);
    assert.ok(settled.every((result) => result.status === 'rejected' && /bridge 消息无效/.test(result.reason.message)));
    assert.equal(client.pending.size, 0);
    assert.equal(timers.size, 0);
    assert.equal(client.ws, null);
    assert.equal(client.authenticated, false);
    await assert.rejects(client.rpc('notebook.state'), /未连接/);
  });
}

test('invalid authentication messages reject connect and clear the auth timer', { timeout: 3000 }, async (t) => {
  const { client, holdNextAuthentication } = await fixture(t);
  client.close();
  const timers = trackTimers(t);
  const authReceived = holdNextAuthentication();
  const rejected = assert.rejects(client.connect(), /bridge 消息无效/);
  const { socket } = await authReceived;
  assert.deepEqual([...timers.values()], [3000]);
  socket.send('null');
  await within(rejected);
  assert.equal(client.pending.size, 0);
  assert.equal(timers.size, 0);
  assert.equal(client.ws, null);
});

test('invalid deadline configuration is rejected before sending', { timeout: 3000 }, async (t) => {
  for (const invalid of [-1, NaN, Infinity, 1.5, 2147483648, '60', null]) {
    assert.throws(() => new BridgeClient({ rpcTimeoutMs: invalid }), /timeoutMs/);
    assert.throws(() => new BridgeClient({ runTimeoutMs: invalid }), /timeoutMs/);
  }
  const { client } = await fixture(t);
  const timers = trackTimers(t);
  await assert.rejects(client.rpc('notebook.state', {}, { timeoutMs: -1 }), /timeoutMs/);
  assert.equal(client.pending.size, 0);
  assert.equal(timers.size, 0);
});

test('RPCs on a closing socket reject immediately without creating pending work', { timeout: 3000 }, async (t) => {
  const { client } = await fixture(t);
  const timers = trackTimers(t);
  client.ws.close();
  await assert.rejects(client.rpc('notebook.state'), /未连接/);
  assert.equal(client.pending.size, 0);
  assert.equal(timers.size, 0);
});

test('reconnect survives a previous socket close and accepts new RPCs', { timeout: 3000 }, async (t) => {
  const { client, nextRequest } = await fixture(t);
  const timers = trackTimers(t);
  const oldSocket = client.ws;
  const oldClosed = once(oldSocket, 'close');
  const rejected = assert.rejects(client.rpc('notebook.state'), /客户端已关闭/);
  await nextRequest();
  client.close();
  await within(client.connect());
  await within(oldClosed);
  await within(rejected);
  const connectedSocket = client.ws;
  assert.notEqual(connectedSocket, oldSocket);
  assert.equal(timers.size, 0);
  oldSocket.emit('close', 1006); // Delayed old events cannot invalidate the new connection.
  oldSocket.emit('message', Buffer.from('null'));
  assert.equal(client.ws, connectedSocket);
  const result = client.rpc('kernel.vars');
  reply(await nextRequest(), { schemas: [] });
  assert.deepEqual(await within(result), { schemas: [] });
  assert.equal(client.pending.size, 0);
  assert.equal(timers.size, 0);
});

test('closing during authentication rejects connect and clears its timer', { timeout: 3000 }, async (t) => {
  const { client, holdNextAuthentication } = await fixture(t);
  client.close();
  const timers = trackTimers(t);
  const authReceived = holdNextAuthentication();
  const rejected = assert.rejects(client.connect(), /连接关闭/);
  await authReceived;
  assert.equal(client.authenticated, false);
  assert.deepEqual([...timers.values()], [3000]);
  await assert.rejects(client.rpc('notebook.state'), /未连接/);
  client.close();
  await within(rejected);
  assert.equal(client.ws, null);
  assert.equal(client.pending.size, 0);
  assert.equal(timers.size, 0);
});

test('socket errors reject all pending RPCs and release timers', { timeout: 3000 }, async (t) => {
  const { client, nextRequest } = await fixture(t);
  const timers = trackTimers(t);
  const results = Promise.allSettled([client.rpc('notebook.state'), client.rpc('kernel.vars')]);
  await nextRequest();
  await nextRequest();
  client.ws.emit('error', new Error('synthetic socket error'));
  const settled = await within(results);
  assert.ok(settled.every((result) => result.status === 'rejected' && /synthetic socket error/.test(result.reason.message)));
  assert.equal(client.pending.size, 0);
  assert.equal(timers.size, 0);
  await assert.rejects(client.rpc('notebook.state'), /未连接/);
});
