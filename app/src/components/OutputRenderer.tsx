import { Fragment } from 'react';
import type { CellOutput, MimeBundle } from '../kernel/types';

/** MIME bundle 中前端认识的键；其余按"未知 mime"降级为灰字 key 列表。 */
const KNOWN_MIME = new Set(['text/plain', 'image/png']);

function mimeText(v: string | string[]): string {
  return Array.isArray(v) ? v.join('') : v;
}

function MimeItem({ mime, data }: { mime: string; data: string | string[] }) {
  if (mime === 'text/plain') {
    return <pre className="whitespace-pre-wrap break-words px-3 py-2">{mimeText(data)}</pre>;
  }
  if (mime === 'image/png') {
    return (
      <div className="px-3 py-2">
        <img
          src={`data:image/png;base64,${mimeText(data)}`}
          alt="cell output"
          className="max-w-full rounded border border-[var(--border)]"
        />
      </div>
    );
  }
  return null; // 未知 mime 由 UnknownMimeKeys 统一列出
}

function UnknownMimeKeys({ bundle }: { bundle: MimeBundle }) {
  const unknown = Object.keys(bundle).filter((k) => !KNOWN_MIME.has(k));
  if (unknown.length === 0) return null;
  return (
    <div className="px-3 py-1.5 text-[12px] text-[var(--muted)]">
      unrendered mime: {unknown.join(', ')}
    </div>
  );
}

/**
 * 文件写通知行（P2.9，参考图：输出下 `wrote <绝对路径>`）：
 * muted 等宽、每行一条、容器横向滚动（长路径不折行不撑破面板）。
 */
function WriteNotifications({ writes }: { writes: string[] }) {
  if (writes.length === 0) return null;
  return (
    <div
      className="overflow-x-auto px-3 py-1.5 text-[12px] text-[var(--muted)]"
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

/**
 * MIME bundle 渲染（截图元素 5 的内容区，spec §10）：
 * traceback → 红底面板 + frames（file:line fn srcLine 等宽）；
 * stderr → 红字 pre；stdout → pre；text/plain → pre；image/png → base64 img；
 * 未知 mime → 灰字 key 列表；末尾 wrote 通知行（P2.9 run.notify file-write）。
 */
export function OutputRenderer({ output }: { output: CellOutput }) {
  const { stdout, stderr, traceback, mime } = output;
  const mimeKeys = Object.keys(mime).filter((k) => KNOWN_MIME.has(k));
  // 防御：旧快照/桥接载荷可能缺 writes 字段（reducer 保证新输出必有）
  const writes = output.writes ?? [];

  return (
    <div className="border-t border-[var(--border)] text-[12.5px]">
      {traceback && (
        <div className="m-2 rounded border border-[var(--accent-err)] bg-[var(--diff-del)]">
          <pre className="whitespace-pre-wrap break-words px-3 py-2 text-[var(--accent-err)]">
            {traceback.text}
          </pre>
          {traceback.frames.length > 0 && (
            <ul className="border-t border-[var(--accent-err)]/40 px-3 py-1.5">
              {traceback.frames.map((f, i) => (
                <li key={i} className="py-0.5 text-[12px]">
                  <span className="text-[var(--muted)]">
                    {f.file}:{f.line}
                  </span>{' '}
                  <span className="text-[var(--text)]">{f.fn}</span>
                  {f.srcLine && (
                    <Fragment>
                      <br />
                      <code className="pl-4 text-[var(--accent-err)]">{f.srcLine}</code>
                    </Fragment>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {stderr && (
        <pre className="whitespace-pre-wrap break-words px-3 py-2 text-[var(--accent-err)]">
          {stderr}
        </pre>
      )}

      {stdout && <pre className="whitespace-pre-wrap break-words px-3 py-2">{stdout}</pre>}

      {mimeKeys.map((k) => (
        <MimeItem key={k} mime={k} data={mime[k]!} />
      ))}

      <UnknownMimeKeys bundle={mime} />

      <WriteNotifications writes={writes} />
    </div>
  );
}
