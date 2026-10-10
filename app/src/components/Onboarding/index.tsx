/**
 * 首启引导模态（P4.4，intent 风险章：uv 环境自检/修复向导）。
 *
 * localStorage 'novalab.onboarded' 缺失 → 首启弹出；四项检查按序异步跑，
 * 行内 ⏳/✅/❌（reducer 在 logic.ts，纯函数单测覆盖）：
 *   1. bridge 连接   —— useNotebook.bridgeConnected 轮询等待（启动即 connectBridge）；
 *   2. 内核 ping     —— bridge rpc `ping`（router 活性应答）；
 *   3. demo 依赖     —— rpc `kernel.repl` 跑 `import pandas, matplotlib` 判 ok；
 *   4. 工作区可写    —— rpc `fs.writeFile` 写探针临时文件，`fs.remove` 清理。
 * bridge 失败 → 后续三项 skip（rpc 无从谈起）。失败/跳过项展示可复制修复命令
 * （uv sync / pnpm install 原文）。按钮：「开始使用」写 flag 关闭；「稍后重试」
 * 仅关闭（下次启动仍弹）。SettingsPanel 有「重跑首启检查」入口（rerun prop）。
 *
 * 注意：deps 检查需要已打开 notebook（kernel.repl 走 focus 内核）；未打开时
 * 如实报 ❌ 并给 uv sync 修复命令——首启引导本来就承担「环境哪里没就绪」的解释。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from '../../bridge/client';
import { useNotebook } from '../../store/notebook';
import { useI18n, type I18nKey } from '../../i18n';
import { CopyButton } from '../CellEditor';
import {
  CHECK_ORDER,
  allOk,
  checksReducer,
  fixCommand,
  hasOnboarded,
  initialChecks,
  markOnboarded,
  probeFileName,
  statusIcon,
  type CheckId,
  type ChecksState,
} from './logic';

/** 检查项 → 字典键（模板串拼接不满足 I18nKey 字面量类型，显式映射）。 */
const CHECK_LABEL_KEY: Record<CheckId, I18nKey> = {
  bridge: 'onboarding.check.bridge',
  kernel: 'onboarding.check.kernel',
  deps: 'onboarding.check.deps',
  writable: 'onboarding.check.writable',
};

/** bridge 等待窗口：App 启动即 connectBridge，给它 6s 落定再判 ❌。 */
const BRIDGE_WAIT_MS = 6000;
const BRIDGE_POLL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** rpc 载荷宽松取字段（kernel.repl 响应形态见 kernel/types.ts ReplResult）。 */
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

export interface OnboardingProps {
  /** SettingsPanel「重跑首启检查」：无视 flag 强制打开。 */
  rerun?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function Onboarding({ rerun = false, onOpenChange }: OnboardingProps) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(
    () => rerun || (typeof localStorage !== 'undefined' ? !hasOnboarded(localStorage) : false),
  );
  const [checks, setChecks] = useState<ChecksState>(initialChecks);
  const cancelRef = useRef(false);

  useEffect(() => {
    onOpenChange?.(visible);
  }, [visible, onOpenChange]);

  // rerun prop 翻true → 重置状态并打开（SettingsPanel 入口）
  useEffect(() => {
    if (!rerun) return;
    setChecks(initialChecks());
    setVisible(true);
  }, [rerun]);

  const apply = useCallback((ev: Parameters<typeof checksReducer>[1]) => {
    setChecks((s) => checksReducer(s, ev));
  }, []);

  /* ---- 四项检查的执行器（挂载/重跑时一次性顺序执行） ---- */
  const runChecks = useCallback(async () => {
    // 1. bridge：轮询 store.bridgeConnected（连接动作在 App 启动序列里）
    apply({ type: 'start', id: 'bridge' });
    const deadline = Date.now() + BRIDGE_WAIT_MS;
    let connected = useNotebook.getState().bridgeConnected;
    while (!connected && Date.now() < deadline && !cancelRef.current) {
      await sleep(BRIDGE_POLL_MS);
      connected = useNotebook.getState().bridgeConnected;
    }
    if (cancelRef.current) return;
    if (!connected) {
      apply({ type: 'fail', id: 'bridge', error: 'bridge discovery 未连接' });
      for (const id of ['kernel', 'deps', 'writable'] as const) {
        apply({ type: 'skip', id, error: t('onboarding.skipped') });
      }
      return;
    }
    apply({ type: 'ok', id: 'bridge' });

    // 2. 内核 ping（bridge rpc 活性应答）
    apply({ type: 'start', id: 'kernel' });
    try {
      await bridge.rpc('ping');
      if (cancelRef.current) return;
      apply({ type: 'ok', id: 'kernel' });
    } catch (err) {
      if (cancelRef.current) return;
      apply({ type: 'fail', id: 'kernel', error: errText(err) });
    }

    // 3. demo 依赖：kernel.repl 直连 bridge（不经 store.runRepl，避免灌 [repl] cell）
    apply({ type: 'start', id: 'deps' });
    try {
      const res = asRecord(await bridge.rpc('kernel.repl', { code: 'import pandas, matplotlib' }));
      if (cancelRef.current) return;
      if (res.ok === false) {
        const tb = typeof res.traceback === 'string' ? res.traceback : '';
        apply({ type: 'fail', id: 'deps', error: tb.split('\n').pop() || 'import 失败' });
      } else {
        apply({ type: 'ok', id: 'deps' });
      }
    } catch (err) {
      if (cancelRef.current) return;
      apply({ type: 'fail', id: 'deps', error: errText(err) });
    }

    // 4. 工作区可写：fs.writeFile 探针 → fs.remove 清理
    apply({ type: 'start', id: 'writable' });
    const probe = probeFileName();
    try {
      await bridge.rpc('fs.writeFile', { path: probe, content: 'probe' });
      try {
        await bridge.rpc('fs.remove', { path: probe });
      } catch {
        /* 清理失败不算不可写（写入已成功）；残留 .tmp 无害 */
      }
      if (cancelRef.current) return;
      apply({ type: 'ok', id: 'writable' });
    } catch (err) {
      if (cancelRef.current) return;
      apply({ type: 'fail', id: 'writable', error: errText(err) });
    }
  }, [apply, t]);

  useEffect(() => {
    if (!visible) return;
    cancelRef.current = false;
    void runChecks();
    return () => {
      cancelRef.current = true;
    };
  }, [visible, runChecks]);

  if (!visible) return null;

  const start = () => {
    if (typeof localStorage !== 'undefined') markOnboarded(localStorage);
    setVisible(false);
  };
  const later = () => setVisible(false);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('onboarding.title')}
        className="w-[min(560px,92vw)] rounded-lg border border-[var(--border)] bg-[var(--panel)] p-5"
      >
        <h2 className="text-[15px] text-[var(--text)]">{t('onboarding.title')}</h2>
        <p className="mt-1 text-[12px] text-[var(--muted)]">{t('onboarding.intro')}</p>

        <ul className="mt-4 space-y-2">
          {CHECK_ORDER.map((id: CheckId) => {
            const c = checks[id];
            const fix = fixCommand(id, c.status);
            return (
              <li key={id} className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
                <div className="flex items-center gap-2 text-[12.5px]">
                  <span aria-hidden>{statusIcon(c.status)}</span>
                  <span className="text-[var(--text)]">{t(CHECK_LABEL_KEY[id])}</span>
                  <span className="ml-auto text-[11px] text-[var(--muted)]">
                    {c.status === 'running' || c.status === 'pending'
                      ? t('onboarding.status.running')
                      : c.status === 'ok'
                        ? t('onboarding.status.ok')
                        : ''}
                  </span>
                </div>
                {c.error && c.status === 'fail' && (
                  <p className="mt-1 break-all pl-6 text-[11px] text-[var(--accent-err)]">{c.error}</p>
                )}
                {c.error && c.status === 'skip' && (
                  <p className="mt-1 pl-6 text-[11px] text-[var(--muted)]">{c.error}</p>
                )}
                {fix && (
                  <div className="mt-1.5 pl-6">
                    <p className="text-[11px] text-[var(--muted)]">{t('onboarding.fixLabel')}</p>
                    <div className="mt-0.5 flex items-center gap-2">
                      <code
                        className="rounded border border-[var(--border)] bg-[var(--panel)] px-2 py-0.5 text-[11.5px] text-[var(--text)]"
                        style={{ fontFamily: 'var(--font-mono)' }}
                      >
                        {fix}
                      </code>
                      <CopyButton getText={() => fix} label={t('onboarding.copyFix')} />
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={later}
            className="rounded border border-[var(--border)] px-3 py-1 text-[12px] text-[var(--muted)] hover:text-[var(--text)]"
          >
            {t('onboarding.later')}
          </button>
          <button
            type="button"
            onClick={start}
            className={`rounded border px-3 py-1 text-[12px] ${
              allOk(checks)
                ? 'border-[var(--accent-ok)] text-[var(--accent-ok)] hover:bg-[var(--accent-ok)] hover:text-[var(--bg)]'
                : 'border-[var(--accent-run)] text-[var(--accent-run)] hover:bg-[var(--accent-run)] hover:text-[var(--bg)]'
            }`}
          >
            {t('onboarding.start')}
          </button>
        </div>
      </div>
    </div>
  );
}
