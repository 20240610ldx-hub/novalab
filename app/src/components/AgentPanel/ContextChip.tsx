import { useState } from 'react';
import { useAgentStore } from '../../store/agent';
import { useI18n } from '../../i18n';

/**
 * 上下文审计 chip（spec §8 / M5："本次发送了什么" 的显式 UI）。
 * AgentPanel 顶部常驻：`context: N schemas · M traceback · K tool results · cell outputs stay local`。
 * 点击展开：首条消息逐 section 预览 + 本轮每次工具返回（工具名 / 体积 / 截断预览）。
 *
 * v0.1.1：不再声称 "0 rows sent"——那是常量而非测量。审计现在覆盖工具出口
 * （tools.ts 每次返回记账）；cell 的 stdout/stderr 与写入路径由 bridge 的
 * get_cell_output 出口直接扣留（只回 traceback 与 mime 键名），故 chip 末段为固定陈述。
 */
export function ContextChip() {
  const lastPayload = useAgentStore((s) => s.lastPayload);
  const toolAudit = useAgentStore((s) => s.toolAudit);
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  const schemas = lastPayload?.schemaCount ?? 0;
  const tracebacks = lastPayload?.tracebackCount ?? 0;
  const toolBytes = toolAudit.reduce((n, e) => n + e.bytes, 0);

  return (
    <div className="border-b border-[var(--border)] px-2 py-1" data-testid="context-chip">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t('chip.title')}
        className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--text)]"
      >
        <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent-ok)]" />
        <span className="truncate font-mono">
          {t('chip.summary', { schemas, tracebacks, tools: toolAudit.length })} · {t('chip.outputsWithheld')}
        </span>
        <span className="ml-auto">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="mt-1 max-h-80 overflow-auto rounded border border-[var(--border)] bg-[var(--panel)] p-2 text-[11px]">
          {!lastPayload && <p className="text-[var(--muted)]">{t('chip.none')}</p>}
          {lastPayload && (
            <>
              <p className="mb-1 text-[var(--muted)]">
                {t('chip.lastRequest', { sections: lastPayload.sections.length, bytes: lastPayload.totalBytes })}
              </p>
              <ul className="space-y-1">
                {lastPayload.sections.map((sec, i) => (
                  <li key={i} className="rounded border border-[var(--border)] bg-[var(--bg)]">
                    <div className="flex items-baseline justify-between gap-2 px-1.5 pt-1">
                      <span className="text-[var(--text)]">{sec.label}</span>
                      <span className="shrink-0 text-[var(--muted)]">{sec.bytes} B</span>
                    </div>
                    <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all px-1.5 pb-1 text-[var(--muted)]">
                      {sec.text}
                    </pre>
                  </li>
                ))}
              </ul>
            </>
          )}
          {toolAudit.length > 0 && (
            <>
              <p className="mb-1 mt-2 text-[var(--muted)]">
                {t('chip.toolsHeader', { count: toolAudit.length, bytes: toolBytes })}
              </p>
              <ul className="space-y-1">
                {toolAudit.map((e, i) => (
                  <li key={i} className="rounded border border-[var(--border)] bg-[var(--bg)]">
                    <div className="flex items-baseline justify-between gap-2 px-1.5 pt-1">
                      <span className="font-mono text-[var(--text)]">{e.tool}</span>
                      <span className="shrink-0 text-[var(--muted)]">{e.bytes} B</span>
                    </div>
                    {(e.redacted || e.droppedKeys.length > 0) && (
                      <p className="px-1.5 text-[var(--accent-err)]">
                        {e.redacted
                          ? t('chip.toolRedacted')
                          : t('chip.toolDropped', { keys: e.droppedKeys.join(', ') })}
                      </p>
                    )}
                    <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all px-1.5 pb-1 text-[var(--muted)]">
                      {e.preview}
                    </pre>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
