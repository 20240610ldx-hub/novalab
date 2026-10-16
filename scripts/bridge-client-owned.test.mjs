import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import { BridgeClient } from './bridge-client.mjs';

const require = createRequire(new URL('../bridge/package.json', import.meta.url));
const { WebSocketServer } = require('ws');

for (const rejectAuth of [false, true]) {
  test(`explicit connection skips discovery, including auth failure=${rejectAuth}`, { timeout: 3000 }, async (t) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const client = new BridgeClient();
    t.after(async () => {
      client.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    });
    await once(server, 'listening');
    const info = { wsUrl: `ws://127.0.0.1:${server.address().port}/`, token: 'own-test-token', llmProxyOrigin: 'http://127.0.0.1:1' };
    const discovery = t.mock.method(globalThis, 'fetch', () => { throw new Error('explicit connect must not discover'); });
    server.on('connection', (socket) => socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      assert.equal(msg.method, 'bridge.auth');
      assert.equal(msg.params.token, info.token);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...(rejectAuth
        ? { error: { code: -1, message: 'synthetic auth failure' } }
        : { result: { ok: true } }) }));
    }));
    if (rejectAuth) await assert.rejects(client.connect(info), /synthetic auth failure/);
    else await client.connect(info);
    assert.equal(discovery.mock.callCount(), 0);
    assert.equal(client.info.wsUrl, info.wsUrl);
  });
}
