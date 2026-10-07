import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Check, Copy } from 'lucide-react';
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField, Transaction } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  lineNumbers,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { useSession } from '../store/session';

/* ------------------------------------------------------------------ */
/* 轻量 Python 着色 overlay                                            */
/*                                                                     */
/* 说明：pnpm 严格解析下 @lezer/highlight 不是 app 的直接依赖，无法用   */
/* HighlightStyle.define(tags…) 给 lezer 解析树上色；P1 先用逐行正则    */
/* 扫描 + Decoration.mark 实现暗色主题着色（跨行三引号字符串带状态机）。 */
/* 若后续把 @lezer/highlight 提为直接依赖，可整体替换为 TagSystem 方案。 */
/* ------------------------------------------------------------------ */

const KEYWORDS = new Set(
  'and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield'.split(
    ' ',
  ),
);
const BUILTINS = new Set(
  'abs all any bool bytes callable dict dir divmod enumerate eval exec filter float format frozenset getattr hasattr hash input int isinstance issubclass iter len list map max min next object open ord pow print range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip'.split(
    ' ',
  ),
);

const STR_PREFIX = /^[rRfFbBuU]{1,2}(?=["'])/;
const WORD = /^[A-Za-z_]\w*/;
const NUM = /^\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/;

interface Mark {
  from: number;
  to: number;
  cls: string;
}

/** 全文档逐行扫描（cell 文档很小），返回按位置排序的着色区间。 */
function scanDoc(doc: EditorState['doc']): Mark[] {
  const marks: Mark[] = [];
  let triple: '"' | "'" | null = null; // 跨行三引号状态

  for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
    const line = doc.line(lineNo);
    const text = line.text;
    const base = line.from;
    let i = 0;

    // 处于未闭合三引号中：整行是字符串，直到遇到闭合定界符
    if (triple) {
      const close = text.indexOf(triple.repeat(3));
      if (close === -1) {
        marks.push({ from: base, to: base + text.length, cls: 'nl-str' });
        continue;
      }
      marks.push({ from: base, to: base + close + 3, cls: 'nl-str' });
      triple = null;
      i = close + 3;
    }

    while (i < text.length) {
      const rest = text.slice(i);
      const ch = text[i]!;

      if (ch === '#') {
        marks.push({ from: base + i, to: base + text.length, cls: 'nl-com' });
        break;
      }

      // 字符串前缀 r/f/b/u 紧邻引号时并入字符串 token
      const prefix = STR_PREFIX.exec(rest);
      const qStart = prefix ? prefix[0].length : 0;
      const q = text[i + qStart];
      if (q === '"' || q === "'") {
        if (text.startsWith(q.repeat(3), i + qStart)) {
          const delim = q.repeat(3);
          const close = text.indexOf(delim, i + qStart + 3);
          if (close === -1) {
            marks.push({ from: base + i, to: base + text.length, cls: 'nl-str' });
            triple = q;
            break;
          }
          marks.push({ from: base + i, to: base + close + 3, cls: 'nl-str' });
          i = close + 3;
          continue;
        }
        let j = i + qStart + 1;
        while (j < text.length && text[j] !== q) {
          if (text[j] === '\\') j++;
          j++;
        }
        const end = Math.min(j + 1, text.length);
        marks.push({ from: base + i, to: base + end, cls: 'nl-str' });
        i = end;
        continue;
      }

      const word = WORD.exec(rest);
      if (word) {
        const w = word[0];
        let cls = '';
        const defBefore = /(def|class)\s+$/.exec(text.slice(Math.max(0, i - 12), i));
        const callAfter = /^\s*\(/.test(text.slice(i + w.length));
        if (defBefore) cls = defBefore[1] === 'def' ? 'nl-fn' : 'nl-cls';
        else if (KEYWORDS.has(w)) cls = 'nl-kw';
        else if (w === 'self' || w === 'cls') cls = 'nl-kw';
        else if (callAfter) cls = 'nl-fn';
        else if (BUILTINS.has(w)) cls = 'nl-bi';
        if (cls) marks.push({ from: base + i, to: base + i + w.length, cls });
        i += w.length;
        continue;
      }

      const num = NUM.exec(rest);
      if (num) {
        marks.push({ from: base + i, to: base + i + num[0].length, cls: 'nl-num' });
        i += num[0].length;
        continue;
      }

      i++;
    }
  }
  return marks.sort((a, b) => a.from - b.from || a.to - b.to);
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const m of scanDoc(view.state.doc)) {
    builder.add(m.from, m.to, Decoration.mark({ class: m.cls }));
  }
  return builder.finish();
}

const pyHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

/* ------------------------------------------------------------------ */
/* 出错行红底装饰（P2.9，参考图：编辑器内出错行 --diff-del 底色）          */
/*                                                                     */
/* 装饰跟随「最近一次 traceback 的行号」：cell error 时由调用方传入        */
/* errorLine（CellHeader 徽章同源的 lastCellFrameLine 派生）。            */
/* 代码一旦编辑（本地键入或远端同步的 docChanged）即整体清除，**不**用      */
/* tr.mapping 追踪行号漂移——stale/running 语义下行号已不可信，等下一次     */
/* 运行产生新 traceback 再重新定位（见 spec §12 失败分支说明）。           */
/* ------------------------------------------------------------------ */

/** 设置/清除出错行（1-based；null 或越界 → 清除）。 */
export const setErrorLine = StateEffect.define<number | null>();

export const errorLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    // 代码已编辑 → 清除（不追踪行号漂移，注释见上）
    if (tr.docChanged) deco = Decoration.none;
    for (const e of tr.effects) {
      if (!e.is(setErrorLine)) continue;
      const line = e.value;
      if (line === null || !Number.isFinite(line) || line < 1 || line > tr.state.doc.lines) {
        deco = Decoration.none;
        continue;
      }
      const l = tr.state.doc.line(Math.floor(line));
      deco = Decoration.set([errorLineDecoration.range(l.from)]);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const errorLineDecoration = Decoration.line({ class: 'cm-error-line' });

/* ------------------------------------------------------------------ */
/* 只读模式（P2.8，A-2 #12）：历史会话 view-only → CM6 readOnly +        */
/* editable=false，经 Compartment 动态重配置（live ↔ 历史切换即时生效）。  */
/* ------------------------------------------------------------------ */

function readOnlyExtensions(readOnly: boolean) {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

/* ------------------------------------------------------------------ */
/* 暗色主题（贴合 styles.css tokens，spec §10）                         */
/* ------------------------------------------------------------------ */

const darkTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', fontSize: '13px' },
    // 块内横向滚动：不开 lineWrapping，长行在 scroller 内滚动
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.65',
      overflowX: 'auto',
      overflowY: 'hidden',
    },
    '.cm-content': { caretColor: 'var(--text)', padding: '6px 0' },
    '.cm-line': { padding: '0 8px' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--gutter-fg)',
      border: 'none',
      borderRight: '1px solid var(--border)',
      paddingRight: '4px',
    },
    '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
    // P2.9 出错行高亮（A-4 #4：--err-line 变量，双主题；浅 #f6d7d7 / 暗 --diff-del 系）
    '.cm-line.cm-error-line': { backgroundColor: 'var(--err-line)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'var(--sel-bg)',
    },
    '&.cm-focused': { outline: 'none' },
  },
  { dark: true },
);

/* ------------------------------------------------------------------ */
/* 复制按钮（A-3 #21，Q 线）：代码区右上角 clipboard 图标，hover 显现，      */
/* 点击 navigator.clipboard.writeText + 短暂 ✓ 反馈。CellEditor 与          */
/* SessionModal 只读 cell 卡（#24）共用本组件。                             */
/* ------------------------------------------------------------------ */

export function CopyButton({
  getText,
  label = 'copy code',
}: {
  /** 点击时取当前文本（ref 语义，避免闭包过期）。 */
  getText: () => string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onClick = (e: ReactMouseEvent) => {
    e.stopPropagation();
    const text = getText();
    const fallback = () => {
      // 非安全上下文 / clipboard API 被拒：隐藏 textarea + execCommand 兜底
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        /* 忽略 */
      }
    };
    const p = navigator.clipboard?.writeText(text);
    if (p) p.catch(fallback);
    else fallback();
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1200);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={copied ? '已复制' : '复制代码'}
      aria-label={label}
      className="flex h-6 w-6 items-center justify-center rounded border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] opacity-0 transition-opacity group-hover:opacity-100 hover:!text-[var(--text)] focus-visible:opacity-100"
    >
      {copied ? (
        <Check size={13} className="text-[var(--accent-ok)]" aria-hidden />
      ) : (
        <Copy size={13} aria-hidden />
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */

interface CellEditorProps {
  /** 受控值 = store 的 cell.code。 */
  value: string;
  /** 用户每次编辑同步回 store（cell.save 的 debounce 在调用方 Cell 层做）。 */
  onChange: (code: string) => void;
  /**
   * 出错行红底装饰（P2.9，1-based）：仅当 cell.status==='error' 时由调用方传入
   * lastCellFrameLine(cell.output.traceback.frames)；stale/running/idle 传 null
   * 清除。本组件内 docChanged（代码已编辑）也会清除装饰。
   */
  errorLine?: number | null;
}

/**
 * CM6 单元格编辑器：python()、行号、暗色主题、高度随内容自适应、块内横滚。
 * 只在 CellList 视口窗口内挂载（窗口化策略见 CellList.tsx）。
 */
export function CellEditor({ value, onChange, errorLine = null }: CellEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // #21 复制按钮取最新代码（不受创建时闭包影响）
  const valueRef = useRef(value);
  valueRef.current = value;
  // P2.8：会话只读（历史视图）→ 编辑器不可写
  const readOnly = useSession((s) => s.readOnly);
  const roComp = useMemo(() => new Compartment(), []);

  // 创建/销毁 EditorView（依赖数组为空：值同步走下面的 effect）
  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        python(),
        pyHighlight,
        errorLineField,
        darkTheme,
        roComp.of(readOnlyExtensions(useSession.getState().readOnly)),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          // 外部同步（store → editor）的 dispatch 带 remote 注解，不回流 onChange
          const remote = u.transactions.some((tr) => tr.annotation(Transaction.remote));
          if (!remote) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // P2.8：只读切换（选历史会话 / 回 live）→ 重配置 compartment
  useEffect(() => {
    viewRef.current?.dispatch({ effects: roComp.reconfigure(readOnlyExtensions(readOnly)) });
  }, [readOnly, roComp]);

  // 受控同步：store 的 cell.code 变化（如 agent diff 采纳、REPL 外部改写）→ 替换文档
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur !== value) {
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: value },
        annotations: Transaction.remote.of(true),
      });
    }
  }, [value]);

  // P2.9：errorLine prop → 装饰状态（null = 清除；docChanged 清除逻辑在 errorLineField 内）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setErrorLine.of(errorLine ?? null) });
  }, [errorLine]);

  return (
    <div className="relative min-w-0">
      <div ref={hostRef} className="min-w-0 text-[var(--text)]" />
      {/* #21：代码区右上角复制按钮（hover 显现，✓ 短暂反馈） */}
      <div className="absolute right-2 top-1.5 z-10">
        <CopyButton getText={() => valueRef.current} />
      </div>
    </div>
  );
}
