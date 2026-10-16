/**
 * ADR-012 对比脚本：同一 stub 策略 × 同一宿主，分别跑 Vercel 循环与 pi AgentRuntime。
 *
 *   pnpm --filter @novalab/bridge exec tsx src/agent-runtime/bench/compare.ts [out.json]
 *
 * 无 LLM：模型是脚本化策略（bench/policy.ts），所以"修复成功率"只反映 harness 是否把
 * 证据送到、把提议落成 staged diff、把预检拒绝 / 参数错误回传给模型自纠；不反映真实模型能力。
 */

import { writeFileSync } from 'node:fs';
import type { ModelMessage } from 'ai';
import { AGENT_SYSTEM_PROMPT } from '../../../../app/src/agent/systemPrompt';
import type { AgentToolHost } from '../../mcp/tools';
import { acceptAllAndJudge, openFixture, type Fixture } from './fixtures';
import { ALL_FIXTURES, N2_FIXTURES } from './fixtures-data';
import { createPiLoop, createVercelLoop } from './loops';
import { call, honoring, say, steps, type Policy } from './policy';

type Harness = 'vercel' | 'pi';

interface Row {
  fixture: string;
  kind: string;
  harness: Harness;
  success: boolean;
  llmCalls: number;
  toolCalls: number;
  inputTokensEst: number;
  outputTokensEst: number;
  leaks: string[];
  stagedAccepted: number;
  blocked: number;
  privacyDroppedKeys: number;
  failures: string[];
  ms: number;
}

const userMsg = (text: string): ModelMessage => ({ role: 'user', content: text });

async function runFixture(fx: Fixture, harness: Harness, hostWrap?: (h: AgentToolHost) => AgentToolHost): Promise<Row> {
  const b = await openFixture(fx);
  const host = hostWrap ? hostWrap(b.router) : b.router;
  const t0 = Date.now();
  let meter;
  let toolCalls = 0;
  let blocked = 0;
  let dropped = 0;
  try {
    if (harness === 'pi') {
      const h = createPiLoop(host, fx.policy, AGENT_SYSTEM_PROMPT);
      await h.runtime.prompt(fx.prompt);
      meter = h.meter;
      toolCalls = h.runtime.stats.toolCalls;
      blocked = h.runtime.stats.blockedCalls;
      dropped = h.runtime.audit.reduce((n, e) => n + e.droppedKeys.length, 0);
    } else {
      const v = createVercelLoop(host, fx.policy, AGENT_SYSTEM_PROMPT);
      await v.run([userMsg(fx.prompt)]);
      meter = v.meter;
      toolCalls = v.toolCalls;
    }
    const ms = Date.now() - t0;
    const j = await acceptAllAndJudge(b, fx);
    return {
      fixture: fx.id,
      kind: fx.kind,
      harness,
      success: j.success,
      llmCalls: meter.requests,
      toolCalls,
      inputTokensEst: meter.inputTokens,
      outputTokensEst: meter.outputTokens,
      leaks: [...meter.leaks],
      stagedAccepted: j.accepted,
      blocked,
      privacyDroppedKeys: dropped,
      failures: j.failures,
      ms,
    };
  } finally {
    b.stop();
  }
}

// ---------- 可中断性 ----------

const STEER = '只诊断，不要提议修改';
const FOLLOW = '再用一句话总结';

interface InterruptRow {
  scenario: string;
  harness: Harness;
  llmCalls: number;
  /** 插话之后到模型第一次看到插话之间的 LLM 调用数（0 = 下一次请求即看到）。 */
  callsUntilSeen: number | null;
  /** 被丢弃（中止时在途）的 LLM 请求数。 */
  discardedCalls: number;
  stagedDiffs: number;
  settleMs: number | null;
  sameRun: boolean;
  note: string;
}

function tracking(inner: Policy, needle: string, onSeen: () => void): Policy {
  let done = false;
  return (v) => {
    if (!done && v.users.some((u) => u.includes(needle))) {
      done = true;
      onSeen();
    }
    return inner(v);
  };
}

async function steerScenario(harness: Harness): Promise<InterruptRow> {
  const fx = N2_FIXTURES[0]!;
  const b = await openFixture(fx);
  let reqAtInterject = -1;
  let reqAtSeen = -1;
  const reply = '诊断：cell b 的 valuse 是 values 的拼写错误（按你的要求未提议修改）。';
  try {
    if (harness === 'pi') {
      let h!: ReturnType<typeof createPiLoop>;
      const policy = tracking(honoring(fx.policy, STEER, reply), STEER, () => (reqAtSeen = h.meter.requests));
      h = createPiLoop(b.router, policy, AGENT_SYSTEM_PROMPT, {
        onToolDone: (_n, i) => {
          if (i === 1) {
            reqAtInterject = h.meter.requests;
            h.runtime.steer(STEER);
          }
        },
      });
      await h.runtime.prompt(fx.prompt);
      return {
        scenario: 'I1 运行中插话（第 1 个工具结果后）',
        harness,
        llmCalls: h.meter.requests,
        callsUntilSeen: reqAtSeen - reqAtInterject - 1,
        discardedCalls: 0,
        stagedDiffs: b.diffs().length,
        settleMs: null,
        sameRun: true,
        note: 'steer() 入队，当前工具批次结束后、下一次请求前注入；无需中止',
      };
    }
    // vercel：无 steer —— 只能 stop() 当前流，再带着已完成的工具调用 + 新 user 消息重发
    const ctrl = new AbortController();
    let v!: ReturnType<typeof createVercelLoop>;
    const policy = tracking(honoring(fx.policy, STEER, reply), STEER, () => (reqAtSeen = v.meter.requests));
    v = createVercelLoop(b.router, policy, AGENT_SYSTEM_PROMPT, {
      onToolDone: (_n, i) => {
        if (i === 1) {
          reqAtInterject = v.meter.requests;
          ctrl.abort();
        }
      },
    });
    const first = await v.run([userMsg(fx.prompt)], ctrl.signal).catch(() => null);
    const requestsBeforeResend = v.meter.requests;
    const history: ModelMessage[] = [userMsg(fx.prompt)];
    for (const c of v.completed) {
      history.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: c.toolCallId, toolName: c.toolName, input: c.input }] });
      history.push({
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: c.toolCallId, toolName: c.toolName, output: { type: 'json', value: c.output as never } }],
      });
    }
    history.push(userMsg(STEER));
    await v.run(history);
    return {
      scenario: 'I1 运行中插话（第 1 个工具结果后）',
      harness,
      llmCalls: v.meter.requests,
      callsUntilSeen: reqAtSeen - reqAtInterject - 1,
      discardedCalls: requestsBeforeResend - reqAtInterject,
      stagedDiffs: b.diffs().length,
      settleMs: null,
      sameRun: false,
      note: `abort + 应用层重建历史后重发（首个流${first ? '已正常结束' : '以中止结束'}）`,
    };
  } finally {
    b.stop();
  }
}

async function abortScenario(harness: Harness): Promise<InterruptRow> {
  const fx = N2_FIXTURES[0]!;
  const b = await openFixture(fx);
  b.kernel.execDelayMs = 1500;
  const policy = steps(() => call('execute_cell', { cellId: 'a' }), () => say('a 已运行。'));
  let abortAt = 0;
  try {
    if (harness === 'pi') {
      let h!: ReturnType<typeof createPiLoop>;
      h = createPiLoop(b.router, policy, AGENT_SYSTEM_PROMPT, {
        onToolStart: (name) => {
          if (name === 'execute_cell') {
            setTimeout(() => {
              abortAt = Date.now();
              h.runtime.abort();
            }, 100);
          }
        },
      });
      await h.runtime.prompt(fx.prompt);
      await h.runtime.waitForIdle();
      const settle = Date.now() - abortAt;
      return {
        scenario: 'I2 中止慢执行（execute_cell 1.5s，100ms 后 abort）',
        harness,
        llmCalls: h.meter.requests,
        callsUntilSeen: null,
        discardedCalls: 0,
        stagedDiffs: b.diffs().length,
        settleMs: settle,
        sameRun: true,
        note: '工具 execute 收到 signal 立即让出；内核侧 exec 不可取消，仍跑完（结果只进本地输出缓存）',
      };
    }
    const ctrl = new AbortController();
    const v = createVercelLoop(b.router, policy, AGENT_SYSTEM_PROMPT, {
      onToolStart: (name) => {
        if (name === 'execute_cell') {
          setTimeout(() => {
            abortAt = Date.now();
            ctrl.abort();
          }, 100);
        }
      },
    });
    await v.run([userMsg(fx.prompt)], ctrl.signal).catch(() => null);
    const settle = Date.now() - abortAt;
    return {
      scenario: 'I2 中止慢执行（execute_cell 1.5s，100ms 后 abort）',
      harness,
      llmCalls: v.meter.requests,
      callsUntilSeen: null,
      discardedCalls: 0,
      stagedDiffs: b.diffs().length,
      settleMs: settle,
      sameRun: true,
      note: 'executeAgentTool 不接 abortSignal；内核侧同样不可取消',
    };
  } finally {
    b.stop();
  }
}

async function followUpScenario(harness: Harness): Promise<InterruptRow> {
  const fx = N2_FIXTURES[0]!;
  const b = await openFixture(fx);
  const reply = '总结：把 valuse 改为 values，已提议待审阅。';
  let reqAtSeen = -1;
  let reqAtInterject = -1;
  try {
    if (harness === 'pi') {
      let h!: ReturnType<typeof createPiLoop>;
      const policy = tracking(honoring(fx.policy, FOLLOW, reply), FOLLOW, () => (reqAtSeen = h.meter.requests));
      h = createPiLoop(b.router, policy, AGENT_SYSTEM_PROMPT, {
        onToolDone: (_n, i) => {
          if (i === 1) {
            reqAtInterject = h.meter.requests;
            h.runtime.followUp(FOLLOW);
          }
        },
      });
      await h.runtime.prompt(fx.prompt);
      return {
        scenario: 'I3 排队追问（运行中排队，完成后自动续一轮）',
        harness,
        llmCalls: h.meter.requests,
        callsUntilSeen: reqAtSeen - reqAtInterject - 1,
        discardedCalls: 0,
        stagedDiffs: b.diffs().length,
        settleMs: null,
        sameRun: true,
        note: 'followUp() 在 Agent 自然停下后注入，同一 run 内完成',
      };
    }
    let v!: ReturnType<typeof createVercelLoop>;
    const policy = tracking(honoring(fx.policy, FOLLOW, reply), FOLLOW, () => (reqAtSeen = v.meter.requests));
    let queued = false;
    v = createVercelLoop(b.router, policy, AGENT_SYSTEM_PROMPT, {
      onToolDone: (_n, i) => {
        if (i === 1) {
          reqAtInterject = v.meter.requests;
          queued = true; // 应用层自己排队
        }
      },
    });
    const r1 = await v.run([userMsg(fx.prompt)]);
    if (queued) await v.run([userMsg(fx.prompt), ...r1.responseMessages, userMsg(FOLLOW)]);
    return {
      scenario: 'I3 排队追问（运行中排队，完成后自动续一轮）',
      harness,
      llmCalls: v.meter.requests,
      callsUntilSeen: reqAtSeen - reqAtInterject - 1,
      discardedCalls: 0,
      stagedDiffs: b.diffs().length,
      settleMs: null,
      sameRun: false,
      note: '无原生队列：应用层等第一个流结束后再发新消息（第二次 run）',
    };
  } finally {
    b.stop();
  }
}

// ---------- 故障注入：bridge 出口回归（agent.cellOutput 误带 stdout） ----------

function regressedHost(h: AgentToolHost): AgentToolHost {
  return {
    async invoke(method, params) {
      const r = await h.invoke(method, params);
      if (method === 'agent.cellOutput') {
        return { ...(r as object), stdout: 'row0 CANARY-STDOUT-regression 42.17', writes: ['/home/owner/CANARY-PATH-regression/out.csv'] };
      }
      return r;
    },
  };
}

// ---------- main ----------

async function main(): Promise<void> {
  const rows: Row[] = [];
  for (const fx of ALL_FIXTURES) {
    for (const h of ['vercel', 'pi'] as const) rows.push(await runFixture(fx, h));
  }
  const faults: Row[] = [];
  for (const h of ['vercel', 'pi'] as const) faults.push(await runFixture(N2_FIXTURES[0]!, h, regressedHost));
  const interrupts: InterruptRow[] = [];
  for (const s of [steerScenario, abortScenario, followUpScenario]) {
    for (const h of ['vercel', 'pi'] as const) interrupts.push(await s(h));
  }

  const summary = (['vercel', 'pi'] as const).map((h) => {
    const rs = rows.filter((r) => r.harness === h);
    const sum = (f: (r: Row) => number) => rs.reduce((n, r) => n + f(r), 0);
    return {
      harness: h,
      n2: `${rs.filter((r) => r.kind === 'N2' && r.success).length}/${rs.filter((r) => r.kind === 'N2').length}`,
      n3: `${rs.filter((r) => r.kind === 'N3' && r.success).length}/${rs.filter((r) => r.kind === 'N3').length}`,
      llmCalls: sum((r) => r.llmCalls),
      toolCalls: sum((r) => r.toolCalls),
      inputTokensEst: sum((r) => r.inputTokensEst),
      outputTokensEst: sum((r) => r.outputTokensEst),
      leaks: sum((r) => r.leaks.length),
    };
  });

  const out = {
    generatedAt: new Date().toISOString(),
    llm: 'none (scripted stub policy; no app/.env.local in this worktree)',
    versions: { 'pi-agent-core': '1.0.4', 'pi-ai': '1.0.4', ai: '7.0.128' },
    tokenEstimator: 'ceil(JSON.stringify(request).length / 4), same for both harnesses',
    summary,
    rows,
    faults,
    interrupts,
  };
  const path = process.argv[2];
  if (path) writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ summary, faults: faults.map((f) => ({ h: f.harness, leaks: f.leaks, dropped: f.privacyDroppedKeys })), interrupts }, null, 2));
  console.table(rows.map((r) => ({ fx: r.fixture, h: r.harness, ok: r.success, llm: r.llmCalls, tools: r.toolCalls, inTok: r.inputTokensEst, outTok: r.outputTokensEst, leaks: r.leaks.length, acc: r.stagedAccepted, fail: r.failures.join(',') })));
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
