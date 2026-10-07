import { useState, type KeyboardEvent } from 'react';
import { useNotebook } from '../store/notebook';
import { useSession } from '../store/session';
import { useI18n } from '../i18n';

/**
 * 底部内联 REPL（截图元素 7）：`>>> run code in this kernel…`
 * Enter → kernel.repl；输出以匿名 cell（[repl] 徽章）插入列表尾（store.runRepl）。
 * 直达内核，不参与 DAG、不标 stale。
 * P2.8：历史会话只读模式 → 输入禁用（该内核命名空间已不存在）。
 * P4.3：placeholder 经 i18n（en 字典保持截图原文）。
 */
export function InlineREPL() {
  const [code, setCode] = useState('');
  const runRepl = useNotebook((s) => s.runRepl);
  const kernelState = useNotebook((s) => s.kernelState);
  const readOnly = useSession((s) => s.readOnly);
  const { t } = useI18n();
  const disabled = readOnly || kernelState === 'dead' || kernelState === 'connecting';

  const submit = () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    void runRepl(trimmed);
    setCode('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex items-center gap-2 border-t border-[var(--border)] px-3 py-2">
      <span className="text-[var(--accent-run)] select-none">&gt;&gt;&gt;</span>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        placeholder={readOnly ? t('repl.readOnlyPlaceholder') : t('repl.placeholder')}
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text)] placeholder-[var(--muted)] outline-none disabled:cursor-not-allowed disabled:opacity-50"
      />
    </div>
  );
}
