/**
 * ADR-012 G-1：真实模型对比（Owner 手动运行）。
 *
 *   pnpm --filter @novalab/bridge exec tsx src/agent-runtime/bench/real.ts [--reps 3] [--kind anthropic-compat|openai-compat] [--out ../docs/adr-012-g1-results.json]
 *
 * 凭据：只读**本工作树**的 app/.env.local（VITE_NOVALAB_LLM_BASE_URL / _API_KEY / _MODEL，
 * 与 app/src/agent/providers.ts 的 dev 兜底同一份、同一 kind 默认 anthropic-compat）。
 * 不读其他工作树、不读凭据存储、不打印任何值（ADR-008）。文件不存在就直接退出。
 *
 * 两边同一端点、同一模型、同一 system prompt、同一夹具；夹具数据全部是合成的。
 * 泄漏扫描在真实 HTTP 请求体上做（包一层 globalThis.fetch），比 stub 模式更接近线上字节。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel, ModelMessage } from 'ai';
import { AGENT_SYSTEM_PROMPT } from '../../../../app/src/agent/systemPrompt';
import { createOpenAICompat as createAppOpenAICompat } from '../../../../app/src/agent/openaiCompat';
import { AgentRuntime } from '../runtime';
import { createCompatModel, type CompatKind } from '../provider';
import { CANARY_RE, acceptAllAndJudge, openFixture, type Fixture } from './fixtures';
import { ALL_FIXTURES, N2_FIXTURES } from './fixtures-data';
import { createVercelLoop } from './loops';
import { say } from './policy';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.resolve(here, '../../../../app/.env.local');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

function readEnvLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** 包一层 fetch：统计请求次数，在请求体上扫 canary。 */
const wire = { requests: 0, leaks: new Set<string>() };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  wire.requests++;
  if (typeof init?.body === 'string') for (const m of init.body.matchAll(CANARY_RE)) wire.leaks.add(m[0]);
  return realFetch(input, init);
}) as typeof fetch;

type Harness = 'vercel' | 'pi';

interface Row {
  fixture: string;
  kind: string;
  harness: Harness;
  rep: number;
  success: boolean;
  httpRequests: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  leaks: string[];
  stagedAccepted: number;
  failures: string[];
  error?: string;
  ms: number;
}

interface Endpoint {
  kind: CompatKind;
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

/**
 * maxTokens 4096：@ai-sdk/anthropic 对未知模型 id（tokenplan 的 qwen/glm/deepseek 等）把输出上限
 * 压到 4096（运行时 warning 可见），app 现网就是这个值；pi 侧对齐，避免输出预算不同造成偏差。
 */
function piModel(ep: Endpoint) {
  return createCompatModel({ kind: ep.kind, baseUrl: ep.baseUrl, apiKey: ep.apiKey, modelId: ep.modelId, maxTokens: 4096 });
}

function vercelModel(ep: Endpoint): LanguageModel {
  return ep.kind === 'anthropic-compat'
    ? createAnthropic({ baseURL: ep.baseUrl, apiKey: ep.apiKey })(ep.modelId)
    : createAppOpenAICompat({ baseURL: ep.baseUrl, apiKey: ep.apiKey })(ep.modelId);
}

async function runOnce(fx: Fixture, harness: Harness, ep: Endpoint, rep: number): Promise<Row> {
  const b = await openFixture(fx);
  wire.requests = 0;
  wire.leaks.clear();
  const t0 = Date.now();
  let toolCalls = 0;
  let usage = { input: 0, output: 0 };
  let error: string | undefined;
  try {
    if (harness === 'pi') {
      const { models, model } = piModel(ep);
      const rt = new AgentRuntime({ host: b.router, model, streamFn: models.streamSimple.bind(models), systemPrompt: AGENT_SYSTEM_PROMPT });
      await rt.prompt(fx.prompt);
      toolCalls = rt.stats.toolCalls;
      usage = { input: rt.stats.inputTokens, output: rt.stats.outputTokens };
      error = rt.agent.state.errorMessage;
    } else {
      const v = createVercelLoop(b.router, () => say(''), AGENT_SYSTEM_PROMPT, {}, vercelModel(ep));
      const r = await v.run([{ role: 'user', content: fx.prompt }]);
      toolCalls = v.toolCalls;
      usage = r.usage;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const ms = Date.now() - t0;
  const httpRequests = wire.requests;
  const leaks = [...wire.leaks];
  try {
    const j = await acceptAllAndJudge(b, fx);
    return {
      fixture: fx.id, kind: fx.kind, harness, rep, success: j.success && !error, httpRequests, toolCalls,
      inputTokens: usage.input, outputTokens: usage.output, leaks, stagedAccepted: j.accepted, failures: j.failures,
      ...(error ? { error: error.slice(0, 300) } : {}), ms,
    };
  } finally {
    b.stop();
  }
}

const STEER = '只诊断原因，不要提议任何代码修改。';

/** I1：第一个工具结果后插话；判据 = 没有新增 staged diff，且模型给出了文本回复。 */
async function steerOnce(harness: Harness, ep: Endpoint): Promise<{ harness: Harness; honored: boolean; stagedDiffs: number; httpRequests: number }> {
  const fx = N2_FIXTURES[0]!;
  const b = await openFixture(fx);
  wire.requests = 0;
  try {
    if (harness === 'pi') {
      const { models, model } = piModel(ep);
      let steered = false;
      const rt: AgentRuntime = new AgentRuntime({
        host: b.router, model, streamFn: models.streamSimple.bind(models), systemPrompt: AGENT_SYSTEM_PROMPT,
        onEvent: (e) => {
          if (e.type === 'tool_execution_end' && !steered) {
            steered = true;
            rt.steer(STEER);
          }
        },
      });
      await rt.prompt(fx.prompt);
    } else {
      const ctrl = new AbortController();
      let interrupted = false;
      const v = createVercelLoop(b.router, () => say(''), AGENT_SYSTEM_PROMPT, {
        onToolDone: () => {
          if (!interrupted) {
            interrupted = true;
            ctrl.abort();
          }
        },
      }, vercelModel(ep));
      await v.run([{ role: 'user', content: fx.prompt }], ctrl.signal).catch(() => null);
      const history: ModelMessage[] = [{ role: 'user', content: fx.prompt }];
      for (const c of v.completed) {
        history.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: c.toolCallId, toolName: c.toolName, input: c.input }] });
        history.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: c.toolCallId, toolName: c.toolName, output: { type: 'json', value: c.output as never } }] });
      }
      history.push({ role: 'user', content: STEER });
      await v.run(history);
    }
    const staged = b.diffs().length;
    return { harness, honored: staged === 0, stagedDiffs: staged, httpRequests: wire.requests };
  } finally {
    b.stop();
  }
}

async function main(): Promise<void> {
  if (!existsSync(ENV_FILE)) {
    console.error(`G-1 需要 ${path.relative(process.cwd(), ENV_FILE)}（VITE_NOVALAB_LLM_BASE_URL / _API_KEY / _MODEL）。未找到，退出。`);
    process.exit(2);
  }
  const env = readEnvLocal();
  const baseUrl = env['VITE_NOVALAB_LLM_BASE_URL'];
  const apiKey = env['VITE_NOVALAB_LLM_API_KEY'];
  const modelId = env['VITE_NOVALAB_LLM_MODEL'];
  if (!baseUrl || !apiKey || !modelId) {
    console.error('app/.env.local 缺 VITE_NOVALAB_LLM_BASE_URL / _API_KEY / _MODEL 之一（G-1 要求显式指定模型），退出。');
    process.exit(2);
  }
  const ep: Endpoint = { kind: arg('kind', 'anthropic-compat') as CompatKind, baseUrl, apiKey, modelId };
  const reps = Number(arg('reps', '3'));
  console.log(`G-1: kind=${ep.kind} model=${modelId} fixtures=${ALL_FIXTURES.length} reps=${reps} harnesses=2（端点与 key 不打印）`);

  const rows: Row[] = [];
  for (let rep = 1; rep <= reps; rep++) {
    for (const fx of ALL_FIXTURES) {
      for (const h of ['vercel', 'pi'] as const) {
        const r = await runOnce(fx, h, ep, rep);
        rows.push(r);
        console.log(`${fx.id} ${h} rep${rep}: ${r.success ? 'ok' : 'FAIL'} req=${r.httpRequests} leaks=${r.leaks.length}${r.error ? ` err=${r.error.slice(0, 80)}` : ''}`);
      }
    }
  }
  const steer = [];
  for (const h of ['vercel', 'pi'] as const) steer.push(await steerOnce(h, ep));

  const summary = (['vercel', 'pi'] as const).map((h) => {
    const rs = rows.filter((r) => r.harness === h);
    const rate = (k: string) => `${rs.filter((r) => r.kind === k && r.success).length}/${rs.filter((r) => r.kind === k).length}`;
    const sum = (f: (r: Row) => number) => rs.reduce((n, r) => n + f(r), 0);
    return {
      harness: h, n2: rate('N2'), n3: rate('N3'), httpRequests: sum((r) => r.httpRequests), toolCalls: sum((r) => r.toolCalls),
      inputTokens: sum((r) => r.inputTokens), outputTokens: sum((r) => r.outputTokens), leaks: sum((r) => r.leaks.length),
      errors: rs.filter((r) => r.error).length,
    };
  });
  const out = { generatedAt: new Date().toISOString(), kind: ep.kind, model: modelId, reps, summary, steer, rows };
  const outPath = arg('out', '');
  if (outPath) writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.table(summary);
  console.table(steer);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
