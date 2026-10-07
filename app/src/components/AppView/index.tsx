/**
 * AppView（P4.2，spec §15.4）：只读报告视图。
 *
 * - 隐藏代码编辑器与 cell 徽章——报告语义 = 面向读者，不面向作者；
 * - 仅渲染：notebook 标题、`# [md]` 注释块转散文段落、交互控件与输出
 *   （OutputRenderer 内部经 control mime 分发 ControlRenderer，交互控件在
 *   App View 中保持可操作——spec §15.3 控件写通道仅人类 UI，协议零改动）；
 * - 无 REPL / 无 diff / 无运行按钮（编辑动作全部留在 edit 模式）；
 * - 顶部返回编辑按钮（与 header 切换钮、?view=app URL 参数三方同步，见 App.tsx）。
 *
 * 数据全部来自既有 store（useNotebook.cells），无新协议字段。
 */

import { useNotebook } from '../../store/notebook';
import { useUi } from '../../store/ui';
import { useI18n } from '../../i18n';
import { OutputRenderer } from '../OutputRenderer';
import { appViewCells, isProseCell, notebookTitle, proseParagraphs } from './selectors';

/** 单个散文块：`# [md]` 行还原为段落（serif 排版与代码区观感区隔）。 */
function ProseBlock({ code }: { code: string }) {
  const paras = proseParagraphs(code);
  if (paras.length === 0) return null;
  return (
    <section className="px-1 py-2">
      {paras.map((p, i) => (
        <p key={i} className="whitespace-pre-wrap text-[14px] leading-[1.75] text-[var(--text)]">
          {p}
        </p>
      ))}
    </section>
  );
}

export function AppView() {
  const cells = useNotebook((s) => s.cells);
  const notebookPath = useNotebook((s) => s.notebookPath);
  const setAppMode = useUi((s) => s.setAppMode);
  const { t } = useI18n();

  const visible = appViewCells(cells);
  const title = notebookTitle(notebookPath) ?? t('appView.untitled');

  return (
    <div className="flex h-full flex-col">
      {/* 报告头：标题 + 返回编辑（唯一的模式出口，与 header 切换钮等价） */}
      <header className="flex items-center gap-3 border-b border-[var(--border)] px-6 py-3">
        <h1 className="min-w-0 flex-1 truncate text-[16px] text-[var(--text)]">{title}</h1>
        <button
          type="button"
          onClick={() => setAppMode('edit')}
          title={t('app.toEditMode')}
          className="shrink-0 rounded border border-[var(--border)] px-2.5 py-1 text-[12px] text-[var(--muted)] hover:border-[var(--accent-run)] hover:text-[var(--text)]"
        >
          {t('appView.back')}
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-4">
          {visible.length === 0 && (
            <p className="py-10 text-center text-[13px] leading-relaxed text-[var(--muted)]">
              {t('appView.empty')}
            </p>
          )}
          {visible.map((cell) => (
            <article key={cell.id} className="border-b border-[var(--border)] py-2 last:border-b-0">
              {isProseCell(cell) ? (
                <ProseBlock code={cell.code} />
              ) : (
                cell.output && <OutputRenderer output={cell.output} />
              )}
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
