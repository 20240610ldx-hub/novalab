/**
 * Onboarding 检查 reducer 单测（P4.4）：状态机迁移、skip 语义、
 * 图标映射、fixCommand 裁决、localStorage flag 惯式。纯函数无 DOM。
 */

import { describe, expect, it } from 'vitest';
import {
  CHECK_ORDER,
  allOk,
  allSettled,
  checksReducer,
  fixCommand,
  hasOnboarded,
  initialChecks,
  markOnboarded,
  probeFileName,
  statusIcon,
  type ChecksState,
} from './logic';

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => Object.fromEntries(map),
  };
}

describe('checksReducer', () => {
  it('初始态：四项全 pending、无 error', () => {
    const s = initialChecks();
    expect(CHECK_ORDER.map((id) => s[id].status)).toEqual(['pending', 'pending', 'pending', 'pending']);
    expect(allSettled(s)).toBe(false);
    expect(allOk(s)).toBe(false);
  });

  it('start → running（⏳）；ok → 绿；顺序迁移不串位', () => {
    let s = checksReducer(initialChecks(), { type: 'start', id: 'bridge' });
    expect(s.bridge.status).toBe('running');
    expect(s.kernel.status).toBe('pending');
    s = checksReducer(s, { type: 'ok', id: 'bridge' });
    expect(s.bridge).toEqual({ status: 'ok', error: null });
    expect(statusIcon(s.bridge.status)).toBe('✅');
    expect(statusIcon(s.kernel.status)).toBe('⏳');
  });

  it('fail 记录 error 摘要；再 start 清空 error（重跑语义）', () => {
    let s = checksReducer(initialChecks(), { type: 'fail', id: 'kernel', error: 'ping 超时' });
    expect(s.kernel).toEqual({ status: 'fail', error: 'ping 超时' });
    expect(statusIcon('fail')).toBe('❌');
    s = checksReducer(s, { type: 'start', id: 'kernel' });
    expect(s.kernel).toEqual({ status: 'running', error: null });
  });

  it('skip：bridge 失败后其余标记跳过（可带原因），allSettled 收敛', () => {
    let s = checksReducer(initialChecks(), { type: 'fail', id: 'bridge', error: '连接拒绝' });
    for (const id of ['kernel', 'deps', 'writable'] as const) {
      s = checksReducer(s, { type: 'skip', id, error: 'bridge 未连接' });
    }
    expect(allSettled(s)).toBe(true);
    expect(allOk(s)).toBe(false);
    expect(statusIcon(s.deps.status)).toBe('❌');
    expect(s.kernel.error).toBe('bridge 未连接');
  });

  it('allOk：四项全绿才 true', () => {
    let s: ChecksState = initialChecks();
    for (const id of CHECK_ORDER) {
      s = checksReducer(s, { type: 'start', id });
      s = checksReducer(s, { type: 'ok', id });
    }
    expect(allSettled(s)).toBe(true);
    expect(allOk(s)).toBe(true);
  });

  it('未知 id 事件不炸、状态原样返回', () => {
    const s = initialChecks();
    const next = checksReducer(s, { type: 'ok', id: 'nope' as never });
    expect(next).toBe(s);
  });
});

describe('fixCommand', () => {
  it('deps 失败 → uv sync；其余失败 → pnpm install；非失败态 → null', () => {
    expect(fixCommand('deps', 'fail')).toBe('uv sync');
    expect(fixCommand('deps', 'skip')).toBe('uv sync');
    expect(fixCommand('bridge', 'fail')).toBe('pnpm install');
    expect(fixCommand('kernel', 'fail')).toBe('pnpm install');
    expect(fixCommand('writable', 'fail')).toBe('pnpm install');
    expect(fixCommand('deps', 'ok')).toBeNull();
    expect(fixCommand('bridge', 'pending')).toBeNull();
    expect(fixCommand('kernel', 'running')).toBeNull();
  });
});

describe('onboarded flag', () => {
  it('缺失 = 首启（false）；markOnboarded 写 novalab.onboarded 后 true', () => {
    const s = fakeStorage();
    expect(hasOnboarded(s)).toBe(false);
    markOnboarded(s);
    expect(s.dump()['novalab.onboarded']).toBe('1');
    expect(hasOnboarded(s)).toBe(true);
  });

  it('storage 抛异常：hasOnboarded 视为已引导（不骚扰）、mark 静默', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(hasOnboarded(throwing)).toBe(true);
    expect(() => markOnboarded(throwing)).not.toThrow();
  });

  it('探针文件名带时间戳（.tmp 后缀、点前缀隐藏文件）', () => {
    expect(probeFileName(123)).toBe('.novalab-onboard-probe-123.tmp');
    expect(probeFileName()).toMatch(/^\.novalab-onboard-probe-\d+\.tmp$/);
  });
});
