/**
 * Welcome 页纯函数（v0.1.1，vitest 直接覆盖）。
 */

import type { RecentEntry } from '../sidebar/helpers';

/** 路径 → {name, dir}（Windows / POSIX 分隔符都认）。 */
export function splitPath(p: string): { name: string; dir: string } {
  const norm = p.replace(/[\\/]+$/, '');
  const i = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
  if (i < 0) return { name: norm, dir: '' };
  return { name: norm.slice(i + 1), dir: norm.slice(0, i) };
}

/** 最近打开：按时间倒序去重、截前 n 条（localStorage 已去重，这里再兜一层）。 */
export function recentItems(list: readonly RecentEntry[], n = 8): RecentEntry[] {
  const seen = new Set<string>();
  const out: RecentEntry[] = [];
  for (const e of [...list].sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1))) {
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    out.push(e);
    if (out.length >= n) break;
  }
  return out;
}

/** 相对时间（英文短格式与中文；> 30 天回落日期）。 */
export function relativeTime(iso: string, now: number, lang: 'en' | 'zh'): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  const zh = lang === 'zh';
  if (s < 60) return zh ? '刚刚' : 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return zh ? `${m} 分钟前` : `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return zh ? `${h} 小时前` : `${h}h ago`;
  const d = Math.round(h / 24);
  if (d <= 30) return zh ? `${d} 天前` : `${d}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** 新建 notebook 的默认名：untitled.py 已存在则 untitled-1.py、-2…… */
export function nextUntitledName(existing: readonly string[]): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has('untitled.py')) return 'untitled.py';
  for (let i = 1; ; i++) {
    const cand = `untitled-${i}.py`;
    if (!taken.has(cand)) return cand;
  }
}

/** shell 参数引号（含空白或引号才加）。 */
export function shellQuote(s: string): string {
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/** MCP 接入命令（Claude Code）：launch = bridge.mcpLaunch 回报的启动命令行；notebook 可选。 */
export function mcpAddCommand(launch: readonly string[], notebookPath: string | null): string {
  const parts = [...launch, '--mcp', ...(notebookPath ? [notebookPath] : [])];
  return `claude mcp add novalab -- ${parts.map(shellQuote).join(' ')}`;
}
