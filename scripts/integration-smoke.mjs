/**
 * G1 集成冒烟：bridge(真) + novakernel(真) + WS 客户端(模拟前端)。
 * 用法（仓库根）：node scripts/integration-smoke.mjs
 * 前置：bridge 依赖已装、uv 环境已 sync。仅依赖冻结协议（spec §6.1/§6.2）。
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSmokeBridge } from './smoke-runtime.mjs';

// 自建 fixture：notebook 与相邻的 UI/session sidecar 都只写入本次临时目录。
export const SMOKE_FIXTURE = `# /// script
# requires-python = ">=3.11"
# dependencies = ["pandas"]
# ///

# %% [cell-id: a0b0c001]
import pandas as pd

df = pd.DataFrame({
    "county": ["沈阳", "大连", "沈阳", "鞍山"],
    "pop": [9.1, 7.5, 0.9, 3.4],
    "year": [2024, 2024, 2025, 2025],
})
df

# %% [cell-id: a0b0c002]
total = df.groupby("county")["pop"].sum()
total

# %% [cell-id: a0b0c003]
print(f"counties={len(total)} max={total.max()}")
`;

const fail = (msg) => { throw new Error(msg); };

export async function runIntegrationSmoke({ fixture = SMOKE_FIXTURE, ...options } = {}) {
  await withSmokeBridge(fixture, async ({ bridge, notebookPath, stage }) => {
    const rpc = (method, params = {}, options = {}) => bridge.rpc(method, params, options);
    const waitNotif = (method, timeoutMs = 15000) => bridge.waitNotif(method, () => true, timeoutMs);

    // P3.1：notebook.open 响应升级为 {notebookId, state}
    const openRes = await rpc('notebook.open', { path: notebookPath });
    await stage('opened');
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
    for (const cell of [c1, c2, c3]) {
      const result = await rpc('cell.run', { cellId: cell.id, cascade: false });
      if (!result?.ok) fail(`run ${cell.id}: ${JSON.stringify(result)}`);
    }
    await waitNotif('run.done');

    // L-5：DataFrame → plain + html；Series → plain；print → 无 mime。
    const mimesOf = (cellId) =>
      bridge.notifications.filter((n) => n.method === 'run.mime' && n.params?.cellId === cellId).map((n) => n.params.mime);
    const m1 = mimesOf(c1.id).sort().join(',');
    if (m1 !== 'text/html,text/plain') fail(`c1 run.mime=${m1 || '(none)'}，应为 text/html,text/plain`);
    const m2 = mimesOf(c2.id).join(',');
    if (m2 !== 'text/plain') fail(`c2 run.mime=${m2 || '(none)'}，应为 text/plain`);
    if (mimesOf(c3.id).length !== 0) fail(`c3 不应有 run.mime: ${mimesOf(c3.id)}`);
    // 隐私（spec §8）：agent 读面只拿 mime 键名，不得含 DataFrame 单元格值。
    const agentOut = await rpc('agent.cellOutput', { cellId: c1.id });
    if (agentOut?.mimeKeys?.slice().sort().join(',') !== 'text/html,text/plain') {
      fail(`agent.cellOutput mimeKeys=${JSON.stringify(agentOut?.mimeKeys)}`);
    }
    if (JSON.stringify(agentOut).includes('沈阳')) fail('agent.cellOutput 泄漏了 mime 数据');
    console.log(`display ok: c1=[${m1}] c2=[${m2}] agent mimeKeys=${agentOut.mimeKeys.join(',')}`);

    const vars = await rpc('kernel.vars');
    const dfSchema = vars.schemas.find((s) => s.name === 'df');
    if (!dfSchema?.shape) fail('kernel.vars 缺 df schema');
    console.log(`vars ok: df shape=${dfSchema.shape} columns=${dfSchema.columns?.length}`);

    // 反应式语义：改 c1 → c2/c3 应进 staleSet；落盘只作用于临时 notebook。
    const editedCode = c1.code.replace('0.9', '1.9');
    if (editedCode === c1.code) fail('smoke fixture 缺少可修改的 pop 值');
    const saved = await rpc('cell.save', { cellId: c1.id, code: editedCode });
    if (!saved?.staleSet?.includes(c2.id)) fail(`cell.save staleSet=${JSON.stringify(saved)}`);
    console.log(`reactive ok: staleSet=${saved.staleSet.length} cells`);
    await stage('saved');
  }, options);
  console.log('INTEGRATION_SMOKE_OK');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runIntegrationSmoke();
  } catch (error) {
    console.error('SMOKE_FAIL:', error.message);
    process.exitCode = error.signal === 'SIGINT' ? 130 : error.signal === 'SIGTERM' ? 143 : error.signal === 'SIGHUP' ? 129 : 1;
  }
}
