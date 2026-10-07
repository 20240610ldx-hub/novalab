/**
 * G1 集成冒烟：bridge(真) + novakernel(真) + WS 客户端(模拟前端)。
 * 用法（仓库根）：node scripts/integration-smoke.mjs
 * 前置：bridge 依赖已装、uv 环境已 sync。仅依赖冻结协议（spec §6.1/§6.2）。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'bridge', 'package.json'));
const { WebSocket } = require('ws');

const DEMO = join(root, 'demos', 'demo.py');
const fail = (msg) => {
  console.error('SMOKE_FAIL:', msg);
  process.exit(1);
};

const bridge = spawn(process.execPath, [require.resolve('tsx/cli'), join(root, 'bridge', 'src', 'main.ts')], {
  cwd: join(root, 'bridge'),
  stdio: ['ignore', 'pipe', 'pipe'],
});
bridge.stdout.on('data', (d) => process.stdout.write(`[bridge] ${d}`));
bridge.stderr.on('data', (d) => process.stderr.write(`[bridge!] ${d}`));

const ws = await new Promise((resolve, reject) => {
  const tryConnect = (n) => {
    const s = new WebSocket('ws://127.0.0.1:7788');
    s.on('open', () => resolve(s));
    s.on('error', () => (n > 20 ? reject(new Error('bridge 未就绪')) : setTimeout(() => tryConnect(n + 1), 500)));
  };
  tryConnect(0);
});

let nextId = 1;
const pending = new Map();
const notifications = [];
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else {
    notifications.push(msg);
  }
});
const rpc = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
const waitNotif = (method, timeoutMs = 15000) =>
  new Promise((resolve, reject) => {
    const hit = notifications.find((n) => n.method === method);
    if (hit) return resolve(hit);
    const t0 = Date.now();
    const iv = setInterval(() => {
      const n = notifications.find((x) => x.method === method);
      if (n) {
        clearInterval(iv);
        resolve(n);
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`timeout waiting ${method}`));
      }
    }, 100);
  });

// P3.1：notebook.open 响应升级为 {notebookId, state}
const openRes = (await rpc('notebook.open', { path: DEMO })).result;
if (!openRes?.notebookId) fail(`notebook.open 缺 notebookId: ${JSON.stringify(openRes)}`);
const state = openRes.state;
if (state?.cells?.length !== 3) fail(`notebook.open cells=${state?.cells?.length}`);
console.log(`open ok: notebookId=${openRes.notebookId} cells=${state.cells.length} edges=${state.dagEdges.length}`);

// P3.1：notebook.list 反映已打开的 tab（含 rssMB 字段形状）
const list = (await rpc('notebook.list')).result;
if (!Array.isArray(list) || list.length !== 1) fail(`notebook.list len=${list?.length}`);
if (list[0].notebookId !== openRes.notebookId) fail('notebook.list notebookId 不匹配');
if (!('rssMB' in list[0])) fail('notebook.list 缺 rssMB 字段');
console.log(`list ok: n=${list.length} kernelState=${list[0].kernelState} rssMB=${list[0].rssMB}`);

const [c1, c2, c3] = state.cells;
const r1 = await rpc('cell.run', { cellId: c1.id, cascade: false });
if (!r1.result?.ok) fail(`run c1: ${JSON.stringify(r1)}`);
const r2 = await rpc('cell.run', { cellId: c2.id, cascade: false });
if (!r2.result?.ok) fail(`run c2: ${JSON.stringify(r2)}`);
const r3 = await rpc('cell.run', { cellId: c3.id, cascade: false });
if (!r3.result?.ok) fail(`run c3: ${JSON.stringify(r3)}`);
await waitNotif('run.done');

const vars = (await rpc('kernel.vars')).result;
const dfSchema = vars.schemas.find((s) => s.name === 'df');
if (!dfSchema?.shape) fail('kernel.vars 缺 df schema');
console.log(`vars ok: df shape=${dfSchema.shape} columns=${dfSchema.columns?.length}`);

// 反应式语义：改 c1 → c2/c3 应进 staleSet。
// cell.save 会落盘（P1.8 起），故用幂等 toggle：当前含 1.9 则写回 0.9，反之亦然，
// 保证每次运行都产生真实代码变更且 fixture 语义不变。
const editedCode = c1.code.includes('1.9')
  ? c1.code.replace('1.9', '0.9')
  : c1.code.replace('0.9', '1.9');
if (editedCode === c1.code) fail('demo.py 缺少可 toggle 的 pop 值（0.9/1.9）');
const saved = await rpc('cell.save', { cellId: c1.id, code: editedCode });
if (!saved.result?.staleSet?.includes(c2.id)) fail(`cell.save staleSet=${JSON.stringify(saved.result?.staleSet)}`);
console.log(`reactive ok: staleSet=${saved.result.staleSet.length} cells`);

console.log('INTEGRATION_SMOKE_OK');
ws.close();
bridge.kill();
process.exit(0);
