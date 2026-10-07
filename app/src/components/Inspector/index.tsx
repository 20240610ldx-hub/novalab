import { Fragment, useSyncExternalStore, useState } from 'react';
import { useNotebook } from '../../store/notebook';
import { useSession } from '../../store/session';
import { inspectorController } from './dragStore';
import {
  filterSchemas,
  previewFull,
  previewOneLine,
  shapeOrLen,
  sortSchemas,
  type SortDir,
  type SortKey,
} from './helpers';

/**
 * 变量 inspector 抽屉（P3.2，S3 元素）：从 KernelStatusBar 的 ⠿ 把手拖出，
 * 高度 120–480px（拖拽逻辑/双击折叠/localStorage 持久化都在 dragStore 控制器，
 * StatusBar 只转发 pointerdown）。挂载在 App.tsx footer 上方。
 *
 * 数据源 store.schemas：kernel.schemas 广播实时刷新（M 线 L-3），只读历史会话
 * 下同样可读（快照含 schemas 则显示，否则空态文案）。
 *
 * 表格列 name / type / shape-or-len / preview（单行截断）；行点击展开第二行
 * 显示完整 preview（head(1) json 或 repr，pre 块横向滚动）；顶部搜索过滤 +
 * name/size 排序（再次点击同列反转方向）。
 */
export function Inspector() {
  const view = useSyncExternalStore(inspectorController.subscribe, inspectorController.getSnapshot);
  const schemas = useNotebook((s) => s.schemas);
  const readOnly = useSession((s) => s.readOnly);

  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  if (!view.open) return null;

  const rows = sortSchemas(filterSchemas(schemas, query), sortKey, sortDir);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const toggleRow = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '');

  return (
    <section
      data-testid="inspector"
      className="flex shrink-0 flex-col border-t border-[var(--border)] bg-[var(--panel)] text-[12px] text-[var(--text)]"
      style={{ height: view.height }}
    >
      {/* 工具行：标题 + 搜索过滤 + 排序钮 + 折叠钮 */}
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-1">
        <span className="text-[var(--muted)]">variables · {rows.length}</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter by name/type…"
          spellCheck={false}
          aria-label="filter variables"
          className="w-44 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-0.5 text-[12px] placeholder-[var(--muted)] outline-none focus:border-[var(--accent-run)]"
        />
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => toggleSort('name')}
            className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[11px] hover:border-[var(--accent-run)]"
          >
            name{sortArrow('name')}
          </button>
          <button
            type="button"
            onClick={() => toggleSort('size')}
            className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[11px] hover:border-[var(--accent-run)]"
          >
            size{sortArrow('size')}
          </button>
          <button
            type="button"
            onClick={() => inspectorController.setOpen(false)}
            title="collapse (or double-click the ⠿ handle)"
            className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[11px] hover:border-[var(--accent-run)]"
          >
            ▾
          </button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <div className="px-3 py-2 text-[var(--muted)]">
            {schemas.length === 0
              ? readOnly
                ? '历史会话快照不含变量 schema（内核已随会话结束）——无可展示的变量。'
                : '暂无变量——运行 cell 后内核自动嗅探 schema（kernel.schemas 实时刷新）。'
              : `无匹配 “${query}” 的变量。`}
          </div>
        ) : (
          <table className="w-full border-collapse font-[var(--font-mono)]">
            <thead className="sticky top-0 bg-[var(--panel)] text-[var(--muted)]">
              <tr>
                <th className="px-3 py-1 text-left font-normal">name</th>
                <th className="px-2 py-1 text-left font-normal">type</th>
                <th className="px-2 py-1 text-left font-normal">shape/len</th>
                <th className="px-2 py-1 text-left font-normal">preview</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <Fragment key={s.name}>
                  <tr
                    data-testid={`inspector-row-${s.name}`}
                    onClick={() => toggleRow(s.name)}
                    className="cursor-pointer border-t border-[var(--border)] hover:bg-[var(--sel-bg)]"
                    title="click to expand full preview"
                  >
                    <td className="whitespace-nowrap px-3 py-0.5">{s.name}</td>
                    <td className="whitespace-nowrap px-2 py-0.5 text-[var(--muted)]">{s.type}</td>
                    <td className="whitespace-nowrap px-2 py-0.5">{shapeOrLen(s)}</td>
                    <td className="max-w-0 truncate px-2 py-0.5 text-[var(--muted)]">
                      {previewOneLine(s)}
                    </td>
                  </tr>
                  {expanded.has(s.name) && (
                    <tr className="border-t border-[var(--border)]">
                      <td colSpan={4} className="px-3 py-1">
                        <pre className="max-h-40 overflow-x-auto whitespace-pre text-[11px] text-[var(--text)]">
                          {previewFull(s)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
