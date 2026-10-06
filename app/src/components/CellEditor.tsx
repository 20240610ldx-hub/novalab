import { useEffect, useRef } from 'react';
import { EditorState, RangeSetBuilder, Transaction } from '@codemirror/state';
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
      color: 'var(--muted)',
      border: 'none',
      borderRight: '1px solid var(--border)',
      paddingRight: '4px',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.025)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'var(--sel-bg)',
    },
    '&.cm-focused': { outline: 'none' },
  },
  { dark: true },
);

/* ------------------------------------------------------------------ */

interface CellEditorProps {
  /** 受控值 = store 的 cell.code。 */
  value: string;
  /** 用户每次编辑同步回 store（cell.save 的 debounce 在调用方 Cell 层做）。 */
  onChange: (code: string) => void;
}

/**
 * CM6 单元格编辑器：python()、行号、暗色主题、高度随内容自适应、块内横滚。
 * 只在 CellList 视口窗口内挂载（窗口化策略见 CellList.tsx）。
 */
export function CellEditor({ value, onChange }: CellEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

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
        darkTheme,
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

  return <div ref={hostRef} className="min-w-0 text-[var(--text)]" />;
}
