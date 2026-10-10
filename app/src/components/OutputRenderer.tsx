import { Fragment, createElement, useMemo, type ReactNode } from 'react';
import type { CellOutput, MimeBundle, TracebackFrame } from '../kernel/types';
import { ControlRenderer } from './controls/ControlRenderer';
import { CONTROL_MIME } from './controls/logic';
import { isRenderableHtml, parseSafeHtml, type SafeHtmlNode } from './htmlSanitize';

/** MIME bundle 中前端认识的键；其余按"未知 mime"降级为灰字 key 列表。 */
const KNOWN_MIME = new Set(['text/plain', 'text/html', 'image/png', CONTROL_MIME]);

function mimeText(v: string | string[]): string {
  return Array.isArray(v) ? v.join('') : v;
}

/* ------------------------------------------------------------------ */
/* A-3 #20/#22：输出分区（Q 线）                                          */
/*                                                                     */
/* 纯函数 deriveOutputSegments：CellOutput → 按 run 内出现顺序堆叠的      */
/* 分区列表——stdout 段与 stderr / traceback 段**分开各自成面板**          */
/* （参考图 [76]：stdout 中性面板 + 红面板相继）。CellOutput 是累积串      */
/* 形态（store/notebook.ts reducer 边界，Q 线不动），故分区粒度 =          */
/* 流级别（stdout → stderr → traceback → mime），非逐 chunk 交错。        */
/*                                                                     */
/* 富表示优先（ADR-011，Jupyter richest-representation 语义）：同一收尾值  */
/* 的 text/html 与 text/plain 只出一个分区——有 text/html 出 html 分区     */
/* （text/plain 随分区携带作回落），否则出 text-plain。                    */
/* ------------------------------------------------------------------ */

export type OutputSegment =
  | { kind: 'stdout'; text: string }
  | { kind: 'stderr'; text: string }
  | { kind: 'traceback'; text: string; frames: TracebackFrame[] }
  | { kind: 'text-plain'; text: string }
  | { kind: 'html'; html: string; fallbackText: string | null }
  | { kind: 'image'; data: string }
  | { kind: 'control'; data: unknown };

/** CellOutput → 有序分区（空流不产生分区；mime 仅收已知键，顺序固定）。 */
export function deriveOutputSegments(output: CellOutput): OutputSegment[] {
  const segs: OutputSegment[] = [];
  if (output.stdout !== '') segs.push({ kind: 'stdout', text: output.stdout });
  if (output.stderr !== '') segs.push({ kind: 'stderr', text: output.stderr });
  if (output.traceback) {
    segs.push({ kind: 'traceback', text: output.traceback.text, frames: output.traceback.frames ?? [] });
  }
  const mime = output.mime ?? {};
  const plain = mime['text/plain'] !== undefined ? mimeText(mime['text/plain']) : null;
  const html = mime['text/html'] !== undefined ? mimeText(mime['text/html']) : '';
  if (html !== '') {
    segs.push({ kind: 'html', html, fallbackText: plain });
  } else if (plain !== null) {
    segs.push({ kind: 'text-plain', text: plain });
  }
  if (mime['image/png'] !== undefined) {
    segs.push({ kind: 'image', data: mimeText(mime['image/png']) });
  }
  if (mime[CONTROL_MIME] !== undefined) {
    segs.push({ kind: 'control', data: mime[CONTROL_MIME] });
  }
  return segs;
}

/* ------------------------------------------------------------------ */
/* 面板基元（SessionModal #24 复用同一套观感）                             */
/* ------------------------------------------------------------------ */

/** 中性面板：stdout / text-plain / 表格 = 细边框圆角、--panel 底、内部滚动（#22）。 */
export function OutPanel({ children }: { children: ReactNode }) {
  return <div className="nl-out-panel nl-scroll-thin">{children}</div>;
}

/** 错误面板：stderr / traceback / RuntimeWarning = 红左竖框 + 红粉字（#20）。 */
export function ErrPanel({ children }: { children: ReactNode }) {
  return <div className="nl-out-panel nl-out-err nl-scroll-thin">{children}</div>;
}

function UnknownMimeKeys({ bundle }: { bundle: MimeBundle }) {
  const unknown = Object.keys(bundle).filter((k) => !KNOWN_MIME.has(k));
  if (unknown.length === 0) return null;
  return (
    <div className="px-1 text-[12px] text-[var(--muted)]">
      unrendered mime: {unknown.join(', ')}
    </div>
  );
}

/** 白名单树 → React 元素（标签名与属性只来自 htmlSanitize 的白名单，文本走 React 转义）。 */
function renderSafeHtml(nodes: SafeHtmlNode[]): ReactNode[] {
  return nodes.map((n, i) =>
    typeof n === 'string'
      ? n
      : createElement(
          n.tag,
          { key: i, colSpan: n.colSpan, rowSpan: n.rowSpan },
          ...(n.children.length > 0 ? [renderSafeHtml(n.children)] : []),
        ),
  );
}

/**
 * text/html 分区（ADR-011）：DOMParser 解析 → 白名单重建 → 中性面板内渲染为真表格。
 * 非表格型 / 消毒后无内容 → 回落 text/plain 面板 + 灰字注记（与未知 mime 同一降级观感）。
 */
function HtmlSegment({ html, fallbackText }: { html: string; fallbackText: string | null }) {
  const safe = useMemo(() => parseSafeHtml(html), [html]);
  if (!isRenderableHtml(safe)) {
    return (
      <>
        {fallbackText !== null && (
          <OutPanel>
            <pre className="whitespace-pre-wrap break-words px-3 py-2">{fallbackText}</pre>
          </OutPanel>
        )}
        <div className="px-1 text-[12px] text-[var(--muted)]">unrendered mime: text/html</div>
      </>
    );
  }
  return (
    <OutPanel>
      <div className="nl-out-html">{renderSafeHtml(safe.nodes)}</div>
      {safe.truncated && (
        <div className="px-3 pb-2 text-[12px] text-[var(--muted)]">html output truncated</div>
      )}
    </OutPanel>
  );
}

/**
 * 文件写通知行（P2.9，参考图：输出下 `wrote <绝对路径>`）：
 * muted 等宽、每行一条、容器横向滚动（长路径不折行不撑破面板）。
 */
export function WriteNotifications({ writes }: { writes: string[] }) {
  if (writes.length === 0) return null;
  return (
    <div
      className="overflow-x-auto px-1 text-[12px] text-[var(--muted)]"
      style={{ fontFamily: 'var(--font-mono)' }}
    >
      {writes.map((p, i) => (
        <div key={`${p}#${i}`} className="whitespace-pre">
          wrote {p}
        </div>
      ))}
    </div>
  );
}

function SegmentView({ seg }: { seg: OutputSegment }) {
  switch (seg.kind) {
    case 'stdout':
      return (
        <OutPanel>
          <pre className="whitespace-pre-wrap break-words px-3 py-2">{seg.text}</pre>
        </OutPanel>
      );
    case 'stderr':
      return (
        <ErrPanel>
          <pre className="whitespace-pre-wrap break-words px-3 py-2">{seg.text}</pre>
        </ErrPanel>
      );
    case 'traceback':
      return (
        <ErrPanel>
          <pre className="whitespace-pre-wrap break-words px-3 py-2">{seg.text}</pre>
          {seg.frames.length > 0 && (
            <ul className="border-t border-[var(--accent-err)]/40 px-3 py-1.5">
              {seg.frames.map((f, i) => (
                <li key={i} className="py-0.5 text-[12px]">
                  <span className="text-[var(--muted)]">
                    {f.file}:{f.line}
                  </span>{' '}
                  <span className="text-[var(--text)]">{f.fn}</span>
                  {f.srcLine && (
                    <Fragment>
                      <br />
                      <code className="pl-4">{f.srcLine}</code>
                    </Fragment>
                  )}
                </li>
              ))}
            </ul>
          )}
        </ErrPanel>
      );
    case 'text-plain':
      return (
        <OutPanel>
          <pre className="whitespace-pre-wrap break-words px-3 py-2">{seg.text}</pre>
        </OutPanel>
      );
    case 'html':
      return <HtmlSegment html={seg.html} fallbackText={seg.fallbackText} />;
    case 'image':
      return (
        <img
          src={`data:image/png;base64,${seg.data}`}
          alt="cell output"
          className="max-w-full rounded border border-[var(--border)]"
        />
      );
    case 'control':
      // P3.3：控件载荷（JSON 串/对象均兼容）→ ControlRenderer 按 kind 分发
      return <ControlRenderer raw={seg.data} />;
  }
}

/**
 * MIME bundle 渲染（截图元素 5 的内容区，spec §10 + A-3 #20/#22）：
 * deriveOutputSegments 分区 → stdout/text-plain 中性面板、stderr/traceback
 * 红左框面板（各自内部滚动 max-height 420px）、text/html 白名单重建为表格
 * （ADR-011，有 html 时取代 text/plain）、image/png base64 img、
 * application/vnd.novalab.control+json → ControlRenderer（P3.3 交互控件）；
 * 未知 mime → 灰字 key 列表；末尾 wrote 通知行（P2.9 run.notify file-write）。
 */
export function OutputRenderer({ output }: { output: CellOutput }) {
  const segments = deriveOutputSegments(output);
  // 防御：旧快照/桥接载荷可能缺 writes 字段（reducer 保证新输出必有）
  const writes = output.writes ?? [];

  return (
    <div className="space-y-2 border-t border-[var(--border)] p-2 text-[12.5px]">
      {segments.map((seg, i) => (
        <SegmentView key={`${seg.kind}#${i}`} seg={seg} />
      ))}

      <UnknownMimeKeys bundle={output.mime ?? {}} />

      <WriteNotifications writes={writes} />
    </div>
  );
}
