/**
 * ProvidersStore —— LLM provider 凭据的加密落盘存储（P4 / ADR-008）。
 *
 * 文件：`<repoRoot>/.novalab/providers.json`（mode 0600，目录 0700，已 gitignore）：
 *   { "providers": [{id, kind, name, baseURL, model, apiKeyCipher?}], "activeProviderId": string|null }
 *
 * 纪律：
 * - **apiKey 永不出桥**：list() 返回 ProviderSummary（hasKey:boolean 掩码）；
 *   明文 key 只在 set() 入口（rpc 参数）与 resolveForProxy() 出口（llm-proxy
 *   进程内注入上游请求头）短暂存在，落盘一律 encryptSecret（AES-256-GCM，
 *   机器派生密钥，威胁模型见 secret.ts 头注）。
 * - set() 为 upsert：apiKey 省略或空串 = 保留既有密文（前端编辑时不回传 key）。
 * - 文件缺失/损坏/形状不对 → 一律空态降级，不抛（与 ui.json / sessions/index.json
 *   同纪律）；下次 set 覆盖修复。
 * - 旧 localStorage 明文迁移由前端一次性 rpc 推送（providers.set 携带 apiKey），
 *   bridge 侧不主动读浏览器存储。
 *
 * 每次操作读-改-写整文件（低频、小文件；避免多 bridge 实例间的内存缓存失效问题）。
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret, SecretError } from './secret';
import type { ProviderKind, ProviderSummary } from './protocol';

/** 落盘条目：apiKeyCipher = encryptSecret(明文 key)；无 key 时缺省。 */
export interface StoredProvider {
  id: string;
  kind: ProviderKind;
  name: string;
  baseURL: string;
  model: string;
  apiKeyCipher?: string;
}

export interface ProvidersFileShape {
  providers: StoredProvider[];
  activeProviderId: string | null;
}

/** providers.set 入参：id 缺省时生成；apiKey 明文入 → 加密存（空/缺省 = 保留既有）。 */
export interface ProviderSetInput {
  id?: string;
  kind: ProviderKind;
  name: string;
  baseURL: string;
  model: string;
  apiKey?: string;
}

/** llm-proxy 消费：解密后的明文 key（只存在于 bridge 进程内）。 */
export interface ResolvedProvider {
  provider: StoredProvider;
  apiKey: string | null;
}

/** 存储级校验/解密错误（router 映射为 ERR_INVALID_PARAMS；proxy 映射为 502）。 */
export class ProvidersStoreError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ProvidersStoreError';
  }
}

export interface ProvidersStoreOptions {
  /** 存储目录（默认 <repoRoot>/.novalab；单测注入临时目录）。 */
  dir?: string;
  /** 覆盖机器密钥（单测注入；默认每次操作 machineSecret()）。 */
  secret?: Buffer;
}

/** bridge/src/providers-store.ts → 仓库根（与 main.ts 同法）。 */
function defaultDir(): string {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  return path.join(repoRoot, '.novalab');
}

const KINDS: ReadonlySet<string> = new Set<ProviderKind>(['anthropic-compat', 'openai-compat']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 宽容归一化单条目：垃圾条目丢弃；apiKeyCipher 只收 string。 */
function normalizeStored(raw: unknown): StoredProvider | null {
  if (!isRecord(raw)) return null;
  const id = raw['id'];
  const kind = raw['kind'];
  const name = raw['name'];
  const baseURL = raw['baseURL'];
  const model = raw['model'];
  if (
    typeof id !== 'string' || id === '' ||
    typeof kind !== 'string' || !KINDS.has(kind) ||
    typeof name !== 'string' ||
    typeof baseURL !== 'string' ||
    typeof model !== 'string'
  ) {
    return null;
  }
  const cipher = raw['apiKeyCipher'];
  return {
    id,
    kind: kind as ProviderKind,
    name,
    baseURL,
    model,
    ...(typeof cipher === 'string' && cipher !== '' ? { apiKeyCipher: cipher } : {}),
  };
}

function normalizeFile(raw: unknown): ProvidersFileShape {
  if (!isRecord(raw)) return { providers: [], activeProviderId: null };
  const providers = Array.isArray(raw['providers'])
    ? raw['providers'].map(normalizeStored).filter((p): p is StoredProvider => p !== null)
    : [];
  const active = raw['activeProviderId'];
  return {
    providers,
    activeProviderId:
      typeof active === 'string' && providers.some((p) => p.id === active) ? active : null,
  };
}

function toSummary(p: StoredProvider): ProviderSummary {
  return {
    id: p.id,
    kind: p.kind,
    name: p.name,
    baseURL: p.baseURL,
    model: p.model,
    hasKey: p.apiKeyCipher !== undefined,
  };
}

export class ProvidersStore {
  readonly file: string;
  private readonly secret?: Buffer;

  constructor(opts: ProvidersStoreOptions = {}) {
    this.file = path.join(opts.dir ?? defaultDir(), 'providers.json');
    this.secret = opts.secret;
  }

  // ---------- 读 ----------

  /** 全量掩码视图（rpc providers.list 响应形状）；文件损坏 → 空态不抛。 */
  list(): { providers: ProviderSummary[]; activeProviderId: string | null } {
    const shape = this.readSafe();
    return {
      providers: shape.providers.map(toSummary),
      activeProviderId: shape.activeProviderId,
    };
  }

  /**
   * llm-proxy 专用：按 id 取条目 + 解密明文 key（无 key → apiKey:null）。
   * 未知 id → null；密文解密失败（篡改/机器 secret 变化）→ 抛 ProvidersStoreError。
   */
  resolveForProxy(id: string): ResolvedProvider | null {
    const p = this.readSafe().providers.find((x) => x.id === id);
    if (!p) return null;
    if (p.apiKeyCipher === undefined) return { provider: p, apiKey: null };
    try {
      const apiKey = this.decrypt(p.apiKeyCipher);
      return { provider: p, apiKey };
    } catch (err) {
      throw new ProvidersStoreError(
        `provider "${id}" 的 key 解密失败（密文被篡改或机器 secret 已变化）`,
        err,
      );
    }
  }

  // ---------- 写 ----------

  /** upsert：返回掩码摘要。apiKey 非空 → 加密落盘；空/缺省 → 保留既有密文。 */
  set(input: ProviderSetInput): ProviderSummary {
    if (typeof input.kind !== 'string' || !KINDS.has(input.kind)) {
      throw new ProvidersStoreError(`kind 必须是 anthropic-compat|openai-compat，收到: ${String(input.kind)}`);
    }
    if (typeof input.name !== 'string' || typeof input.baseURL !== 'string' || typeof input.model !== 'string') {
      throw new ProvidersStoreError('name/baseURL/model 必须是 string');
    }
    if (typeof input.id === 'string' && input.id !== '' && /[/\\]/.test(input.id)) {
      throw new ProvidersStoreError(`id 不允许含路径分隔符: ${input.id}`);
    }
    const shape = this.readSafe();
    const id = typeof input.id === 'string' && input.id !== '' ? input.id : `p-${randomBytes(4).toString('hex')}`;
    const existing = shape.providers.find((p) => p.id === id);
    const next: StoredProvider = {
      id,
      kind: input.kind as ProviderKind,
      name: input.name,
      baseURL: input.baseURL,
      model: input.model,
    };
    const apiKey = input.apiKey;
    if (typeof apiKey === 'string' && apiKey !== '') {
      next.apiKeyCipher = this.encrypt(apiKey);
    } else if (existing?.apiKeyCipher !== undefined) {
      next.apiKeyCipher = existing.apiKeyCipher; // 编辑不带 key = 保留
    }
    if (existing) {
      shape.providers[shape.providers.indexOf(existing)] = next;
    } else {
      shape.providers.push(next);
    }
    this.write(shape);
    return toSummary(next);
  }

  /** 删除（幂等）；删的是 active → activeProviderId 归 null。 */
  remove(id: string): { deleted: boolean } {
    const shape = this.readSafe();
    const before = shape.providers.length;
    shape.providers = shape.providers.filter((p) => p.id !== id);
    const deleted = shape.providers.length < before;
    if (deleted) {
      if (shape.activeProviderId === id) shape.activeProviderId = null;
      this.write(shape);
    }
    return { deleted };
  }

  /** 设当前生效（null = 清除 → 前端走 dev-env 兜底）；未知 id → 抛。 */
  setActive(id: string | null): string | null {
    const shape = this.readSafe();
    if (id !== null && !shape.providers.some((p) => p.id === id)) {
      throw new ProvidersStoreError(`unknown provider id: ${id}`);
    }
    shape.activeProviderId = id;
    this.write(shape);
    return id;
  }

  // ---------- 文件 ----------

  /** 读 + 宽容归一化：缺失/损坏/垃圾形状 → 空态，不抛。 */
  private readSafe(): ProvidersFileShape {
    try {
      return normalizeFile(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return { providers: [], activeProviderId: null };
    }
  }

  /** 整文件重写：目录 0700、文件 0600（Windows 上 chmod 为 best-effort 语义）。 */
  private write(shape: ProvidersFileShape): void {
    const dir = path.dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify(shape, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(this.file, 0o600); // mode 只在创建时生效；既有文件补一刀
    } catch {
      /* 平台不支持则忽略（Windows 无 POSIX 位） */
    }
  }

  private encrypt(plaintext: string): string {
    return this.secret ? encryptSecret(plaintext, this.secret) : encryptSecret(plaintext);
  }

  private decrypt(payload: string): string {
    try {
      return this.secret ? decryptSecret(payload, this.secret) : decryptSecret(payload);
    } catch (err) {
      if (err instanceof SecretError) throw err;
      throw new SecretError('解密失败', err);
    }
  }
}
