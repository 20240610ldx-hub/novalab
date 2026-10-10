import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from '../../bridge/client';
import { useNotebook } from '../../store/notebook';
import { useSession } from '../../store/session';
import { useI18n } from '../../i18n';
import { checksReducer, initialChecks, probeFileName, type ChecksState } from './envChecks';

/**
 * Welcome「Environment」栏的四项自检（原 P4.4 首启模态的执行器，v0.1.1 常驻化）。
 *   1. bridge 连接 —— 轮询 store.bridgeConnected；
 *   2. 内核 ping   —— rpc `ping`；
 *   3. 分析依赖    —— 已打开 notebook 时 rpc `kernel.repl` 跑 `import pandas, matplotlib`；
 *                     未打开 → skip（"打开 notebook 后检查"），不再误报 ❌；
 *   4. 工作区可写  —— 有 workspace root 时写探针再删；无 root → skip。
 * notebook / root / 连接变化时自动重跑；rerun() 手动重跑。
 */

const BRIDGE_WAIT_MS = 6000;
const BRIDGE_POLL_MS = 250;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

export function useEnvChecks(): { checks: ChecksState; rerun: () => void } {
  const { t } = useI18n();
  const notebookPath = useNotebook((s) => s.notebookPath);
  const connected = useNotebook((s) => s.bridgeConnected);
  const root = useSession((s) => s.root);
  const [checks, setChecks] = useState<ChecksState>(initialChecks);
  const [nonce, setNonce] = useState(0);
  const cancelRef = useRef(false);

  const apply = useCallback((ev: Parameters<typeof checksReducer>[1]) => {
    if (!cancelRef.current) setChecks((s) => checksReducer(s, ev));
  }, []);

  useEffect(() => {
    cancelRef.current = false;
    setChecks(initialChecks());
    void (async () => {
      apply({ type: 'start', id: 'bridge' });
      const deadline = Date.now() + BRIDGE_WAIT_MS;
      let ok = useNotebook.getState().bridgeConnected;
      while (!ok && Date.now() < deadline && !cancelRef.current) {
        await sleep(BRIDGE_POLL_MS);
        ok = useNotebook.getState().bridgeConnected;
      }
      if (cancelRef.current) return;
      if (!ok) {
        apply({ type: 'fail', id: 'bridge', error: t('welcome.bridgeMissing') });
        for (const id of ['kernel', 'deps', 'writable'] as const) {
          apply({ type: 'skip', id, error: t('onboarding.skipped') });
        }
        return;
      }
      apply({ type: 'ok', id: 'bridge' });

      apply({ type: 'start', id: 'kernel' });
      try {
        await bridge.rpc('ping');
        apply({ type: 'ok', id: 'kernel' });
      } catch (err) {
        apply({ type: 'fail', id: 'kernel', error: errText(err) });
      }

      if (!notebookPath) {
        apply({ type: 'skip', id: 'deps', error: t('welcome.needsNotebook') });
      } else {
        apply({ type: 'start', id: 'deps' });
        try {
          const res = asRecord(await bridge.rpc('kernel.repl', { code: 'import pandas, matplotlib' }));
          if (res.ok === false) {
            const tb = typeof res.traceback === 'string' ? res.traceback : '';
            apply({ type: 'fail', id: 'deps', error: tb.split('\n').filter(Boolean).pop() || 'import failed' });
          } else {
            apply({ type: 'ok', id: 'deps' });
          }
        } catch (err) {
          apply({ type: 'fail', id: 'deps', error: errText(err) });
        }
      }

      if (!root) {
        apply({ type: 'skip', id: 'writable', error: t('welcome.needsWorkspace') });
        return;
      }
      apply({ type: 'start', id: 'writable' });
      const probe = probeFileName();
      try {
        await bridge.rpc('fs.writeFile', { path: probe, content: 'probe' });
        try {
          await bridge.rpc('fs.remove', { path: probe });
        } catch {
          /* 写入已成功即视为可写；残留探针无害 */
        }
        apply({ type: 'ok', id: 'writable' });
      } catch (err) {
        apply({ type: 'fail', id: 'writable', error: errText(err) });
      }
    })();
    return () => {
      cancelRef.current = true;
    };
  }, [apply, t, notebookPath, root, connected, nonce]);

  const rerun = useCallback(() => setNonce((n) => n + 1), []);
  return { checks, rerun };
}
