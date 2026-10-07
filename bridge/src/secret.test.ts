import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, machineSecret, SecretError } from './secret';

/**
 * P4 secret 单测：机器派生密钥（env 覆盖 / 稳定性）+ AES-256-GCM 往返 +
 * 篡改检测（iv/tag/ct 任一位被改、密钥不符、格式非法 → SecretError）。
 */

const KEY = machineSecret({ NOVALAB_SECRET: 'unit-test-secret' });

describe('machineSecret', () => {
  it('机器指纹派生 32 字节密钥，重复调用稳定（AES-256 要求定长）', () => {
    const a = machineSecret({});
    const b = machineSecret({});
    expect(Buffer.isBuffer(a)).toBe(true);
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(true);
  });

  it('NOVALAB_SECRET 优先：同 env 稳定、异 env 不同、与指纹派生不同', () => {
    const s1 = machineSecret({ NOVALAB_SECRET: 'alpha' });
    const s2 = machineSecret({ NOVALAB_SECRET: 'alpha' });
    const s3 = machineSecret({ NOVALAB_SECRET: 'beta' });
    expect(s1.equals(s2)).toBe(true);
    expect(s1.equals(s3)).toBe(false);
    expect(s1.equals(machineSecret({}))).toBe(false);
  });

  it('空串 NOVALAB_SECRET 视同缺省（回落机器指纹）', () => {
    expect(machineSecret({ NOVALAB_SECRET: '' }).equals(machineSecret({}))).toBe(true);
  });
});

describe('encryptSecret / decryptSecret 往返', () => {
  it('明文往返一致（含 unicode / 空串 / 长文本）', () => {
    for (const plain of ['sk-abc123', '', '密钥-🔐-unicode', 'x'.repeat(10_000)]) {
      expect(decryptSecret(encryptSecret(plain, KEY), KEY)).toBe(plain);
    }
  });

  it('密文为 v1.<iv>.<tag>.<ct> base64url 三段；同明文每次 iv 不同（密文不重放）', () => {
    const a = encryptSecret('same-plaintext', KEY);
    const b = encryptSecret('same-plaintext', KEY);
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, KEY)).toBe('same-plaintext');
    expect(decryptSecret(b, KEY)).toBe('same-plaintext');
  });

  it('缺省密钥（机器指纹）往返一致', () => {
    const ct = encryptSecret('sk-machine');
    expect(decryptSecret(ct)).toBe('sk-machine');
  });
});

describe('篡改检测（GCM 认证）', () => {
  function tamper(payload: string, segment: 1 | 2 | 3): string {
    const parts = payload.split('.');
    const orig = parts[segment]!;
    parts[segment] = (orig[0] === 'A' ? 'B' : 'A') + orig.slice(1);
    return parts.join('.');
  }

  it('ct 改一位 → SecretError', () => {
    expect(() => decryptSecret(tamper(encryptSecret('sk-secret', KEY), 3), KEY)).toThrow(SecretError);
  });

  it('tag 改一位 → SecretError', () => {
    expect(() => decryptSecret(tamper(encryptSecret('sk-secret', KEY), 2), KEY)).toThrow(SecretError);
  });

  it('iv 改一位 → SecretError', () => {
    expect(() => decryptSecret(tamper(encryptSecret('sk-secret', KEY), 1), KEY)).toThrow(SecretError);
  });

  it('密钥不符（换机器指纹 / NOVALAB_SECRET 变化）→ SecretError', () => {
    const other = machineSecret({ NOVALAB_SECRET: 'other-machine' });
    expect(() => decryptSecret(encryptSecret('sk', KEY), other)).toThrow(SecretError);
  });

  it('格式非法 → SecretError（不泄漏内部异常形状）', () => {
    for (const bad of ['not-a-payload', 'v1.only.three', 'v2.a.b.c', 'v1.!!!.b.c']) {
      expect(() => decryptSecret(bad, KEY)).toThrow(SecretError);
    }
  });
});
