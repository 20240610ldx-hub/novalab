import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { bridge } from '../../bridge/client';
import { useNotebook } from '../../store/notebook';
import { useSession } from '../../store/session';
import {
  baseName,
  dirName,
  ensurePySuffix,
  humanSize,
  isNotebookFile,
  joinFsPath,
  loadRecent,
  notebookTemplate,
  parentRel,
  pushRecent,
  renameSelection,
  saveRecent,
  sortEntries,
  validName,
  type FsEntry,
  type RecentEntry,
} from './helpers';

/* ------------------------------------------------------------------ */
/* P2.8 工作区 sidebar（intent M8 / spec 附录 A-2）                       */
/*                                                                     */
/* 交互模式借鉴 refs/jupyterlab filebrowser（视觉 clean-room）：           */
/* - DirListing：单击选中（ctrl 切换 / shift 范围）、双击打开或进入目录、   */
/*   目录在前按名排序、行内 rename 输入框（.py 选中主名保留扩展名）；        */
/* - crumbs.ts：路径面包屑，点段导航；                                    */
/* - model.ts：cd/refresh 语义 → 懒加载目录 + ⟳ 全量刷新。                */
/* 增补（Claude Science 复刻）：左缘 icon rail 可折叠、右键/⋯ 菜单          */
/* （新建 notebook=marimo 头模板 / 新建文件夹 / 重命名 / 删除需输入文件名 /  */
/* 设为工作区=fs.setRoot）、最近打开（localStorage）。                    */
/* ------------------------------------------------------------------ */

const COLLAPSE_KEY = 'novalab.sidebar.collapsed';

type Tab = 'files' | 'recent';

interface PromptState {
  mode: 'new-notebook' | 'new-folder' | 'rename';
  /** 提交目标的父目录 rel（'' = root）；rename 时 = 目标的父目录。 */
  parentRel: string;
  /** rename 的目标 rel。 */
  targetRel?: string;
  initial: string;
}

interface MenuState {
  x: number;
  y: number;
  /** null = 目录背景（作用于所在目录）。 */
  targetRel: string | null;
  targetKind: 'dir' | 'file' | null;
  /** 背景菜单所属目录（右键发生在哪个 dir 内）。 */
  atRel: string;
}

interface DeleteTarget {
  rel: string;
  name: string;
}

function childRel(dirRel: string, name: string): string {
  return dirRel === '' ? name : `${dirRel}/${name}`;
}

/* ------------------------------------------------------------------ */
/* Sidebar 根：rail + 面板（files / recent 两个 tab）                     */
/* ------------------------------------------------------------------ */

export function Sidebar() {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [tab, setTab] = useState<Tab>('files');
  const [recents, setRecents] = useState<RecentEntry[]>(() => {
    try {
      return loadRecent(localStorage);
    } catch {
      return [];
    }
  });

  const persistCollapsed = (v: boolean) => {
    setCollapsed(v);
    try {
      localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0');
    } catch {
      /* 忽略 */
    }
  };

  /** 打开 notebook：同步 ?path=（刷新可恢复，与 App.openPath 同语义）+ store.openNotebook。 */
  const openNotebookAbs = useCallback((abs: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set('path', abs);
    window.history.replaceState(null, '', url.toString());
    // guard（store/session.ts）会先退出历史只读视图再打开
    void useNotebook.getState().openNotebook(abs);
  }, []);

  // notebookPath 变化（无论入口）→ 记录最近打开 + 同步 bridge 默认 root
  useEffect(() => {
    void useSession.getState().syncRoot();
    return useNotebook.subscribe((s, prev) => {
      if (s.notebookPath && s.notebookPath !== prev.notebookPath) {
        const entry: RecentEntry = { path: s.notebookPath, openedAt: new Date().toISOString() };
        setRecents((list) => {
          const next = pushRecent(list, entry);
          try {
            saveRecent(localStorage, next);
          } catch {
            /* 忽略 */
          }
          return next;
        });
        void useSession.getState().syncRoot();
      }
    });
  }, []);

  const removeRecent = (p: string) => {
    setRecents((list) => {
      const next = list.filter((e) => e.path !== p);
      try {
        saveRecent(localStorage, next);
      } catch {
        /* 忽略 */
      }
      return next;
    });
  };

  const clearRecents = () => {
    setRecents([]);
    try {
      localStorage.removeItem('novalab.recent');
    } catch {
      /* 忽略 */
    }
  };

  return (
    <div className="flex h-full shrink-0">
      {/* 左缘 icon rail */}
      <nav className="flex w-9 shrink-0 flex-col items-center gap-1 border-r border-[var(--border)] bg-[var(--panel)] py-2">
        <RailButton
          glyph="▤"
          title="Files — 工作区文件树"
          active={!collapsed && tab === 'files'}
          onClick={() => {
            setTab('files');
            persistCollapsed(false);
          }}
        />
        <RailButton
          glyph="◷"
          title="Recent — 最近打开"
          active={!collapsed && tab === 'recent'}
          onClick={() => {
            setTab('recent');
            persistCollapsed(false);
          }}
        />
        <span className="flex-1" />
        <RailButton
          glyph={collapsed ? '⟩' : '⟨'}
          title={collapsed ? '展开 sidebar' : '折叠 sidebar'}
          active={false}
          onClick={() => persistCollapsed(!collapsed)}
        />
      </nav>

      {!collapsed && (
        <div className="flex w-60 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--panel)]">
          {tab === 'files' ? (
            <FilesPanel onOpenNotebook={openNotebookAbs} />
          ) : (
            <RecentPanel recents={recents} onOpen={openNotebookAbs} onRemove={removeRecent} onClear={clearRecents} />
          )}
        </div>
      )}
    </div>
  );
}

function RailButton({
  glyph,
  title,
  active,
  onClick,
}: {
  glyph: string;
  title: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded text-[14px] ${
        active ? 'bg-[var(--bg)] text-[var(--accent-run)]' : 'text-[var(--muted)] hover:text-[var(--text)]'
      }`}
    >
      {glyph}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Files tab：面包屑 + 懒加载树 + 右键/⋯ 菜单 + 行内 prompt + 删除确认     */
/* ------------------------------------------------------------------ */

function FilesPanel({ onOpenNotebook }: { onOpenNotebook: (abs: string) => void }) {
  const root = useSession((s) => s.root);
  const setRootDir = useSession((s) => s.setRootDir);

  const [entries, setEntries] = useState<Record<string, FsEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const loadDir = useCallback(async (rel: string) => {
    setLoading((prev) => new Set(prev).add(rel));
    try {
      const list = await bridge.rpc<FsEntry[]>('fs.list', { dir: rel });
      setEntries((m) => ({ ...m, [rel]: sortEntries(Array.isArray(list) ? list : []) }));
    } catch (err) {
      console.error('fs.list 失败:', rel, err);
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(rel);
        return next;
      });
    }
  }, []);

  // root 变化（setRoot / notebook.open）→ 全量重置 + 载入 root
  useEffect(() => {
    setEntries({});
    setExpanded(new Set());
    setSelected(new Set());
    anchorRef.current = null;
    setMenu(null);
    setPrompt(null);
    if (root !== null) void loadDir('');
  }, [root, loadDir]);

  const toggleDir = useCallback(
    (rel: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(rel)) next.delete(rel);
        else next.add(rel);
        return next;
      });
      void loadDir(rel); // 展开即刷新（jupyterlab cd 语义：进入时拉最新）
    },
    [loadDir],
  );

  /** DFS 展平可见行（shift 范围选择与行内 prompt 定位共用）。 */
  const rows = useMemo(() => {
    const out: { rel: string; entry: FsEntry; depth: number }[] = [];
    const walk = (rel: string, depth: number) => {
      for (const e of entries[rel] ?? []) {
        const cr = childRel(rel, e.name);
        out.push({ rel: cr, entry: e, depth });
        if (e.kind === 'dir' && expanded.has(cr)) walk(cr, depth + 1);
      }
    };
    walk('', 0);
    return out;
  }, [entries, expanded]);

  /* ---- 选择语义（jupyterlab DirListing：单击选、ctrl 切换、shift 范围） ---- */

  const onRowClick = (e: ReactMouseEvent, rel: string) => {
    if (e.shiftKey && anchorRef.current) {
      const ids = rows.map((r) => r.rel);
      const a = ids.indexOf(anchorRef.current);
      const b = ids.indexOf(rel);
      if (a >= 0 && b >= 0) {
        setSelected(new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1)));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(rel)) next.delete(rel);
        else next.add(rel);
        return next;
      });
    } else {
      setSelected(new Set([rel]));
    }
    anchorRef.current = rel;
  };

  const onRowDblClick = (rel: string, entry: FsEntry) => {
    if (entry.kind === 'dir') {
      toggleDir(rel);
    } else if (root !== null && isNotebookFile(entry.name)) {
      onOpenNotebook(joinFsPath(root, rel));
    }
    // 其余文件：灰显不可开（spec：只读 notebook 语义）
  };

  /* ---- 菜单动作 ---- */

  const startPrompt = (p: PromptState) => {
    setPromptError(null);
    setPrompt(p);
    if (p.mode !== 'rename' && p.parentRel !== '' && !expanded.has(p.parentRel)) {
      setExpanded((prev) => new Set(prev).add(p.parentRel));
      void loadDir(p.parentRel);
    }
  };

  const submitPrompt = async (raw: string) => {
    const p = prompt;
    if (!p) return;
    const name = raw.trim();
    const finalName = p.mode === 'new-notebook' ? ensurePySuffix(name) : name;
    if (!finalName || !validName(finalName)) {
      setPromptError(`非法名称: ${name || '(空)'}（不能含 / \\ : 与控制字符）`);
      return;
    }
    try {
      if (p.mode === 'new-notebook') {
        await bridge.rpc('fs.writeFile', {
          path: childRel(p.parentRel, finalName),
          content: notebookTemplate(),
        });
      } else if (p.mode === 'new-folder') {
        await bridge.rpc('fs.mkdir', { dir: childRel(p.parentRel, finalName) });
      } else if (p.mode === 'rename' && p.targetRel) {
        if (finalName !== baseName(p.targetRel)) {
          await bridge.rpc('fs.rename', {
            from: p.targetRel,
            to: childRel(parentRel(p.targetRel), finalName),
          });
        }
      }
      setPrompt(null);
      setPromptError(null);
      await loadDir(p.mode === 'rename' && p.targetRel ? parentRel(p.targetRel) : p.parentRel);
    } catch (err) {
      setPromptError(err instanceof Error ? err.message : String(err));
    }
  };

  const confirmDelete = async () => {
    const t = deleteTarget;
    if (!t) return;
    try {
      await bridge.rpc('fs.remove', { path: t.rel });
      setDeleteTarget(null);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(t.rel);
        return next;
      });
      await loadDir(parentRel(t.rel));
    } catch (err) {
      console.error('fs.remove 失败:', err);
      setDeleteTarget(null);
    }
  };

  const openMenu = (e: ReactMouseEvent, targetRel: string | null, targetKind: 'dir' | 'file' | null, atRel: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (targetRel !== null && !selected.has(targetRel)) {
      setSelected(new Set([targetRel]));
      anchorRef.current = targetRel;
    }
    setMenu({ x: e.clientX, y: e.clientY, targetRel, targetKind, atRel });
  };

  const menuCtxDir = (m: MenuState): string => {
    // 目标为 dir → 其内部；目标为 file → 其父目录；背景 → 所在目录
    if (m.targetRel === null) return m.atRel;
    return m.targetKind === 'dir' ? m.targetRel : parentRel(m.targetRel);
  };

  /* ---- 渲染 ---- */

  const renderRow = (row: { rel: string; entry: FsEntry; depth: number }) => {
    const { rel, entry, depth } = row;
    // rename prompt 原位替换目标行（jupyterlab _doRename）
    if (prompt?.mode === 'rename' && prompt.targetRel === rel) {
      return (
        <PromptInput
          key={`prompt-${rel}`}
          depth={depth}
          mode="rename"
          initial={entry.name}
          error={promptError}
          onSubmit={submitPrompt}
          onCancel={() => {
            setPrompt(null);
            setPromptError(null);
          }}
        />
      );
    }
    const isDir = entry.kind === 'dir';
    const notebook = !isDir && isNotebookFile(entry.name);
    const isOpen = isDir && expanded.has(rel);
    const isSelected = selected.has(rel);
    return (
      <div
        key={rel}
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={isDir ? isOpen : undefined}
        className={`group flex cursor-default items-center gap-1.5 rounded px-1 py-[3px] pr-1 text-[12px] select-none ${
          isSelected ? 'bg-[var(--sel-bg)]' : 'hover:bg-[var(--bg)]'
        } ${!isDir && !notebook ? 'text-[var(--muted)] opacity-60' : ''}`}
        style={{ paddingLeft: `${6 + depth * 14}px` }}
        title={isDir ? rel : `${rel}${notebook ? '' : ' — 非 notebook，不可打开'}`}
        onClick={(e) => onRowClick(e, rel)}
        onDoubleClick={() => onRowDblClick(rel, entry)}
        onContextMenu={(e) => openMenu(e, rel, entry.kind, parentRel(rel))}
      >
        {/* 图标：目录 chevron；.py = notebook ◈（amber）；其余文件 ○ 灰 */}
        <span aria-hidden className="w-3 shrink-0 text-center text-[10px] text-[var(--muted)]">
          {isDir ? (isOpen ? '▾' : '▸') : notebook ? '' : '·'}
        </span>
        {!isDir && notebook && (
          <span aria-hidden className="shrink-0 text-[11px]" style={{ color: 'var(--accent-run)' }}>
            ◈
          </span>
        )}
        <span className={`min-w-0 flex-1 truncate ${notebook ? 'text-[var(--text)]' : ''}`}>{entry.name}</span>
        {!isDir && (
          <span className="shrink-0 text-[10px] text-[var(--muted)] opacity-0 group-hover:opacity-100">
            {humanSize(entry.size)}
          </span>
        )}
        <button
          type="button"
          title="操作菜单"
          onClick={(e) => openMenu(e, rel, entry.kind, parentRel(rel))}
          className="shrink-0 rounded px-1 text-[var(--muted)] opacity-0 hover:text-[var(--text)] group-hover:opacity-100"
        >
          ⋯
        </button>
      </div>
    );
  };

  /** 头部快捷新建的目标目录：唯一选中项为 dir → 其内部；file → 其父；否则 root。 */
  const quickDir = useMemo(() => {
    if (selected.size !== 1) return '';
    const rel = [...selected][0]!;
    const row = rows.find((r) => r.rel === rel);
    return row?.entry.kind === 'dir' ? rel : parentRel(rel);
  }, [selected, rows]);

  /** 新建 prompt 的插入位置：parentRel 行之后（root = 列表顶部）。 */
  const renderTree = () => {
    const out: ReactNode[] = [];
    const newPrompt = prompt && prompt.mode !== 'rename' ? prompt : null;
    if (newPrompt && newPrompt.parentRel === '') {
      out.push(
        <PromptInput
          key="prompt-root"
          depth={0}
          mode={newPrompt.mode}
          initial={newPrompt.initial}
          error={promptError}
          onSubmit={submitPrompt}
          onCancel={() => {
            setPrompt(null);
            setPromptError(null);
          }}
        />,
      );
    }
    for (const row of rows) {
      out.push(renderRow(row));
      if (newPrompt && newPrompt.parentRel === row.rel && row.entry.kind === 'dir') {
        out.push(
          <PromptInput
            key={`prompt-${row.rel}`}
            depth={row.depth + 1}
            mode={newPrompt.mode}
            initial={newPrompt.initial}
            error={promptError}
            onSubmit={submitPrompt}
            onCancel={() => {
              setPrompt(null);
              setPromptError(null);
            }}
          />,
        );
      }
    }
    return out;
  };

  return (
    <>
      {/* 面板头：root 名 + 快捷动作 */}
      <div className="flex items-center gap-1 border-b border-[var(--border)] px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[11px] tracking-wider text-[var(--muted)] uppercase">
          {root === null ? 'workspace' : baseName(root) || root}
        </span>
        <IconBtn
          glyph="＋◈"
          title="新建 notebook（marimo 头模板）"
          onClick={() => root !== null && startPrompt({ mode: 'new-notebook', parentRel: quickDir, initial: 'untitled.py' })}
        />
        <IconBtn
          glyph="＋▸"
          title="新建文件夹"
          onClick={() => root !== null && startPrompt({ mode: 'new-folder', parentRel: quickDir, initial: 'new-folder' })}
        />
        <IconBtn glyph="⟳" title="刷新" onClick={() => void loadDir('')} />
      </div>

      {/* 面包屑：root 路径分段，点段 = fs.setRoot 到该级 */}
      {root !== null && <Breadcrumbs root={root} onNavigate={(dir) => void setRootDir(dir)} />}

      {/* 树 */}
      <div
        role="tree"
        aria-label="workspace files"
        className="min-h-0 flex-1 overflow-y-auto px-1 py-1"
        onContextMenu={(e) => {
          // 空白背景 → 所在层级菜单（root）
          if (e.target === e.currentTarget) openMenu(e, null, null, '');
        }}
      >
        {root === null ? (
          <p className="p-2 text-[11px] leading-relaxed text-[var(--muted)]">
            尚无工作区 —— 打开一个 .py notebook 后其所在目录即工作区；或对任意目录右键"设为工作区"。
          </p>
        ) : loading.has('') && rows.length === 0 ? (
          <p className="p-2 text-[11px] text-[var(--muted)]">loading…</p>
        ) : rows.length === 0 ? (
          <p className="p-2 text-[11px] text-[var(--muted)]">空目录 —— 右键新建 notebook。</p>
        ) : (
          renderTree()
        )}
      </div>

      {menu && root !== null && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onNewNotebook={() => {
            startPrompt({ mode: 'new-notebook', parentRel: menuCtxDir(menu), initial: 'untitled.py' });
            setMenu(null);
          }}
          onNewFolder={() => {
            startPrompt({ mode: 'new-folder', parentRel: menuCtxDir(menu), initial: 'new-folder' });
            setMenu(null);
          }}
          onRename={() => {
            const rel = menu.targetRel;
            if (rel) startPrompt({ mode: 'rename', parentRel: parentRel(rel), targetRel: rel, initial: baseName(rel) });
            setMenu(null);
          }}
          onDelete={() => {
            const rel = menu.targetRel;
            if (rel) setDeleteTarget({ rel, name: baseName(rel) });
            setMenu(null);
          }}
          onSetWorkspace={() => {
            const rel = menu.targetRel;
            if (rel) void setRootDir(joinFsPath(root, rel));
            setMenu(null);
          }}
        />
      )}

      {deleteTarget && (
        <DeleteDialog
          target={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </>
  );
}

function IconBtn({ glyph, title, onClick }: { glyph: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="rounded px-1 text-[11px] text-[var(--muted)] hover:bg-[var(--bg)] hover:text-[var(--text)]"
    >
      {glyph}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 面包屑（jupyterlab crumbs.ts 语义：分段可点导航；视觉 clean-room）      */
/* ------------------------------------------------------------------ */

function Breadcrumbs({ root, onNavigate }: { root: string; onNavigate: (dir: string) => void }) {
  const sep = root.includes('\\') ? '\\' : '/';
  const isAbs = /^[\\/]/.test(root); // POSIX 绝对路径（Windows 盘符 'D:' 不算）
  const parts = root.split(/[\\/]/).filter(Boolean);
  const crumbs: { label: string; dir: string }[] = [];
  let acc = '';
  for (let i = 0; i < parts.length; i++) {
    if (i === 0) acc = isAbs ? sep + parts[i]! : parts[i]!;
    else acc = acc + sep + parts[i]!;
    // Windows 盘符（'D:'）不可单独导航
    const navigable = !(i === 0 && !isAbs && acc.endsWith(':'));
    crumbs.push({ label: parts[i]!, dir: navigable ? acc : '' });
  }
  return (
    <div className="flex items-center gap-0.5 overflow-x-auto whitespace-nowrap border-b border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)] [scrollbar-width:none]">
      {crumbs.map((c, i) => (
        <span key={c.dir || c.label} className="flex items-center gap-0.5">
          {i > 0 && <span aria-hidden className="text-[var(--border)]">›</span>}
          {c.dir ? (
            <button
              type="button"
              title={`设为工作区: ${c.dir}`}
              onClick={() => onNavigate(c.dir)}
              className={`rounded px-0.5 hover:text-[var(--text)] ${i === crumbs.length - 1 ? 'text-[var(--text)]' : ''}`}
            >
              {c.label}
            </button>
          ) : (
            <span className="px-0.5">{c.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 右键 / ⋯ 菜单                                                        */
/* ------------------------------------------------------------------ */

function ContextMenu({
  menu,
  onClose,
  onNewNotebook,
  onNewFolder,
  onRename,
  onDelete,
  onSetWorkspace,
}: {
  menu: MenuState;
  onClose: () => void;
  onNewNotebook: () => void;
  onNewFolder: () => void;
  onRename: () => void;
  onDelete: () => void;
  onSetWorkspace: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);

  const hasTarget = menu.targetRel !== null;
  const item = 'w-full px-3 py-1 text-left text-[12px] text-[var(--text)] hover:bg-[var(--bg)]';
  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-44 rounded-md border border-[var(--border)] bg-[var(--panel)] py-1 shadow-lg"
      style={{ left: menu.x, top: menu.y }}
    >
      <button type="button" className={item} onClick={onNewNotebook}>
        新建 notebook
      </button>
      <button type="button" className={item} onClick={onNewFolder}>
        新建文件夹
      </button>
      {hasTarget && (
        <>
          <div className="my-1 border-t border-[var(--border)]" />
          <button type="button" className={item} onClick={onRename}>
            重命名…
          </button>
          <button
            type="button"
            className={`${item} text-[var(--accent-err)]`}
            onClick={onDelete}
          >
            删除…
          </button>
        </>
      )}
      {menu.targetKind === 'dir' && (
        <>
          <div className="my-1 border-t border-[var(--border)]" />
          <button type="button" className={item} onClick={onSetWorkspace}>
            设为工作区
          </button>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 行内 prompt（新建 / 重命名；Enter 提交、Esc 取消）                      */
/* ------------------------------------------------------------------ */

function PromptInput({
  depth,
  mode,
  initial,
  error,
  onSubmit,
  onCancel,
}: {
  depth: number;
  mode: PromptState['mode'];
  initial: string;
  error: string | null;
  onSubmit: (value: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (mode === 'rename') {
      // jupyterlab：文件重命名选中主名、保留扩展名
      const sel = renameSelection(initial);
      el.setSelectionRange(sel.start, sel.end);
    } else {
      el.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void onSubmit(ref.current?.value ?? '');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <div className="px-1 py-[2px]" style={{ paddingLeft: `${6 + depth * 14}px` }}>
      <input
        ref={ref}
        defaultValue={initial}
        spellCheck={false}
        onKeyDown={onKey}
        aria-label={mode === 'rename' ? 'rename' : mode}
        className={`w-full rounded border bg-[var(--bg)] px-1 py-[2px] text-[12px] text-[var(--text)] outline-none ${
          error ? 'border-[var(--accent-err)]' : 'border-[var(--accent-run)]'
        }`}
      />
      {error && <p className="mt-0.5 text-[10px] text-[var(--accent-err)]">{error}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 删除确认（需输入文件名，防误删；目录递归）                               */
/* ------------------------------------------------------------------ */

function DeleteDialog({
  target,
  onCancel,
  onConfirm,
}: {
  target: DeleteTarget;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [text, setText] = useState('');
  const ok = text === target.name;
  const submit = () => {
    if (ok) onConfirm();
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-80 rounded-md border border-[var(--border)] bg-[var(--panel)] p-4 shadow-xl">
        <p className="text-[13px] text-[var(--text)]">
          删除 <span className="text-[var(--accent-err)]">{target.name}</span>？
        </p>
        <p className="mt-1 text-[11px] text-[var(--muted)]">
          目录将递归删除，不可恢复。输入文件名以确认：
        </p>
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') onCancel();
          }}
          spellCheck={false}
          placeholder={target.name}
          className="mt-2 w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[12px] text-[var(--text)] outline-none focus:border-[var(--accent-err)]"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-[var(--border)] px-3 py-1 text-[12px] text-[var(--muted)] hover:text-[var(--text)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!ok}
            className="rounded border border-[var(--accent-err)] px-3 py-1 text-[12px] text-[var(--accent-err)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Recent tab（localStorage 最近打开）                                   */
/* ------------------------------------------------------------------ */

function RecentPanel({
  recents,
  onOpen,
  onRemove,
  onClear,
}: {
  recents: RecentEntry[];
  onOpen: (abs: string) => void;
  onRemove: (p: string) => void;
  onClear: () => void;
}) {
  return (
    <>
      <div className="flex items-center gap-1 border-b border-[var(--border)] px-2 py-1.5">
        <span className="min-w-0 flex-1 text-[11px] tracking-wider text-[var(--muted)] uppercase">recent</span>
        {recents.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            title="清空最近打开"
            className="rounded px-1 text-[11px] text-[var(--muted)] hover:bg-[var(--bg)] hover:text-[var(--text)]"
          >
            清空
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {recents.length === 0 && (
          <p className="p-2 text-[11px] text-[var(--muted)]">暂无最近打开记录。</p>
        )}
        {recents.map((r) => (
          <div
            key={r.path}
            className="group flex cursor-default items-center gap-1.5 rounded px-2 py-1 text-[12px] hover:bg-[var(--bg)]"
            title={r.path}
            onDoubleClick={() => onOpen(r.path)}
          >
            <span aria-hidden className="shrink-0 text-[11px]" style={{ color: 'var(--accent-run)' }}>
              ◈
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[var(--text)]">{baseName(r.path)}</span>
              <span className="block truncate text-[10px] text-[var(--muted)]">{dirName(r.path)}</span>
            </span>
            <button
              type="button"
              title="从列表移除"
              onClick={() => onRemove(r.path)}
              className="shrink-0 rounded px-1 text-[var(--muted)] opacity-0 hover:text-[var(--text)] group-hover:opacity-100"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
