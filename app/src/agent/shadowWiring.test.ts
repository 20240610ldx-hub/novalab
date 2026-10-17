import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import type { UIMessage } from 'ai';

/**
 * ADR-013 S1/S2 前端接线：
 * - 每次 Agent 请求开始时 agent.turnBegin（O1 = b：每轮首次影子运行问一次）；
 * - 工具循环步数默认 24（O9）；
 * - harness abortSignal（Stop）→ 工具 execute → shadow.cancel（F4）。
 */

vi.mock('../bridge/client', () => ({
  bridge: { rpc: vi.fn() },
}));

import { bridge } from '../bridge/client';
import { agentTools } from './tools';
import { AgentChatTransport, DEFAULT_MAX_STEPS } from './useAgentChat';

const rpc = bridge.rpc as unknown as Mock;

beforeEach(() => {
  rpc.mockReset();
});

function textModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'ok' },
        { type: 'text-end', id: 't' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ]) as never,
    }),
  });
}

const userMessage: UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] };

async function drain(stream: ReadableStream<unknown>): Promise<void> {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    /* consume */
  }
}

describe('Agent 轮次与步数', () => {
  it('每次请求先 agent.turnBegin（新 turnId），再请求模型', async () => {
    const order: string[] = [];
    const beginTurn = vi.fn(async (turnId: string) => {
      order.push(`turn:${turnId}`);
    });
    const model = textModel();
    const transport = new AgentChatTransport(() => ({
      getModel: () => {
        order.push('model');
        return model;
      },
      instructions: 'sys',
      tools: {},
      beginTurn,
    }));
    const send = () =>
      transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'c',
        messageId: undefined,
        messages: [userMessage],
        abortSignal: undefined,
      } as never);
    await drain(await send());
    await drain(await send());
    expect(beginTurn).toHaveBeenCalledTimes(2);
    const [a, b] = beginTurn.mock.calls.map((c) => c[0]);
    expect(a).not.toBe(b);
    expect(order[1]).toMatch(/^turn:/);
  });

  it('turnBegin 失败（旧 bridge）不阻断请求：漏接线只会多问', async () => {
    const transport = new AgentChatTransport(() => ({
      getModel: () => textModel(),
      instructions: 'sys',
      tools: {},
      beginTurn: async () => {
        throw new Error('method not found: agent.turnBegin');
      },
    }));
    await drain(
      await transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'c',
        messageId: undefined,
        messages: [userMessage],
        abortSignal: undefined,
      } as never),
    );
  });

  it('默认工具循环步数 24（O9）', () => {
    expect(DEFAULT_MAX_STEPS).toBe(24);
  });
});

describe('Stop → shadow.cancel（F4）', () => {
  it('工具 execute 拿到 abortSignal，中止时通知 bridge 取消影子运行', async () => {
    let release!: (v: unknown) => void;
    rpc.mockImplementation((method: string) =>
      method === 'shadow.run' ? new Promise((r) => (release = r)) : Promise.resolve({ cancelled: true }),
    );
    const ac = new AbortController();
    const t = agentTools.shadow_run as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };
    const pending = t.execute(
      { changes: [{ targetCellId: 'b', action: 'update', newCode: 'y = 2' }] },
      { toolCallId: 'x', messages: [], abortSignal: ac.signal },
    );
    ac.abort();
    await new Promise((r) => setTimeout(r, 5));
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['shadow.run', 'shadow.cancel']);
    release({ runId: 'shadow-1', status: 'cancelled', budget: { runsUsed: 1, runsLimit: 8, msUsed: 1, msLimit: 300000 } });
    expect(await pending).toMatchObject({ status: 'cancelled' });
  });
});
