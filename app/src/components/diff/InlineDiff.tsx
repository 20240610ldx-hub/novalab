import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { MergeView } from '@codemirror/merge';
import {
  chunkRevertChange,
  pendingDiffs,
  useNotebook,
  type ChunkPos,
} from '../../store/notebook';
import type { StagedDiff } from '../../kernel/types';

/* ------------------------------------------------------------------ */
/* P2.3 行内 Diff 审阅（spec §9）                                       */
/*                                                                     */
/* 挂载点：CellList 的 CellView（编辑器块之后）→ <DiffOverlay cellId>。  */
/* update        → @codemirror/merge MergeView（a=原码只读，b=新码可编辑）*/
/* insert_below  → 插入预览块（可编辑 textarea）                         */
/* 两级粒度：hunk 级 ✓/×（✓=确认保留；×=把该 hunk 回退为原码文本）＋     */
/*           整格 Accept/Reject（→ bridge diff.accept / diff.reject）。  */
/* b 侧任何编辑（手改或 hunk ×）→ debounce 后 store.reStageDiff          */
/* （重新 diff.stage，本地标记 origin='user' / state='edited-staged'）。 */
/* 语法着色说明：与 CellEditor 同理，@lezer/highlight 非直接依赖，       */
/* MergeView 两侧只挂 python() 解析 + 暗色底/等宽字体，diff 色由          */
/* --diff-add/--diff-del tokens 承担（styles.css，spec §10）。           */
/* ------------------------------------------------------------------ */

/** b 侧编辑 → 重新 diff.stage 的 debounce（ms）。 */
const EDIT_DEBOUNCE_MS = 500;

const sideTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', fontSize: '12px' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
    '.cm-content': { caretColor: 'var(--text)', padding: '4px 0' },
    '.cm-line': { padding: '0 6px' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--muted)',
      border: 'none',
      borderRight: '1px solid var(--border)',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.025)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'var(--sel-bg)',
    },
    '&.cm-focused': { outline: 'none' },
  },
  { dark: true },
);

/* merge 基色覆盖：贴合 styles.css tokens（.novalab-diff 作用域，两 class 优先级
   高于 @codemirror/merge 的 Prec.low baseTheme）。a 侧=删除红底，b 侧=新增绿底。 */
const MERGE_CSS = `
.novalab-diff .cm-merge-a .cm-changedLine { background-color: var(--diff-del); }
.novalab-diff .cm-merge-b .cm-changedLine { background-color: var(--diff-add); }
.novalab-diff .cm-inserted { background-color: var(--diff-add); }
.novalab-diff .cm-deleted { background-color: var(--diff-del); text-decoration: line-through; }
.novalab-diff .cm-mergeSpacer { background-color: rgba(255,255,255,0.02); }
.novalab-diff .cm-gutters { background-color: transparent; }
.novalab-diff .cm-panels { background-color: transparent; color: var(--muted); }
`;

interface ChunkInfo extends ChunkPos {
  key: string;
  index: number;
}

function readChunks(mv: MergeView): ChunkInfo[] {
  return mv.chunks.map((ch, i) => ({
    // a 侧（原码）在审阅期间静态，fromA:toA 可作为 hunk 的稳定标识
    key: `${ch.fromA}:${ch.toA}`,
    index: i,
    fromA: ch.fromA,
    toA: ch.toA,
    fromB: ch.fromB,
    toB: ch.toB,
  }));
}

function AcceptButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Accept（diff.accept → save + run）"
      className="rounded border border-[var(--accent-ok)] px-1.5 py-0.5 text-[11px] text-[var(--accent-ok)] hover:bg-[var(--diff-add)]"
    >
      ✓ Accept
    </button>
  );
}

function RejectButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Reject（diff.reject，留痕 session.jsonl）"
      className="rounded border border-[var(--accent-err)] px-1.5 py-0.5 text-[11px] text-[var(--accent-err)] hover:bg-[var(--diff-del)]"
    >
      × Reject
    </button>
  );
}

function StateBadges({ diff }: { diff: StagedDiff }) {
  return (
    <>
      <span className="rounded border border-[var(--border)] bg-[var(--panel)] px-1.5 py-0.5 text-[var(--accent-run)]">
        {diff.action === 'update' ? 'update' : 'insert below'}
      </span>
      {/* spec §9：edited-staged 重新进入 proposed，标注 user-edited */}
      {(diff.state === 'edited-staged' || diff.origin === 'user') && (
        <span className="rounded border border-[var(--accent-ok)] px-1.5 py-0.5 text-[var(--accent-ok)]">
          user-edited
        </span>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* update：MergeView 行内审阅                                           */
/* ------------------------------------------------------------------ */

function UpdateDiff({ diff, original }: { diff: StagedDiff; original: string }) {
  const acceptDiff = useNotebook((s) => s.acceptDiff);
  const rejectDiff = useNotebook((s) => s.rejectDiff);
  const reStageDiff = useNotebook((s) => s.reStageDiff);

  const hostRef = useRef<HTMLDivElement>(null);
  const mvRef = useRef<MergeView | null>(null);
  // a 侧快照：审阅期间 cell.code 被外部改动（如另一 diff 被采纳）不重建 MergeView，
  // 避免用户正在审阅的对照基准跳变；组件 key = cellId:action，re-stage 换 id 也不重挂。
  const originalRef = useRef(original);
  // b 侧与队列同步过的内容：本地编辑 flush（re-stage）后即为最新 staged newCode
  const stagedRef = useRef(diff.newCode);
  const diffIdRef = useRef(diff.id);
  diffIdRef.current = diff.id; // re-stage 后 diff prop 携带新 id，跟随之
  const editTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [chunks, setChunks] = useState<ChunkInfo[]>([]);
  const [acked, setAcked] = useState<ReadonlySet<string>>(new Set());
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let destroyed = false;
    const syncChunks = () => {
      if (!destroyed && mvRef.current) setChunks(readChunks(mvRef.current));
    };
    const flushEdit = () => {
      const mv = mvRef.current;
      if (!mv || destroyed) return;
      const code = mv.b.state.doc.toString();
      if (code !== stagedRef.current) {
        stagedRef.current = code;
        // 编辑 → 重新 diff.stage（origin 'user'，state 'edited-staged' 本地标记）
        void reStageDiff(diffIdRef.current, code);
      }
      setDirty(false);
    };
    const scheduleEdit = () => {
      if (editTimer.current) clearTimeout(editTimer.current);
      setDirty(true);
      editTimer.current = setTimeout(() => {
        editTimer.current = null;
        flushEdit();
      }, EDIT_DEBOUNCE_MS);
    };

    const mv = new MergeView({
      parent: host,
      a: {
        doc: originalRef.current,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          sideTheme,
          python(),
        ],
      },
      b: {
        doc: stagedRef.current,
        extensions: [
          sideTheme,
          python(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            syncChunks();
            // MergeView 的 chunk 重算跟随 measure 周期，延一拍再同步一次
            setTimeout(syncChunks, 60);
            const remote = u.transactions.some((tr) => tr.annotation(Transaction.remote));
            if (!remote) scheduleEdit();
          }),
        ],
      },
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 2, minSize: 8 },
    });
    mvRef.current = mv;
    syncChunks();
    setTimeout(syncChunks, 60);

    return () => {
      destroyed = true;
      if (editTimer.current) clearTimeout(editTimer.current);
      mv.destroy();
      mvRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 队列侧 newCode 变化（bridge 收敛通知 / 其他入口改写）→ 同步 b 文档（remote 注解）
  useEffect(() => {
    const mv = mvRef.current;
    if (!mv || diff.newCode === stagedRef.current) return;
    const cur = mv.b.state.doc.toString();
    stagedRef.current = diff.newCode;
    if (diff.newCode !== cur) {
      mv.b.dispatch({
        changes: { from: 0, to: cur.length, insert: diff.newCode },
        annotations: Transaction.remote.of(true),
      });
    }
  }, [diff.newCode]);

  useEffect(() => {
    const t = editTimer.current;
    return () => {
      if (t) clearTimeout(t);
    };
  }, []);

  /** hunk 级 ×：把 b 中该 chunk 区间替换回 a（原码）文本；走编辑通道 → re-stage。 */
  const revertChunk = (ch: ChunkInfo) => {
    const mv = mvRef.current;
    if (!mv) return;
    mv.b.dispatch({ changes: chunkRevertChange(originalRef.current, ch) });
    setAcked((prev) => {
      const next = new Set(prev);
      next.delete(ch.key);
      return next;
    });
  };

  /** hunk 级 ✓：确认保留该 hunk（b 已含该变更，✓ 为视觉确认，标绿框）。 */
  const ackChunk = (ch: ChunkInfo) => {
    setAcked((prev) => new Set(prev).add(ch.key));
  };

  const onAccept = () => {
    void (async () => {
      const mv = mvRef.current;
      if (mv) {
        const code = mv.b.state.doc.toString();
        if (code !== stagedRef.current) {
          // 有未 flush 的编辑：先 re-stage 再采纳新 diff——所见即所采纳。
          // bridge 在 diff.stage 响应前先广播 diff.updated（同 socket 有序），
          // await 返回后 store 已收敛出新 id。
          if (editTimer.current) clearTimeout(editTimer.current);
          stagedRef.current = code;
          await reStageDiff(diffIdRef.current, code);
          const latest = pendingDiffs(useNotebook.getState().diffs).find(
            (d) => d.targetCellId === diff.targetCellId && d.action === 'update',
          );
          if (latest) {
            await acceptDiff(latest.id);
            return;
          }
        }
      }
      await acceptDiff(diffIdRef.current);
    })();
  };

  const onReject = () => {
    if (editTimer.current) clearTimeout(editTimer.current); // 丢弃未 flush 的编辑
    setDirty(false);
    void rejectDiff(diffIdRef.current);
  };

  return (
    <div className="novalab-diff border-t border-[var(--border)]">
      <style>{MERGE_CSS}</style>

      {/* 工具栏：徽章 + rationale + 整格 Accept/Reject */}
      <div className="flex items-center gap-2 px-2 py-1 text-[11px]">
        <StateBadges diff={diff} />
        {diff.rationale && (
          <span className="min-w-0 truncate text-[var(--muted)]" title={diff.rationale}>
            {diff.rationale}
          </span>
        )}
        {dirty && <span className="text-[var(--accent-run)]">re-staging…</span>}
        <span className="ml-auto flex shrink-0 gap-1">
          <AcceptButton onClick={onAccept} />
          <RejectButton onClick={onReject} />
        </span>
      </div>

      {/* MergeView：左 a=原码（只读，删除红底），右 b=新码（可编辑，新增绿底） */}
      <div ref={hostRef} className="max-h-72 overflow-auto border-t border-[var(--border)]" />

      {/* hunk 级 ✓/× 两级粒度控制条 */}
      {chunks.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 border-t border-[var(--border)] px-2 py-1">
          <span className="text-[10px] text-[var(--muted)]">hunks:</span>
          {chunks.map((ch) => (
            <span
              key={ch.key}
              className={`flex items-center gap-1 rounded border px-1 py-0.5 ${
                acked.has(ch.key) ? 'border-[var(--accent-ok)]' : 'border-[var(--border)]'
              }`}
            >
              <span className="text-[10px] text-[var(--muted)]">Δ{ch.index + 1}</span>
              <button
                type="button"
                title="保留该 hunk"
                onClick={() => ackChunk(ch)}
                className="text-[12px] leading-none text-[var(--accent-ok)] hover:opacity-80"
              >
                ✓
              </button>
              <button
                type="button"
                title="回退该 hunk 为原码（触发重新 stage）"
                onClick={() => revertChunk(ch)}
                className="text-[12px] leading-none text-[var(--accent-err)] hover:opacity-80"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* insert_below：插入预览块                                             */
/* ------------------------------------------------------------------ */

function InsertPreview({ diff }: { diff: StagedDiff }) {
  const acceptDiff = useNotebook((s) => s.acceptDiff);
  const rejectDiff = useNotebook((s) => s.rejectDiff);
  const reStageDiff = useNotebook((s) => s.reStageDiff);

  const [draft, setDraft] = useState(diff.newCode);
  const stagedRef = useRef(diff.newCode);
  const diffIdRef = useRef(diff.id);
  diffIdRef.current = diff.id;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 队列侧收敛（re-stage 回执等）→ 同步草稿
  useEffect(() => {
    setDraft(diff.newCode);
    stagedRef.current = diff.newCode;
  }, [diff.newCode]);
  useEffect(() => {
    const t = timer.current;
    return () => {
      if (t) clearTimeout(t);
    };
  }, []);

  const onChange = (v: string) => {
    setDraft(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (v !== stagedRef.current) {
        stagedRef.current = v;
        void reStageDiff(diffIdRef.current, v); // 预览块内编辑同样走 re-stage 通道
      }
    }, EDIT_DEBOUNCE_MS);
  };

  const rows = Math.max(2, draft.split('\n').length);
  return (
    <div className="border-t border-[var(--border)]">
      <div className="flex items-center gap-2 px-2 py-1 text-[11px]">
        <StateBadges diff={diff} />
        {diff.rationale && (
          <span className="min-w-0 truncate text-[var(--muted)]" title={diff.rationale}>
            {diff.rationale}
          </span>
        )}
        <span className="ml-auto flex shrink-0 gap-1">
          <AcceptButton onClick={() => void acceptDiff(diffIdRef.current)} />
          <RejectButton onClick={() => void rejectDiff(diffIdRef.current)} />
        </span>
      </div>
      {/* 插入预览：整块 --diff-add 绿底（新增语义），等宽可编辑 */}
      <textarea
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        spellCheck={false}
        aria-label="insert below preview"
        className="block w-full resize-y border-t border-[var(--border)] bg-[var(--diff-add)] px-3 py-1.5 font-[var(--font-mono)] text-[12px] leading-[1.6] text-[var(--text)] outline-none"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* DiffOverlay：CellList 挂载点消费的入口                                */
/* ------------------------------------------------------------------ */

/**
 * 目标 cell 的 pending diff 行内审阅 UI（无 pending → null）。
 * 同一 (cell, action) 若短暂并存多条（re-stage 替换窗口期），只渲染队列中
 * 最新一条；key = cellId:action 保证换 diffId 不重挂编辑器（光标/滚动不丢）。
 */
export function DiffOverlay({ cellId }: { cellId: string }) {
  const diffs = useNotebook((s) => s.diffs);
  const original = useNotebook((s) => s.cells.find((c) => c.id === cellId)?.code ?? '');

  const pending = useMemo(() => {
    const latest = new Map<StagedDiff['action'], StagedDiff>();
    for (const d of pendingDiffs(diffs)) {
      if (d.targetCellId === cellId) latest.set(d.action, d);
    }
    return [...latest.values()];
  }, [diffs, cellId]);

  if (pending.length === 0) return null;
  return (
    <>
      {pending.map((d) =>
        d.action === 'update' ? (
          <UpdateDiff key={`${cellId}:update`} diff={d} original={original} />
        ) : (
          <InsertPreview key={`${cellId}:insert_below`} diff={d} />
        ),
      )}
    </>
  );
}
