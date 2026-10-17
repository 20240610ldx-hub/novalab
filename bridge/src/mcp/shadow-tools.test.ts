import { describe, expect, it } from 'vitest';
import { AGENT_TOOL_NAMES, executeAgentTool, sanitizeToolOutput, type AgentToolHost } from './tools';
import { guardHost, TOOL_ROUTER_METHODS } from '../agent-runtime/policy';

/**
 * ADR-013：shadow_run / verify 两个新工具 + propose_code_change 的核验参数，
 * 单一来源 schema（Vercel / pi / MCP 共用）与第二道 M5 闸（F1 白名单）。
 */

const CANARY = 'CANARY_ROW_7f3a';

function recordingHost(impl?: (method: string, params?: unknown) => Promise<unknown>) {
  const calls: { method: string; params?: unknown }[] = [];
  const host: AgentToolHost = {
    invoke(method, params) {
      calls.push({ method, params });
      return impl ? impl(method, params) : Promise.resolve({});
    },
  };
  return { host, calls };
}

const report = {
  runId: 'shadow-1',
  verificationId: 'ver-1',
  status: 'ok',
  after: {
    plan: { changed: ['b'], upstream: ['a'], closure: ['b'] },
    cells: [{ id: 'b', role: 'closure', ok: true, durationMs: 3, stdout: CANARY }],
  },
  before: { cells: [{ id: 'a', role: 'upstream', ok: true, durationMs: 1 }] },
  vars: [
    {
      name: 'df',
      after: {
        schema: { type: 'DataFrame', shape: [10, 2], columns: ['a', 'b'], dtypes: { a: 'int64', b: 'object' }, preview: [CANARY] },
        stats: { columns: { a: { count: 10, nullCount: 0, sum: 5, top: CANARY }, b: { count: 10, nullCount: 0, nUnique: 3 } } },
      },
      delta: { stats: { a: { sum: 1 } }, rows: [CANARY] },
    },
  ],
  autoChecks: [{ id: 'auto:non_empty:df', kind: 'non_empty', status: 'fail', total: 0, violations: 1 }],
  blocked: [{ kind: 'file-write', count: 2 }],
  nondeterminism: [],
  figures: 0,
  durationMs: 9,
  budget: { runsUsed: 1, runsLimit: 8, msUsed: 9, msLimit: 300000 },
  leaked: CANARY,
};

describe('工具 schema 与转发', () => {
  it('新工具在单一来源里，pi 宿主白名单同步放行', () => {
    expect(AGENT_TOOL_NAMES).toContain('shadow_run');
    expect(AGENT_TOOL_NAMES).toContain('verify');
    expect(TOOL_ROUTER_METHODS.shadow_run).toBe('shadow.run');
    expect(TOOL_ROUTER_METHODS.verify).toBe('shadow.verify');
  });

  it('shadow_run / verify / propose_code_change 转发到 router', async () => {
    const { host, calls } = recordingHost();
    const changes = [{ targetCellId: 'b', action: 'update', newCode: 'y = 2' }];
    await executeAgentTool(host, 'shadow_run', { changes });
    await executeAgentTool(host, 'verify', { runId: 'shadow-1', contracts: [{ kind: 'not_null', target: 'df', columns: ['a'] }] });
    await executeAgentTool(host, 'propose_code_change', {
      targetCellId: 'b', action: 'update', newCode: 'y = 2', verificationId: 'ver-1', intent: 'refactor',
    });
    expect(calls.map((c) => c.method)).toEqual(['shadow.run', 'shadow.verify', 'diff.stage']);
    expect(calls[0]!.params).toEqual({ changes });
    expect(calls[2]!.params).toMatchObject({ verificationId: 'ver-1', intent: 'refactor' });
  });

  it('非法契约种类 / 空改动在 schema 层就被拒', async () => {
    const { host, calls } = recordingHost();
    await expect(executeAgentTool(host, 'verify', { runId: 'r', contracts: [{ kind: 'drop_table' }] })).rejects.toThrow();
    await expect(executeAgentTool(host, 'shadow_run', { changes: [] })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('abortSignal → shadow.cancel（F4）；pi 受限宿主放行 shadow.cancel', async () => {
    let release!: (v: unknown) => void;
    const { host, calls } = recordingHost((method) =>
      method === 'shadow.run' ? new Promise((r) => (release = r)) : Promise.resolve({ cancelled: true }),
    );
    const ac = new AbortController();
    const pending = executeAgentTool(guardHost(host), 'shadow_run', { changes: [{ targetCellId: 'b', action: 'update', newCode: 'y = 2' }] }, { signal: ac.signal });
    ac.abort();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.map((c) => c.method)).toEqual(['shadow.run', 'shadow.cancel']);
    release({ runId: 'shadow-1', status: 'cancelled', budget: report.budget });
    await pending;
  });
});

describe('第二道 M5 闸：影子报告白名单', () => {
  it('shadow_run：嵌套白名单外字段被丢弃，合法字段保留', () => {
    const gate = sanitizeToolOutput('shadow_run', report);
    expect(gate.redacted).toBe(false);
    expect(JSON.stringify(gate.output)).not.toContain(CANARY);
    expect(gate.droppedKeys).toEqual(
      expect.arrayContaining(['leaked', 'after.cells[0].stdout', 'vars[0].after.schema.preview', 'vars[0].delta.rows']),
    );
    const out = gate.output as typeof report;
    expect(out.vars[0]!.after.stats.columns.b).toEqual({ count: 10, nullCount: 0, nUnique: 3 });
    expect(out.autoChecks[0]).toMatchObject({ kind: 'non_empty', status: 'fail' });
  });

  it('shadow_run 拒绝形状（denied）与 verify 报告可达模型', () => {
    const denied = { denied: true, reason: 'user-declined', message: 'The user declined.' };
    expect(sanitizeToolOutput('shadow_run', denied).output).toEqual(denied);
    const ver = {
      runId: 'shadow-1', verificationId: 'ver-2', status: 'fail',
      contracts: [{ id: 'k1', kind: 'range', phase: 'after', status: 'fail', total: 10, violations: 2, echo: CANARY }],
    };
    const gate = sanitizeToolOutput('verify', ver);
    expect(gate.droppedKeys).toEqual(['contracts[0].echo']);
    expect(JSON.stringify(gate.output)).not.toContain(CANARY);
  });

  it('propose_code_change 结果携带核验状态', () => {
    const staged = { diffId: 'diff-1', verification: { status: 'verified', level: 'V2', missing: [] } };
    expect(sanitizeToolOutput('propose_code_change', staged).output).toEqual(staged);
  });
});
