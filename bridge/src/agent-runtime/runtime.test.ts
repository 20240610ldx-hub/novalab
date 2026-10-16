/**
 * ADR-012 spike：pi AgentRuntime 适配层的不变量。
 *  - zod ↔ 生成的 TypeBox 判定一致（单源）；
 *  - M4：未知工具 / execute 策略 / 受限宿主；
 *  - M5：白名单丢键、fail-closed、审计去重；故障注入下 LLM 请求里无 canary；
 *  - steer / followUp；
 *  - OpenAI 兼容 createProvider 打本地假端点（无真实 LLM、无凭据）。
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { AGENT_TOOL_NAMES, agentToolSchemas, type AgentToolHost } from '../mcp/tools';
import { OUTPUT_CHAR_LIMIT } from '../router';
import { AGENT_TOOL_TYPEBOX } from './tool-schemas';
import { DEFAULT_GATE_POLICY, M4Violation, decideToolGate, guardHost } from './policy';
import { REDACTED_TEXT, TRACEBACK_CHAR_LIMIT, sanitizeToolResultText } from './privacy';
import { createCompatModel, createOpenAICompat } from './provider';
import { PI_RUNTIME_FLAG, piRuntimeEnabled } from './flag';
import { streamText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { AgentRuntime } from './runtime';
import { openFixture, type Bench } from './bench/fixtures';
import { N2_FIXTURES } from './bench/fixtures-data';
import { createPiLoop } from './bench/loops';
import { call, honoring, say, steps } from './bench/policy';

const SYSTEM = 'test system prompt';

let bench: Bench | undefined;
afterEach(() => {
  bench?.stop();
  bench = undefined;
});

describe('tool-schemas: zod 单源 → TypeBox', () => {
  const samples: Record<string, unknown[]> = {
    get_notebook_context: [{}, { x: 1 }],
    get_cell_output: [{ cellId: 'a' }, {}, { cellId: 1 }],
    propose_code_change: [
      { targetCellId: 'a', action: 'update', newCode: 'x = 1' },
      { targetCellId: 'a', action: 'insert_below', newCode: 'x = 1', rationale: 'r' },
      { targetCellId: 'a', action: 'replace', newCode: 'x = 1' },
      { targetCellId: 'a', action: 'update' },
      { targetCellId: 'a', action: 'update', newCode: 1 },
    ],
    execute_cell: [{ cellId: 'a' }, { cellId: 'a', cascade: true }, { cellId: 'a', cascade: 'yes' }, { cellId: 'a', cascade: 'true' }, {}],
    list_cells: [{}],
    get_cell_code: [{ cellId: 'a' }, { cell: 'a' }],
  };

  /** pi 校验：成功返回（可能经类型转换的）参数，失败返回 null。 */
  function piValidate(name: (typeof AGENT_TOOL_NAMES)[number], args: unknown): unknown {
    try {
      return validateToolArguments(
        { name, description: '', parameters: AGENT_TOOL_TYPEBOX[name] },
        { type: 'toolCall', id: 't', name, arguments: args as never },
      );
    } catch {
      return null;
    }
  }

  it('pi 放行的参数（含其宽松类型转换后的值）zod 一律放行；zod 放行的 pi 也放行', () => {
    const divergent: string[] = [];
    for (const name of AGENT_TOOL_NAMES) {
      for (const args of samples[name]!) {
        const zodRaw = agentToolSchemas[name].safeParse(args).success;
        const coerced = piValidate(name, args);
        if (zodRaw) expect({ name, args, piOk: coerced !== null }).toEqual({ name, args, piOk: true });
        if (coerced !== null) {
          // execute 里 executeAgentTool 用 zod 再 parse 一次：pi 转换后的值必须仍合法
          expect(agentToolSchemas[name].safeParse(coerced).success).toBe(true);
          if (!zodRaw) divergent.push(`${name}:${JSON.stringify(args)}`);
        }
      }
    }
    // 已知差异（写进 ADR 风险）：pi 的 TypeBox Value 转换把 1 → "1"、"true" → true（"yes" 仍拒绝）
    expect(divergent).toEqual(['get_cell_output:{"cellId":1}', 'propose_code_change:{"targetCellId":"a","action":"update","newCode":1}', 'execute_cell:{"cellId":"a","cascade":"true"}']);
  });
});

describe('policy（M4）', () => {
  it('未知工具一律拦截（不引入 pi-coding-agent 的 read/write/edit/bash）', () => {
    for (const t of ['bash', 'write', 'edit', 'read']) {
      expect(decideToolGate(t, DEFAULT_GATE_POLICY, { proposalsThisRun: 0 }).block).toBe(true);
    }
  });

  it('execute=deny 时拦 execute_cell；提议预算耗尽时拦 propose_code_change', () => {
    expect(decideToolGate('execute_cell', { ...DEFAULT_GATE_POLICY, execute: 'deny' }, { proposalsThisRun: 0 }).block).toBe(true);
    expect(decideToolGate('execute_cell', DEFAULT_GATE_POLICY, { proposalsThisRun: 0 }).block).toBe(false);
    expect(decideToolGate('propose_code_change', DEFAULT_GATE_POLICY, { proposalsThisRun: 8 }).block).toBe(true);
  });

  it('guardHost 只放行六工具用到的 router 方法', async () => {
    const calls: string[] = [];
    const host: AgentToolHost = { invoke: async (m) => (calls.push(m), {}) };
    const seen: string[] = [];
    const g = guardHost(host, (m) => seen.push(m));
    for (const m of ['cell.save', 'diff.accept', 'fs.writeFile', 'kernel.repl', 'notebook.close']) {
      await expect(g.invoke(m, {})).rejects.toBeInstanceOf(M4Violation);
    }
    await g.invoke('diff.stage', {});
    expect(calls).toEqual(['diff.stage']);
    expect(seen).toHaveLength(5);
  });
});

describe('privacy（M5）', () => {
  it('白名单外的键被丢弃并报出 droppedKeys', () => {
    const r = sanitizeToolResultText(
      'get_cell_output',
      JSON.stringify({ traceback: 'tb', mimeKeys: ['text/html'], stdout: 'secret', writes: ['/p'] }),
      false,
    );
    expect(JSON.parse(r.text)).toEqual({ traceback: 'tb', mimeKeys: ['text/html'] });
    expect(r.droppedKeys.sort()).toEqual(['stdout', 'writes']);
  });

  it('未知工具 / 非 JSON / 形状不符 → fail closed', () => {
    expect(sanitizeToolResultText('bash', '{"x":1}', false).text).toBe(REDACTED_TEXT);
    expect(sanitizeToolResultText('list_cells', 'not json', false).redacted).toBe(true);
    expect(sanitizeToolResultText('get_cell_output', '{"stdout":"x"}', false).redacted).toBe(true);
  });

  it('traceback 8KB、其他字符串 4KB、源码不截断；已被 bridge 截过的不叠加后缀', () => {
    expect(TRACEBACK_CHAR_LIMIT).toBe(OUTPUT_CHAR_LIMIT);
    const long = 'x'.repeat(20_000);
    const tb = JSON.parse(sanitizeToolResultText('get_cell_output', JSON.stringify({ traceback: long, mimeKeys: [] }), false).text);
    expect(tb.traceback.length).toBe(TRACEBACK_CHAR_LIMIT + '…[truncated]'.length);
    const code = JSON.parse(sanitizeToolResultText('get_cell_code', JSON.stringify({ cellId: 'a', code: long }), false).text);
    expect(code.code.length).toBe(20_000);
    const once = tb.traceback as string;
    const again = JSON.parse(sanitizeToolResultText('get_cell_output', JSON.stringify({ traceback: once, mimeKeys: [] }), false).text);
    expect(again.traceback).toBe(once);
  });
});

describe('AgentRuntime（faux provider + router + OracleKernel）', () => {
  it('N2 修错：提议落成 staged diff，0 泄漏，审计每个工具结果一条', async () => {
    const fx = N2_FIXTURES[0]!;
    bench = await openFixture(fx);
    const h = createPiLoop(bench.router, fx.policy, SYSTEM);
    await h.runtime.prompt(fx.prompt);
    expect(bench.diffs().filter((d) => d.status === 'proposed')).toHaveLength(1);
    expect([...h.meter.leaks]).toEqual([]);
    expect(h.runtime.audit).toHaveLength(h.runtime.stats.toolCalls);
    expect(h.runtime.audit.every((e) => e.droppedKeys.length === 0 && !e.redacted)).toBe(true);
    expect(h.runtime.m4Violations).toEqual([]);
  });

  it('故障注入：bridge 出口回归带出 stdout/路径 → 第二道闸丢弃，LLM 请求里无 canary', async () => {
    const fx = N2_FIXTURES[0]!;
    bench = await openFixture(fx);
    const router = bench.router;
    const regressed: AgentToolHost = {
      async invoke(method, params) {
        const r = await router.invoke(method, params);
        return method === 'agent.cellOutput' ? { ...(r as object), stdout: 'CANARY-STDOUT-x' } : r;
      },
    };
    const h = createPiLoop(regressed, fx.policy, SYSTEM);
    await h.runtime.prompt(fx.prompt);
    expect([...h.meter.leaks]).toEqual([]);
    expect(h.runtime.audit.flatMap((e) => e.droppedKeys)).toEqual(['stdout']);
  });

  it('模型调用非 NovaLab 工具（bash）→ 不执行、不触达 router', async () => {
    const fx = N2_FIXTURES[0]!;
    bench = await openFixture(fx);
    const reqsBefore = bench.kernel.requests.length;
    const h = createPiLoop(bench.router, steps(() => call('bash', { command: 'rm -rf /' }), () => say('ok')), SYSTEM);
    await h.runtime.prompt('x');
    expect(h.runtime.stats.toolCalls).toBe(0);
    expect(bench.kernel.requests.length).toBe(reqsBefore);
  });

  it('execute=deny：execute_cell 被 beforeToolCall 拦截，内核未收到 exec', async () => {
    const fx = N2_FIXTURES[0]!;
    bench = await openFixture(fx);
    const execBefore = bench.kernel.countOf('exec_cell');
    const h = createPiLoop(bench.router, steps(() => call('execute_cell', { cellId: 'a' }), () => say('ok')), SYSTEM, {}, { execute: 'deny' });
    await h.runtime.prompt('x');
    expect(h.runtime.blocked.map((b) => b.tool)).toEqual(['execute_cell']);
    expect(bench.kernel.countOf('exec_cell')).toBe(execBefore);
  });

  it('steer()：第一个工具结果后插话，下一次请求即可见，且不再产生提议', async () => {
    const fx = N2_FIXTURES[0]!;
    bench = await openFixture(fx);
    let h!: ReturnType<typeof createPiLoop>;
    h = createPiLoop(bench.router, honoring(fx.policy, 'STOP', '好的，只诊断。'), SYSTEM, {
      onToolDone: (_n, i) => i === 1 && h.runtime.steer('STOP'),
    });
    await h.runtime.prompt(fx.prompt);
    expect(h.meter.requests).toBe(2);
    expect(bench.diffs()).toHaveLength(0);
  });

  it('finishTurn 步数上限：第 10 次 LLM 调用后结束', async () => {
    const fx = N2_FIXTURES[0]!;
    bench = await openFixture(fx);
    const h = createPiLoop(bench.router, () => call('list_cells'), SYSTEM);
    await h.runtime.prompt('loop forever');
    expect(h.meter.requests).toBe(10);
    expect(h.runtime.stats.hitStepLimit).toBe(true);
  });
});

describe('createOpenAICompat（本地假 OpenAI 兼容端点）', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  function sse(chunks: unknown[]): string {
    return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  }

  const chunk = (delta: unknown, finish: string | null, usage?: unknown) => ({
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'stub',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  });

  it('工具声明来自 zod 单源；请求体无白名单外内容；鉴权头按显式 key', async () => {
    const bodies: { auth: string | undefined; body: Record<string, unknown> }[] = [];
    server = createServer((req: IncomingMessage, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        bodies.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const usage = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 };
        if (bodies.length === 1) {
          res.end(
            sse([
              chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_cell_output', arguments: '{"cellId":"b"}' } }] }, null),
              chunk({}, 'tool_calls', usage),
            ]),
          );
        } else {
          res.end(sse([chunk({ role: 'assistant', content: '已看到 NameError。' }, null), chunk({}, 'stop', usage)]));
        }
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    const fx = N2_FIXTURES[0]!;
    bench = await openFixture(fx);
    const { models, model } = createOpenAICompat({ baseUrl: `http://127.0.0.1:${port}/v1`, modelId: 'stub', apiKey: 'test-key-not-secret' });
    const rt = new AgentRuntime({ host: bench.router, model, streamFn: models.streamSimple.bind(models), systemPrompt: SYSTEM });
    await rt.prompt(fx.prompt);

    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.auth).toBe('Bearer test-key-not-secret');
    const tools = bodies[0]!.body['tools'] as { function: { name: string; parameters: unknown } }[];
    expect(tools.map((t) => t.function.name).sort()).toEqual([...AGENT_TOOL_NAMES].sort());
    const second = JSON.stringify(bodies[1]!.body);
    expect(second).toContain('NameError');
    expect(second).not.toMatch(/CANARY-/);
    expect(rt.stats.inputTokens).toBe(200);
    expect(rt.audit).toHaveLength(1);
  });
});

describe('实验开关（D1）', () => {
  it('默认关闭，只认精确的 "1"', () => {
    expect(piRuntimeEnabled({})).toBe(false);
    expect(piRuntimeEnabled({ [PI_RUNTIME_FLAG]: 'true' })).toBe(false);
    expect(piRuntimeEnabled({ [PI_RUNTIME_FLAG]: '1' })).toBe(true);
  });
});

describe('createCompatModel anthropic-compat（G-1 的 .env.local 端点形态）', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it('pi 与 app 的 @ai-sdk/anthropic 用同一 baseURL（含 /v1）打到同一路径，key 走 x-api-key', async () => {
    const hits: { path: string | undefined; key: string | string[] | undefined }[] = [];
    const ev = (type: string, data: unknown) => `event: ${type}
data: ${JSON.stringify({ type, ...(data as object) })}

`;
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        hits.push({ path: req.url, key: req.headers['x-api-key'] });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'stub', content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 0 } } }) +
            ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
            ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }) +
            ev('content_block_stop', { index: 0 }) +
            ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) +
            ev('message_stop', {}),
        );
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

    const { models, model } = createCompatModel({ kind: 'anthropic-compat', baseUrl: baseURL, modelId: 'stub', apiKey: 'k-test' });
    const rt = new AgentRuntime({ host: { invoke: async () => ({}) }, model, streamFn: models.streamSimple.bind(models), systemPrompt: SYSTEM });
    await rt.prompt('hi');
    await streamText({ model: createAnthropic({ baseURL, apiKey: 'k-test' })('stub'), prompt: 'hi' }).consumeStream();

    expect(hits).toHaveLength(2);
    // 同一路径；但 pi（@anthropic-ai/sdk beta 接口）多带 ?beta=true —— 代理若严格匹配查询串会不兼容（ADR 风险项）
    expect(hits[0]!.path).toBe('/v1/messages?beta=true');
    expect(hits[1]!.path).toBe('/v1/messages');
    expect(hits.map((h) => h.key)).toEqual(['k-test', 'k-test']);
    expect(rt.agent.state.errorMessage).toBeUndefined();
  });
});
