import { useEffect, useMemo, useRef, useState } from 'react';
import { pendingDiffs, trayKeyAction, useNotebook, type TrayKeyAction } from '../../store/notebook';

/* ------------------------------------------------------------------ */
/* P2.3 Diff 托盘（spec §9 多 diff 队列）                                */
/*                                                                     */
/* 顶栏右侧 `N pending` 徽章 + 展开队列。                                */
/* 快捷键（焦点在托盘时，或全局无任何输入焦点时）：                        */
/*   Tab    = 采纳队首        Esc = 拒绝队首      Esc Esc(300ms) = 全拒  */
/*                                                                     */
/* 键盘劫持边界（重要）：                                                */
/* - 托盘容器 tabIndex=0，聚焦时走 React onKeyDown（preventDefault，     */
/*   Tab 不再移焦、Esc 不再冒泡）。                                      */
/* - 全局兜底监听只在 document.activeElement === body（无输入焦点）时     */
/*   生效；焦点在 CM6（.cm-content/.cm-editor）、input/textarea/select、  */
/*   contentEditable 或托盘内部时一律不拦截——绝不劫持 CM6 内部按键        */
/*   （Tab 缩进、Esc 退出光标等属于编辑器语义）。                          */
/*                                                                     */
/* 挂载说明：App.tsx 不在 P2.3 文件所有权内，托盘由 KernelStatusBar      */
/* 挂载；徽章用 fixed 定位钉在视口顶栏右侧（LivePill 左边），挂载位置      */
/* 不影响视觉位置。                                                      */
/* ------------------------------------------------------------------ */

/** 判断元素是否是"输入语境"（这些地方的 Tab/Esc 属于编辑器/表单，不劫持）。 */
function isInputContext(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.closest('.cm-editor')) return true; // CodeMirror 6 内部按键
  if (el.closest('input, textarea, select, [contenteditable="true"]')) return true;
  return false;
}

export function DiffTray() {
  const diffs = useNotebook((s) => s.diffs);
  const acceptDiff = useNotebook((s) => s.acceptDiff);
  const rejectDiff = useNotebook((s) => s.rejectDiff);
  const rejectAllPending = useNotebook((s) => s.rejectAllPending);

  const pending = useMemo(() => pendingDiffs(diffs), [diffs]);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastEscAt = useRef<number | null>(null);

  const runAction = (action: TrayKeyAction) => {
    // 以 store 当前队列为准（快捷键连发时 pending prop 可能滞后一帧）
    const head = pendingDiffs(useNotebook.getState().diffs)[0];
    switch (action) {
      case 'accept-head':
        if (head) void acceptDiff(head.id);
        break;
      case 'reject-head':
        if (head) void rejectDiff(head.id);
        break;
      case 'reject-all':
        void rejectAllPending();
        break;
      case null:
        break;
    }
  };

  /** 把按键喂给纯逻辑 trayKeyAction，执行动作并返回是否消费。 */
  const handleKey = (key: string): boolean => {
    const { action, nextEscAt } = trayKeyAction(key, {
      now: Date.now(),
      lastEscAt: lastEscAt.current,
    });
    lastEscAt.current = nextEscAt;
    if (!action) return false;
    runAction(action);
    return true;
  };

  // 全局兜底：仅"无任何输入焦点"（activeElement=body）时生效，见文件头注释
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' && e.key !== 'Escape') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement;
      if (el !== document.body || isInputContext(el)) return; // 焦点在编辑器/表单/托盘 → 不拦截
      if (pendingDiffs(useNotebook.getState().diffs).length === 0) return;
      if (handleKey(e.key)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (pending.length === 0 && !open) return null;

  return (
    <div
      data-diff-tray
      ref={rootRef}
      tabIndex={0}
      onKeyDown={(e) => {
        // 托盘聚焦：Tab/Esc 由托盘接管（阻止 Tab 移焦 / Esc 冒泡）
        if (e.key !== 'Tab' && e.key !== 'Escape') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (handleKey(e.key)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      className="fixed top-[9px] right-[150px] z-40 outline-none"
      title="diff 审阅托盘（聚焦后：Tab=采纳队首 · Esc=拒绝队首 · Esc Esc=全拒）"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] ${
          pending.length > 0
            ? 'border-[var(--accent-run)] text-[var(--accent-run)]'
            : 'border-[var(--border)] text-[var(--muted)]'
        } ${focused ? 'ring-1 ring-[var(--accent-run)]' : ''} bg-[var(--panel)]`}
      >
        <span aria-hidden>⇄</span>
        {pending.length} pending
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1 max-h-80 w-80 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--panel)] p-2 text-[12px]">
          {pending.length === 0 ? (
            <p className="text-[var(--muted)]">无待审 diff。</p>
          ) : (
            pending.map((d, i) => (
              <div key={d.id} className="mb-1.5 rounded border border-[var(--border)] p-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="rounded border border-[var(--border)] px-1 text-[10px] text-[var(--accent-run)]">
                    {d.action === 'update' ? 'update' : 'insert below'}
                  </span>
                  {d.state === 'edited-staged' && (
                    <span className="rounded border border-[var(--accent-ok)] px-1 text-[10px] text-[var(--accent-ok)]">
                      user-edited
                    </span>
                  )}
                  <span className="truncate text-[var(--muted)]">cell {d.targetCellId}</span>
                  {i === 0 && (
                    <span className="ml-auto shrink-0 text-[10px] text-[var(--accent-run)]">
                      队首 · Tab/Esc
                    </span>
                  )}
                </div>
                {d.rationale && (
                  <p className="mt-1 line-clamp-2 text-[var(--muted)]" title={d.rationale}>
                    {d.rationale}
                  </p>
                )}
                <div className="mt-1 flex gap-1">
                  <button
                    type="button"
                    onClick={() => void acceptDiff(d.id)}
                    className="rounded border border-[var(--accent-ok)] px-1.5 text-[11px] text-[var(--accent-ok)] hover:bg-[var(--diff-add)]"
                  >
                    ✓ Accept
                  </button>
                  <button
                    type="button"
                    onClick={() => void rejectDiff(d.id)}
                    className="rounded border border-[var(--accent-err)] px-1.5 text-[11px] text-[var(--accent-err)] hover:bg-[var(--diff-del)]"
                  >
                    × Reject
                  </button>
                </div>
              </div>
            ))
          )}
          <p className="border-t border-[var(--border)] pt-1 text-[10px] text-[var(--muted)]">
            聚焦托盘（或无输入焦点）：Tab=采纳队首 · Esc=拒绝队首 · Esc Esc=全拒
          </p>
        </div>
      )}
    </div>
  );
}
