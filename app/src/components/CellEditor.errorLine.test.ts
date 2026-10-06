/**
 * P2.9：CellEditor 出错行红底装饰的无头单测（EditorState + StateEffect，
 * 不挂 DOM——@codemirror/state 的纯状态机部分可在 node 环境驱动）。
 *
 * 覆盖：errorLine 效果设置/清除、越界行号、docChanged（代码已编辑）即清除
 * （装饰不追踪行号漂移，等下一次运行的 traceback 重新定位）。
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { errorLineField, setErrorLine } from './CellEditor';

function mkState(doc = 'l1\nl2\nl3'): EditorState {
  return EditorState.create({ doc, extensions: [errorLineField] });
}

function marks(st: EditorState): { from: number; to: number; cls: unknown }[] {
  const out: { from: number; to: number; cls: unknown }[] = [];
  const cur = st.field(errorLineField).iter();
  while (cur.value) {
    out.push({ from: cur.from, to: cur.to, cls: (cur.value.spec as { class?: string }).class });
    cur.next();
  }
  return out;
}

describe('errorLineField（出错行装饰）', () => {
  it('初始无装饰', () => {
    expect(marks(mkState())).toEqual([]);
  });

  it('setErrorLine(2) → 第 2 行行首一条 line 装饰（cm-error-line）', () => {
    const st = mkState().update({ effects: setErrorLine.of(2) }).state;
    const line2 = st.doc.line(2);
    expect(marks(st)).toEqual([{ from: line2.from, to: line2.from, cls: 'cm-error-line' }]);
  });

  it('重设行号：装饰跟随最新 traceback 行号', () => {
    let st = mkState().update({ effects: setErrorLine.of(3) }).state;
    st = st.update({ effects: setErrorLine.of(1) }).state;
    expect(marks(st)).toEqual([{ from: 0, to: 0, cls: 'cm-error-line' }]);
  });

  it('null / 越界 / 非整数行号 → 清除或忽略', () => {
    let st = mkState().update({ effects: setErrorLine.of(2) }).state;
    st = st.update({ effects: setErrorLine.of(null) }).state;
    expect(marks(st)).toEqual([]);

    st = mkState().update({ effects: setErrorLine.of(99) }).state;
    expect(marks(st)).toEqual([]);
    st = mkState().update({ effects: setErrorLine.of(0) }).state;
    expect(marks(st)).toEqual([]);
  });

  it('代码已编辑（docChanged）→ 装饰清除，不追踪行号漂移', () => {
    let st = mkState().update({ effects: setErrorLine.of(2) }).state;
    expect(marks(st)).toHaveLength(1);
    st = st.update({ changes: { from: 0, to: 0, insert: '# ' } }).state;
    expect(marks(st)).toEqual([]);
  });

  it('同一事务 docChanged + 新行号：以新行号为准（run.error 与代码同步同拍到达）', () => {
    let st = mkState().update({ effects: setErrorLine.of(1) }).state;
    st = st
      .update({ changes: { from: st.doc.length, to: st.doc.length, insert: '\nl4' }, effects: setErrorLine.of(4) })
      .state;
    const line4 = st.doc.line(4);
    expect(marks(st)).toEqual([{ from: line4.from, to: line4.from, cls: 'cm-error-line' }]);
  });
});
