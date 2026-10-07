/**
 * 首启引导检查 reducer（P4.4，intent 风险章：uv 环境自检/修复向导）。
 *
 * 纯函数（logic.test.ts 覆盖）：四项检查按序异步跑，行内状态 ⏳/✅/❌。
 * - bridge：store.bridgeConnected 轮询等待（App 启动即 connectBridge）；
 * - kernel：bridge rpc `ping`（router 的活性应答 {pong}）；
 * - deps：rpc `kernel.repl` 执行 `import pandas, matplotlib` 判 ok
 *   （直连 bridge，不经 store.runRepl——避免探针回灌 [repl] cell）；
 * - writable：rpc `fs.writeFile` 写探针临时文件，再 `fs.remove` 清理。
 * bridge 失败 → 后续 rpc 检查全部 skip（❌ 已跳过），不做无谓等待。
 */

export type CheckId = 'bridge' | 'kernel' | 'deps' | 'writable';

/** 检查顺序即展示顺序；bridge 是其余三项的前置。 */
export const CHECK_ORDER: readonly CheckId[] = ['bridge', 'kernel', 'deps', 'writable'];

export type CheckStatus = 'pending' | 'running' | 'ok' | 'fail' | 'skip';

export interface CheckState {
  status: CheckStatus;
  /** fail 时的错误摘要（行内展示）。 */
  error: string | null;
}

export type ChecksState = Record<CheckId, CheckState>;

export type CheckEvent =
  | { type: 'start'; id: CheckId }
  | { type: 'ok'; id: CheckId }
  | { type: 'fail'; id: CheckId; error: string }
  /** 前置检查失败 → 依赖它的后续检查标记跳过（error 说明原因）。 */
  | { type: 'skip'; id: CheckId; error?: string };

export function initialChecks(): ChecksState {
  return {
    bridge: { status: 'pending', error: null },
    kernel: { status: 'pending', error: null },
    deps: { status: 'pending', error: null },
    writable: { status: 'pending', error: null },
  };
}

export function checksReducer(state: ChecksState, ev: CheckEvent): ChecksState {
  const prev = state[ev.id];
  if (!prev) return state;
  switch (ev.type) {
    case 'start':
      return { ...state, [ev.id]: { status: 'running', error: null } };
    case 'ok':
      return { ...state, [ev.id]: { status: 'ok', error: null } };
    case 'fail':
      return { ...state, [ev.id]: { status: 'fail', error: ev.error } };
    case 'skip':
      return { ...state, [ev.id]: { status: 'skip', error: ev.error ?? null } };
  }
}

/** 状态 → 行内图标（⏳ 含 pending/running、✅ ok、❌ fail/skip）。 */
export function statusIcon(status: CheckStatus): string {
  switch (status) {
    case 'ok':
      return '✅';
    case 'fail':
    case 'skip':
      return '❌';
    default:
      return '⏳';
  }
}

/** 全部落定（无 pending/running）。 */
export function allSettled(state: ChecksState): boolean {
  return CHECK_ORDER.every((id) => {
    const s = state[id].status;
    return s === 'ok' || s === 'fail' || s === 'skip';
  });
}

/** 是否全绿（决定「开始使用」的措辞强调，按钮恒可用——引导不设卡）。 */
export function allOk(state: ChecksState): boolean {
  return CHECK_ORDER.every((id) => state[id].status === 'ok');
}

/**
 * 失败项的可复制修复命令（原文，不翻译）：
 * - deps（内核缺 pandas/matplotlib = venv 未同步）→ `uv sync`；
 * - bridge/kernel/writable（进程或依赖未装齐）→ `pnpm install`。
 * ok/pending 等非失败态 → null。
 */
export function fixCommand(id: CheckId, status: CheckStatus): string | null {
  if (status !== 'fail' && status !== 'skip') return null;
  return id === 'deps' ? 'uv sync' : 'pnpm install';
}

/** 探针临时文件名（工作区 root 内；时间戳避免并发碰撞）。 */
export function probeFileName(now: number = Date.now()): string {
  return `.novalab-onboard-probe-${now}.tmp`;
}

/* ---- localStorage flag（'novalab.onboarded'；缺失 = 首启） ---- */

export const ONBOARDED_KEY = 'novalab.onboarded';

/** flag 是否存在（storage 不可用/抛异常 → 视为已引导，不弹模态骚扰）。 */
export function hasOnboarded(storage: Pick<Storage, 'getItem'>): boolean {
  try {
    return storage.getItem(ONBOARDED_KEY) !== null;
  } catch {
    return true;
  }
}

/** 「开始使用」写 flag（任意非空值即可；'1' 约定）。storage 抛异常静默。 */
export function markOnboarded(storage: Pick<Storage, 'setItem'>): void {
  try {
    storage.setItem(ONBOARDED_KEY, '1');
  } catch {
    /* 忽略：内存态关闭仍生效，下次启动会再弹 */
  }
}
