/**
 * G1 集成冒烟：bridge(真) + novakernel(真) + WS 客户端(模拟前端)。
 * 用法（仓库根）：node scripts/integration-smoke.mjs
 * 前置：bridge 依赖已装、uv 环境已 sync。仅依赖冻结协议（spec §6.1/§6.2）。
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeClient } from './bridge-client.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'bridge', 'package.json'));

const DEMO = join(root, 'demos', 'demo.py');
// smoke 的 cell.save 会落盘（幂等 toggle 改 pop 值）：进程退出时还原字节，保持仓库干净
const demoOriginal = readFileSync(DEMO, 'utf8');
process.on('exit', () => {
  try {
    writeFileSync(DEMO, demoOriginal);
  } catch {
    /* best-effort */
  }
});
const fail = (msg) => {
  console.error('SMOKE_FAIL:', msg);
  process.exit(1);
};

const bridgeProcess = spawn(process.execPath, [require.resolve('tsx/cli'), join(root, 'bridge', 'src', 'main.ts')], {
  cwd: join(root, 'bridge'),
  stdio: ['ignore', 'pipe', 'pipe'],
});
bridgeProcess.stdout.on('data', (d) => process.stdout.write(`[bridge] ${d}`));
bridgeProcess.stderr.on('data', (d) => process.stderr.write(`[bridge!] ${d}`));

const bridge = new BridgeClient();
let connected = false;
for (let attempt = 0; attempt < 30 && !connected; attempt += 1) {
  try {
    await bridge.connect();
    connected = true;
  } catch {
    if (attempt === 29) throw new Error('bridge 未就绪');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
const rpc = (method, params = {}) => bridge.rpc(method, params);
const waitNotif = (method, timeoutMs = 15000) => bridge.waitNotif(method, () => true, timeoutMs);

// P3.1：notebook.open 响应升级为 {notebookId, state}
const openRes = await rpc('notebook.open', { path: DEMO });
if (!openRes?.notebookId) fail(`notebook.open 缺 notebookId: ${JSON.stringify(openRes)}`);
const state = openRes.state;
if (state?.cells?.length !== 3) fail(`notebook.open cells=${state?.cells?.length}`);
console.log(`open ok: notebookId=${openRes.notebookId} cells=${state.cells.length} edges=${state.dagEdges.length}`);

// P3.1：notebook.list 反映已打开的 tab（含 rssMB 字段形状）
const list = await rpc('notebook.list');
if (!Array.isArray(list) || list.length !== 1) fail(`notebook.list len=${list?.length}`);
if (list[0].notebookId !== openRes.notebookId) fail('notebook.list notebookId 不匹配');
if (!('rssMB' in list[0])) fail('notebook.list 缺 rssMB 字段');
console.log(`list ok: n=${list.length} kernelState=${list[0].kernelState} rssMB=${list[0].rssMB}`);

const [c1, c2, c3] = state.cells;
const r1 = await rpc('cell.run', { cellId: c1.id, cascade: false });
if (!r1?.ok) fail(`run c1: ${JSON.stringify(r1)}`);
const r2 = await rpc('cell.run', { cellId: c2.id, cascade: false });
if (!r2?.ok) fail(`run c2: ${JSON.stringify(r2)}`);
const r3 = await rpc('cell.run', { cellId: c3.id, cascade: false });
if (!r3?.ok) fail(`run c3: ${JSON.stringify(r3)}`);
await waitNotif('run.done');

const vars = await rpc('kernel.vars');
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
if (!saved?.staleSet?.includes(c2.id)) fail(`cell.save staleSet=${JSON.stringify(saved)}`);
console.log(`reactive ok: staleSet=${saved.staleSet.length} cells`);

console.log('INTEGRATION_SMOKE_OK');
bridge.close();
bridgeProcess.kill();
process.exit(0);
