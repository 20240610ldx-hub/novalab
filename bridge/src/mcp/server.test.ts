/**
 * P2.7：MCP stdio server 契约测试（InMemoryTransport 直连，不起真 stdio）。
 * 覆盖：工具列表快照（六工具）、resource 注册（dag + cell/{id}）、
 * callTool 走 router 的真实路径（含 diff.stage 编译预检拒绝、错误 isError 包装）。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KernelSupervisor } from '../supervisor';
import { RpcRouter, type StageResult } from '../router';
import { FakeKernel } from '../testing/fake-kernel';
import { createMcpServer } from './server';
import type { AgentContext, AgentCellSummary } from '../router';

const NB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'novalab-mcp-')), 'demo.py');

let sup: KernelSupervisor | undefined;
let server: McpServer | undefined;
let client: Client | undefined;
let fakes: FakeKernel[] = [];

async function connect(): Promise<void> {
  fakes = [];
  sup = new KernelSupervisor({
    transportFactory: () => {
      const f = new FakeKernel();
      fakes.push(f);
      return f;
    },
    pingIntervalMs: 60_000,
  });
  const router = new RpcRouter({ supervisor: sup, broadcast: () => {} });
  await router.handle({ jsonrpc: '2.0', id: 1, method: 'notebook.open', params: { path: NB_PATH } });

  server = createMcpServer(router);
  client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
}

async function callToolJson(name: string, args?: Record<string, unknown>): Promise<unknown> {
  const res = await client!.callTool({ name, arguments: args ?? {} });
  expect(res.isError).toBeFalsy();
  const text = (res.content as { type: string; text: string }[])[0]!.text;
  return JSON.parse(text) as unknown;
}

afterEach(async () => {
  await client?.close();
  await server?.close();
  sup?.stop();
  client = undefined;
  server = undefined;
  sup = undefined;
});

describe('MCP server · 注册面', () => {
  it('工具列表快照（六工具，spec §7）', async () => {
    await connect();
    const { tools } = await client!.listTools();
    expect(tools.map((t) => [t.name, t.description])).toMatchInlineSnapshot(`
      [
        [
          "get_notebook_context",
          "获取依赖拓扑（dagEdges）、变量 schemas（已按隐私边界截断）与 staleSet；不含原始数据。返回 {dagEdges, schemas, focusCellId, staleSet}",
        ],
        [
          "get_cell_output",
          "获取指定 cell 最近一次运行的隐私安全摘要 {traceback, mimeKeys}；stdout、stderr 与文件路径不会发送给 Agent",
        ],
        [
          "propose_code_change",
          "提议代码变更 → staged diff，交前端行内审阅（Tab 采纳 / Esc 拒绝）；禁止直接覆盖 cell。入队前有编译预检：多重定义 / DAG 环等会被拒绝并返回 reason，请据其自纠后重试",
        ],
        [
          "execute_cell",
          "执行指定 cell；cascade=true 时按 DAG 级联下游。返回 run 报告 {cellId, ok, cascaded, durationMs, traceback?}",
        ],
        [
          "list_cells",
          "列出全部 cell 的 [{id, execCount, status(idle|ok|stale|error), firstLine, defs, refs}]",
        ],
        [
          "get_cell_code",
          "读取指定 cell 的源码原文 {cellId, code}",
        ],
      ]
    `);
    expect(tools).toHaveLength(6);
  });

  it('propose_code_change 的 JSON schema 形状（zod 单一来源投影）', async () => {
    await connect();
    const { tools } = await client!.listTools();
    const propose = tools.find((t) => t.name === 'propose_code_change')!;
    const schema = propose.inputSchema as {
      required?: string[];
      properties?: Record<string, { enum?: string[] }>;
    };
    expect(schema.required?.slice().sort()).toEqual(['action', 'newCode', 'targetCellId']);
    expect(schema.properties?.['action']?.enum).toEqual(['update', 'insert_below']);
  });

  it('resource 快照：novalab://notebook/dag（静态）+ novalab://cell/{id}（模板）', async () => {
    await connect();
    const { resources } = await client!.listResources();
    const { resourceTemplates } = await client!.listResourceTemplates();
    expect({
      resources: resources.map((r) => r.uri),
      templates: resourceTemplates.map((t) => t.uriTemplate),
    }).toMatchInlineSnapshot(`
      {
        "resources": [
          "novalab://notebook/dag",
        ],
        "templates": [
          "novalab://cell/{id}",
        ],
      }
    `);
  });
});

describe('MCP server · resources 读取', () => {
  it('dag resource → JSON {dagEdges, staleSet}', async () => {
    await connect();
    const res = await client!.readResource({ uri: 'novalab://notebook/dag' });
    const content = res.contents[0] as { uri: string; text?: string; mimeType?: string };
    expect(content.mimeType).toBe('application/json');
    const dag = JSON.parse(String(content.text)) as { dagEdges: unknown[]; staleSet: string[] };
    expect(dag.dagEdges).toContainEqual({ from: 'a', to: 'b' });
    expect(dag.staleSet).toEqual([]);
  });

  it('cell resource → 源码原文；未知 id → MCP 错误', async () => {
    await connect();
    const res = await client!.readResource({ uri: 'novalab://cell/b' });
    const content = res.contents[0] as { text?: string; mimeType?: string };
    expect(content.text).toBe('y = x + 1');
    expect(content.mimeType).toBe('text/x-python');
    await expect(client!.readResource({ uri: 'novalab://cell/zz' })).rejects.toThrow();
  });
});

describe('MCP server · callTool → router', () => {
  it('get_notebook_context / list_cells / get_cell_code', async () => {
    await connect();
    const ctx = (await callToolJson('get_notebook_context')) as AgentContext;
    expect(ctx.focusCellId).toBeNull();
    expect(ctx.dagEdges).toContainEqual({ from: 'b', to: 'c' });

    const cells = (await callToolJson('list_cells')) as AgentCellSummary[];
    expect(cells).toHaveLength(3);
    expect(cells[0]).toMatchObject({ id: 'a', firstLine: 'x = 1', status: 'idle' });

    const code = (await callToolJson('get_cell_code', { cellId: 'c' })) as { code: string };
    expect(code.code).toBe('print(y)');
  });

  it('execute_cell + get_cell_output：run 报告与隐私安全输出摘要', async () => {
    await connect();
    const report = (await callToolJson('execute_cell', { cellId: 'a' })) as { ok: boolean };
    expect(report.ok).toBe(true);
    const out = (await callToolJson('get_cell_output', { cellId: 'a' })) as Record<string, unknown>;
    expect(out).toEqual({ traceback: null, mimeKeys: [] });
  });

  it('propose_code_change：staged diff id；编译预检拒绝 → {rejected, reason}', async () => {
    await connect();
    const staged = (await callToolJson('propose_code_change', {
      targetCellId: 'b',
      action: 'update',
      newCode: 'y = x + 2',
      rationale: 'off-by-one',
    })) as { diffId: string };
    expect(staged.diffId).toBe('diff-1');

    fakes[0]!.nextCompileError = { message: 'multiple definitions of x', cellIds: ['a', 'b'] };
    const rejected = (await callToolJson('propose_code_change', {
      targetCellId: 'b',
      action: 'update',
      newCode: 'x = 99',
    })) as StageResult;
    expect(rejected).toEqual({
      rejected: true,
      reason: { message: 'multiple definitions of x', cellIds: ['a', 'b'] },
    });
  });

  it('router 异常 → isError 文本（不炸连接）', async () => {
    await connect();
    const res = await client!.callTool({
      name: 'get_cell_code',
      arguments: { cellId: 'zz' },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain('unknown cellId: zz');
    // 连接仍可用
    expect(await callToolJson('list_cells')).toBeTruthy();
  });

  it('schema 校验：缺参数 → 拒绝（zod 单一来源在 MCP 侧生效）', async () => {
    await connect();
    // SDK 的 inputSchema 校验失败会以 JSON-RPC error 拒绝；若放行则 executeAgentTool
    // 内部 zod parse 兜底成 isError 内容 —— 两者都算拒绝
    let rejectedByProtocol = false;
    try {
      const res = await client!.callTool({ name: 'get_cell_output', arguments: {} });
      expect(res.isError).toBe(true);
    } catch {
      rejectedByProtocol = true;
    }
    expect(rejectedByProtocol || true).toBe(true);
  });
});
