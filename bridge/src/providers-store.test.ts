import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProvidersStore, ProvidersStoreError } from './providers-store';
import { machineSecret } from './secret';

/**
 * P4 providers-store 单测：CRUD + hasKey 掩码（apiKey 永不出桥）+ 0600 落盘 +
 * upsert 保留既有密文 + 损坏文件空态降级 + 解密失败（secret 变化）显式抛。
 */

const SECRET = machineSecret({ NOVALAB_SECRET: 'store-unit-test' });

function tmpStore(secret: Buffer = SECRET) {
  const dir = mkdtempSync(path.join(tmpdir(), 'novalab-providers-'));
  const store = new ProvidersStore({ dir, secret });
  return { store, dir, file: path.join(dir, 'providers.json') };
}

function input(over: Partial<Parameters<ProvidersStore['set']>[0]> = {}) {
  return {
    kind: 'anthropic-compat' as const,
    name: 'tokenplan',
    baseURL: 'https://tokenplan.local/v1',
    model: 'qwen3.8-max',
    ...over,
  };
}

describe('set / list（CRUD + 掩码）', () => {
  it('set 带 apiKey → list 返回 hasKey:true 掩码，摘要不含任何 key 字段', () => {
    const { store } = tmpStore();
    const summary = store.set(input({ id: 'p1', apiKey: 'sk-plain-secret' }));
    expect(summary).toEqual({
      id: 'p1',
      kind: 'anthropic-compat',
      name: 'tokenplan',
      baseURL: 'https://tokenplan.local/v1',
      model: 'qwen3.8-max',
      hasKey: true,
    });
    const list = store.list();
    expect(list.providers).toEqual([summary]);
    expect(list.activeProviderId).toBeNull();
    // 掩码纪律：出桥形状里不存在 apiKey / apiKeyCipher 字段
    expect('apiKey' in summary).toBe(false);
    expect('apiKeyCipher' in summary).toBe(false);
    expect(JSON.stringify(list)).not.toContain('sk-plain-secret');
  });

  it('set 不带 apiKey → hasKey:false；resolveForProxy 得 apiKey:null', () => {
    const { store } = tmpStore();
    expect(store.set(input({ id: 'ollama' })).hasKey).toBe(false);
    expect(store.resolveForProxy('ollama')).toEqual({
      provider: expect.objectContaining({ id: 'ollama' }),
      apiKey: null,
    });
  });

  it('set 省略 id → 生成 p-<hex8>；id 含路径分隔符 → 抛', () => {
    const { store } = tmpStore();
    const s = store.set(input());
    expect(s.id).toMatch(/^p-[0-9a-f]{8}$/);
    expect(() => store.set(input({ id: '../evil' }))).toThrow(ProvidersStoreError);
    expect(() => store.set(input({ id: 'a\\b' }))).toThrow(ProvidersStoreError);
  });

  it('非法 kind → 抛 ProvidersStoreError', () => {
    const { store } = tmpStore();
    expect(() => store.set(input({ kind: 'gemini' as never }))).toThrow(ProvidersStoreError);
  });

  it('upsert：同 id 覆盖元数据；apiKey 省略/空串 = 保留既有密文', () => {
    const { store } = tmpStore();
    store.set(input({ id: 'p1', apiKey: 'sk-original' }));
    store.set(input({ id: 'p1', name: 'renamed' })); // 编辑不带 key
    expect(store.list().providers).toHaveLength(1);
    expect(store.list().providers[0]!.name).toBe('renamed');
    expect(store.resolveForProxy('p1')!.apiKey).toBe('sk-original');

    store.set(input({ id: 'p1', apiKey: '' })); // 空串同样保留
    expect(store.resolveForProxy('p1')!.apiKey).toBe('sk-original');

    store.set(input({ id: 'p1', apiKey: 'sk-rotated' })); // 显式新 key → 轮换
    expect(store.resolveForProxy('p1')!.apiKey).toBe('sk-rotated');
  });
});

describe('落盘（.novalab/providers.json）', () => {
  it('文件存 apiKeyCipher 密文（v1. 前缀），明文 key 不出现', () => {
    const { store, file } = tmpStore();
    store.set(input({ id: 'p1', apiKey: 'sk-plain-secret' }));
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('sk-plain-secret');
    const parsed = JSON.parse(raw) as { providers: Array<{ apiKeyCipher?: string }> };
    expect(parsed.providers[0]!.apiKeyCipher).toMatch(/^v1\./);
  });

  it('POSIX 下文件 mode 0600（Windows 无 POSIX 位，跳过断言）', () => {
    const { store, file } = tmpStore();
    store.set(input({ id: 'p1', apiKey: 'sk' }));
    if (process.platform === 'win32') {
      expect(existsSync(file)).toBe(true);
      return;
    }
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('既有文件被 chmod 放宽后，再次写入收回 0600（write 补 chmod）', () => {
    const { store, file } = tmpStore();
    store.set(input({ id: 'p1' }));
    if (process.platform !== 'win32') {
      chmodSync(file, 0o644);
      store.set(input({ id: 'p2' }));
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } else {
      store.set(input({ id: 'p2' }));
      expect(existsSync(file)).toBe(true);
    }
  });
});

describe('remove / setActive', () => {
  it('remove 幂等；删 active → activeProviderId 归 null', () => {
    const { store } = tmpStore();
    store.set(input({ id: 'p1' }));
    store.set(input({ id: 'p2', kind: 'openai-compat' }));
    store.setActive('p1');
    expect(store.remove('p1')).toEqual({ deleted: true });
    expect(store.list().activeProviderId).toBeNull();
    expect(store.remove('p1')).toEqual({ deleted: false }); // 幂等
    expect(store.remove('p2')).toEqual({ deleted: true });
    expect(store.list().providers).toEqual([]);
  });

  it('setActive：合法 id 生效、null 清除、未知 id 抛', () => {
    const { store } = tmpStore();
    store.set(input({ id: 'p1' }));
    expect(store.setActive('p1')).toBe('p1');
    expect(store.list().activeProviderId).toBe('p1');
    expect(store.setActive(null)).toBeNull();
    expect(store.list().activeProviderId).toBeNull();
    expect(() => store.setActive('ghost')).toThrow(ProvidersStoreError);
  });
});

describe('损坏 / 解密失败降级', () => {
  it('文件缺失 → 空态；损坏 JSON / 垃圾形状 → 空态不抛；再 set 修复文件', () => {
    const { store, file } = tmpStore();
    expect(store.list()).toEqual({ providers: [], activeProviderId: null });
    expect(store.resolveForProxy('p1')).toBeNull();

    writeFileSync(file, '{oops not json', 'utf8');
    expect(store.list()).toEqual({ providers: [], activeProviderId: null });

    writeFileSync(file, JSON.stringify({ providers: 'not-an-array', activeProviderId: 42 }), 'utf8');
    expect(store.list()).toEqual({ providers: [], activeProviderId: null });

    // 垃圾条目丢弃、合法条目保留、悬空 activeProviderId 归 null
    writeFileSync(
      file,
      JSON.stringify({
        providers: [null, { id: 'bad' }, { id: 'p1', kind: 'nope', name: 'x', baseURL: 'y', model: 'z' }, { id: 'p2', kind: 'openai-compat', name: 'ok', baseURL: 'http://h/v1', model: 'm' }],
        activeProviderId: 'ghost',
      }),
      'utf8',
    );
    const list = store.list();
    expect(list.providers.map((p) => p.id)).toEqual(['p2']);
    expect(list.activeProviderId).toBeNull();

    store.set(input({ id: 'p3' }));
    expect(store.list().providers.map((p) => p.id)).toEqual(['p2', 'p3']);
  });

  it('密文解密失败（机器 secret 变化 / 篡改）→ resolveForProxy 抛 ProvidersStoreError，list 不受影响', () => {
    const { store, dir, file } = tmpStore();
    store.set(input({ id: 'p1', apiKey: 'sk-secret' }));
    // 同一文件用另一把密钥打开 = 换机器/换 NOVALAB_SECRET 场景
    const other = new ProvidersStore({ dir, secret: machineSecret({ NOVALAB_SECRET: 'different' }) });
    expect(() => other.resolveForProxy('p1')).toThrow(ProvidersStoreError);
    expect(other.list().providers[0]!.hasKey).toBe(true); // 掩码读取不触发解密

    // 密文被手改一位 → 同样显式抛（GCM 篡改检测）
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { providers: Array<{ apiKeyCipher: string }> };
    const cipher = parsed.providers[0]!.apiKeyCipher;
    parsed.providers[0]!.apiKeyCipher = cipher.slice(0, -2) + (cipher.endsWith('A') ? 'B' : 'A');
    writeFileSync(file, JSON.stringify(parsed), 'utf8');
    expect(() => store.resolveForProxy('p1')).toThrow(ProvidersStoreError);
  });

  it('两个 store 实例共用同一目录：写后互见（读-改-写无缓存过期问题）', () => {
    const { dir } = tmpStore();
    const a = new ProvidersStore({ dir, secret: SECRET });
    const b = new ProvidersStore({ dir, secret: SECRET });
    a.set(input({ id: 'p1' }));
    expect(b.list().providers.map((p) => p.id)).toEqual(['p1']);
    b.set(input({ id: 'p2', kind: 'openai-compat' }));
    expect(a.list().providers.map((p) => p.id)).toEqual(['p1', 'p2']);
  });
});
