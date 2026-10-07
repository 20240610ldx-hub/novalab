import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RpcRouter } from './router';
import { KernelSupervisor } from './supervisor';
import { ProvidersStore } from './providers-store';
import { machineSecret } from './secret';
import { FakeKernel } from './testing/fake-kernel';
import type { RpcResponse } from './protocol';

/**
 * P4 providers.* rpc 路由单测：list/set/delete/setActive 四方法 +
 * 参数校验（RpcFault → -32602）+ apiKey 永不出桥（响应无明文/无密文字段）。
 */

const SECRET = machineSecret({ NOVALAB_SECRET: 'router-providers-test' });

let sup: KernelSupervisor | undefined;
let router: RpcRouter | undefined;

afterEach(() => {
  router?.dispose();
  sup?.stop();
  sup = undefined;
  router = undefined;
});

function setup() {
  sup = new KernelSupervisor({
    transportFactory: () => new FakeKernel(),
    pingIntervalMs: 60_000,
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'novalab-router-providers-'));
  const store = new ProvidersStore({ dir, secret: SECRET });
  router = new RpcRouter({ supervisor: sup, broadcast: () => {}, providersStore: store });
  let reqId = 0;
  const call = (method: string, params?: unknown): Promise<RpcResponse> =>
    router!.handle({ jsonrpc: '2.0', id: ++reqId, method, params });
  return { call, store, file: store.file };
}

describe('providers.list', () => {
  it('初始空态（无需 notebook.open）', async () => {
    const { call } = setup();
    const res = await call('providers.list');
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ providers: [], activeProviderId: null });
  });

  it('存储文件损坏 → 空态降级，不抛 -32603', async () => {
    const { call, file } = setup();
    writeFileSync(file, '###corrupt###', 'utf8');
    const res = await call('providers.list');
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ providers: [], activeProviderId: null });
  });
});

describe('providers.set', () => {
  it('upsert → 掩码摘要；list 可见；apiKey 明文/密文均不出现在 rpc 响应', async () => {
    const { call } = setup();
    const res = await call('providers.set', {
      id: 'tp',
      kind: 'anthropic-compat',
      name: 'tokenplan',
      baseURL: 'https://tokenplan.local/v1',
      model: 'qwen3.8-max',
      apiKey: 'sk-super-secret',
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({
      id: 'tp',
      kind: 'anthropic-compat',
      name: 'tokenplan',
      baseURL: 'https://tokenplan.local/v1',
      model: 'qwen3.8-max',
      hasKey: true,
    });
    const wire = JSON.stringify(res);
    expect(wire).not.toContain('sk-super-secret');
    expect(wire).not.toContain('apiKeyCipher');

    const list = await call('providers.list');
    expect(list.result).toEqual({
      providers: [
        {
          id: 'tp',
          kind: 'anthropic-compat',
          name: 'tokenplan',
          baseURL: 'https://tokenplan.local/v1',
          model: 'qwen3.8-max',
          hasKey: true,
        },
      ],
      activeProviderId: null,
    });
    expect(JSON.stringify(list)).not.toContain('sk-super-secret');
  });

  it('省略 id → bridge 生成；再次 set 同 id = 覆盖（apiKey 省略保留）', async () => {
    const { call, store } = setup();
    const r1 = await call('providers.set', {
      kind: 'openai-compat',
      name: 'deepseek',
      baseURL: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: 'sk-ds',
    });
    const id = (r1.result as { id: string }).id;
    expect(id).toMatch(/^p-[0-9a-f]{8}$/);

    const r2 = await call('providers.set', { id, kind: 'openai-compat', name: 'deepseek-v2', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });
    expect((r2.result as { name: string }).name).toBe('deepseek-v2');
    expect(store.resolveForProxy(id)!.apiKey).toBe('sk-ds'); // 编辑不带 key = 保留
  });

  it('参数校验 → -32602：非法 kind / 缺 name / 空 model / baseURL 非法 URL / apiKey 非 string', async () => {
    const { call } = setup();
    const base = { kind: 'anthropic-compat', name: 'n', baseURL: 'https://h/v1', model: 'm' };
    expect((await call('providers.set', { ...base, kind: 'gemini' })).error?.code).toBe(-32602);
    expect((await call('providers.set', { ...base, name: '' })).error?.code).toBe(-32602);
    expect((await call('providers.set', { ...base, model: 42 })).error?.code).toBe(-32602);
    expect((await call('providers.set', { ...base, baseURL: 'not a url' })).error?.code).toBe(-32602);
    expect((await call('providers.set', { ...base, apiKey: 123 })).error?.code).toBe(-32602);
    expect((await call('providers.set', {})).error?.code).toBe(-32602);
  });
});

describe('providers.delete / providers.setActive', () => {
  it('delete 幂等；删 active → activeProviderId 归 null', async () => {
    const { call } = setup();
    await call('providers.set', { id: 'a', kind: 'anthropic-compat', name: 'a', baseURL: 'https://a/v1', model: 'm' });
    await call('providers.set', { id: 'b', kind: 'openai-compat', name: 'b', baseURL: 'https://b/v1', model: 'm' });
    await call('providers.setActive', { id: 'a' });

    expect((await call('providers.delete', { id: 'a' })).result).toEqual({ deleted: true });
    expect((await call('providers.delete', { id: 'a' })).result).toEqual({ deleted: false });
    expect((await call('providers.list')).result).toEqual({
      providers: [expect.objectContaining({ id: 'b' })],
      activeProviderId: null,
    });
  });

  it('setActive：合法 id / null 清除 / 未知 id → -32602 / 非 string|null → -32602', async () => {
    const { call } = setup();
    await call('providers.set', { id: 'a', kind: 'anthropic-compat', name: 'a', baseURL: 'https://a/v1', model: 'm' });
    expect((await call('providers.setActive', { id: 'a' })).result).toEqual({ activeProviderId: 'a' });
    expect((await call('providers.setActive', { id: null })).result).toEqual({ activeProviderId: null });
    expect((await call('providers.setActive', { id: 'ghost' })).error?.code).toBe(-32602);
    expect((await call('providers.setActive', { id: 42 })).error?.code).toBe(-32602);
    expect((await call('providers.setActive', {})).error?.code).toBe(-32602);
  });

  it('delete 缺 id → -32602', async () => {
    const { call } = setup();
    expect((await call('providers.delete', {})).error?.code).toBe(-32602);
  });
});
