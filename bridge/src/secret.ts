/**
 * machineSecret + AES-256-GCM 加解密（P4 / ADR-008 落地：凭据加密存储）。
 *
 * 威胁模型（与 SECURITY.md 声明同级）：
 * - **防 casual 披露**：`.novalab/providers.json` 不再是明文——防误共享目录、
 *   截图、备份泄露、其他软件顺手读文件这类低成本披露。
 * - **不防决心本地攻击者**：默认密钥由机器指纹（hostname + username + os.release
 *   + 固定上下文）派生，同机同权限的任何进程都能重算并解密；这是设计取舍，
 *   与 VS Code / npm 等工具的同级凭据保护 posture 一致，不假装是 keychain。
 * - `NOVALAB_SECRET` 环境变量优先：Owner 可注入自己的强 secret（仍需保密——
 *   能读 bridge 进程环境的攻击者同样能拿到它，但抬高了离线拿文件的门槛）。
 *
 * 密文格式：`v1.<iv b64url>.<tag b64url>.<ct b64url>`（GCM tag 即篡改检测：
 * 任何一位被改，decrypt 抛 SecretError）。
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { hostname, release, userInfo } from 'node:os';

/** 派生上下文盐：格式/算法换代时递增（v1 = sha256 指纹 + AES-256-GCM）。 */
export const SECRET_CONTEXT = 'novalab-v1';

const IV_BYTES = 12; // GCM 推荐 96-bit IV
const CIPHER_FORMAT = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)$/;

/** 解密失败 / 密文格式非法（含 GCM 认证失败 = 篡改或机器指纹变化）。 */
export class SecretError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SecretError';
  }
}

function sha256(material: string): Buffer {
  return createHash('sha256').update(material, 'utf8').digest();
}

function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return 'unknown'; // 无 passwd 条目的奇异环境：降级为常量（同机仍可复算）
  }
}

function safeRelease(): string {
  try {
    return release();
  } catch {
    return 'unknown';
  }
}

/**
 * 32 字节 AES-256 密钥：env NOVALAB_SECRET 优先（sha256 归一化到定长），
 * 否则 sha256(hostname + username + os.release + 'novalab-v1')。
 * 每次调用重算（sha256 成本可忽略；避免缓存导致测试注入 env 不生效）。
 */
export function machineSecret(env: NodeJS.ProcessEnv = process.env): Buffer {
  const explicit = env['NOVALAB_SECRET'];
  if (typeof explicit === 'string' && explicit.length > 0) {
    return sha256(`${SECRET_CONTEXT}|env|${explicit}`);
  }
  return sha256(`${hostname()}|${safeUsername()}|${safeRelease()}|${SECRET_CONTEXT}`);
}

/** 明文 → `v1.<iv>.<tag>.<ct>`（base64url 三段；iv 每次随机）。 */
export function encryptSecret(plaintext: string, key: Buffer = machineSecret()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`;
}

/** `v1.<iv>.<tag>.<ct>` → 明文。格式非法 / 被篡改 / 密钥不符 → 抛 SecretError。 */
export function decryptSecret(payload: string, key: Buffer = machineSecret()): string {
  const m = CIPHER_FORMAT.exec(payload);
  if (!m) throw new SecretError('密文格式非法（期望 v1.<iv>.<tag>.<ct>）');
  try {
    const iv = Buffer.from(m[1]!, 'base64url');
    const tag = Buffer.from(m[2]!, 'base64url');
    const ct = Buffer.from(m[3]!, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (err) {
    // GCM final() 抛 = auth tag 不匹配：密文被篡改，或机器指纹/NOVALAB_SECRET 变了
    throw new SecretError('解密失败（密文被篡改，或机器 secret 已变化）', err);
  }
}
