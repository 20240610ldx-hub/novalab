import { useState } from 'react';
import { useAgentStore } from '../../store/agent';

/**
 * 上下文审计 chip（spec §8 / M5："本次发送了什么" 的显式 UI）。
 * AgentPanel 顶部常驻：`context: N schemas · M traceback · 0 rows sent`；
 * 点击展开最近一次请求实际 payload 的逐 section 预览（标签 + 体积 + 全文）。
 * rowsSent 恒 0 —— DataFrame 全量/行数据被 payload.ts 的 4KB 双闸拦在进程内。
 */
export function ContextChip() {
  const lastPayload = useAgentStore((s) => s.lastPayload);
  const [open, setOpen] = useState(false);

  const schemas = lastPayload?.schemaCount ?? 0;
  const tracebacks = lastPayload?.tracebackCount ?? 0;

  return (
    <div className="border-b border-[var(--border)] px-2 py-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="点击审计本次请求实际发送的 payload"
        className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--text)]"
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent-ok)]" />
        <span className="font-mono">
          context: {schemas} schemas · {tracebacks} traceback · 0 rows sent
        </span>
        <span className="ml-auto">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="mt-1 rounded border border-[var(--border)] bg-[var(--panel)] p-2 text-[11px]">
          {!lastPayload && <p className="text-[var(--muted)]">尚未发送任何请求。</p>}
          {lastPayload && (
            <>
              <p className="mb-1 text-[var(--muted)]">
                最近一次请求 · {lastPayload.sections.length} 段 · 共 {lastPayload.totalBytes} B
                （单段硬上限 4096 B，行数据 0 条）
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
        </div>
      )}
    </div>
  );
}
