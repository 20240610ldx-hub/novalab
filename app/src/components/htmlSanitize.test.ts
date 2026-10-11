/**
 * ADR-011：text/html 白名单重建 sanitizeHtmlNodes 单测（无 DOM——以结构化假节点喂入）。
 * 覆盖：DataFrame 形态保留、script/style 连内容丢弃、未知标签解包、属性白名单
 * （仅 colspan/rowspan 整数）、表格结构内空白文本丢弃、节点预算截断、可渲染判定。
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_HTML_NODES,
  isRenderableHtml,
  sanitizeHtmlNodes,
  type HtmlNodeLike,
} from './htmlSanitize';

function text(value: string): HtmlNodeLike {
  return { nodeType: 3, nodeName: '#text', nodeValue: value, childNodes: [] };
}

/** 假元素：nodeName 按 DOM 约定大写；attrs 经 getAttribute 暴露。 */
function el(tag: string, attrs: Record<string, string> = {}, children: HtmlNodeLike[] = []): HtmlNodeLike {
  return {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    nodeValue: null,
    childNodes: children,
    getAttribute: (name) => attrs[name] ?? null,
  };
}

describe('sanitizeHtmlNodes（text/html 白名单重建）', () => {
  it('pandas DataFrame 形态：<style> 连内容丢弃，表格结构与文本保留，class/border/style 属性不带出', () => {
    const tree = el('div', {}, [
      text('\n'),
      el('style', { scoped: '' }, [text('.dataframe thead th { text-align: right; }')]),
      el('table', { border: '1', class: 'dataframe' }, [
        text('\n  '),
        el('thead', {}, [
          el('tr', { style: 'text-align: right;' }, [el('th'), el('th', {}, [text('county')])]),
        ]),
        el('tbody', {}, [el('tr', {}, [el('th', {}, [text('0')]), el('td', {}, [text('沈阳')])])]),
        text('\n'),
      ]),
    ]);
    const safe = sanitizeHtmlNodes([tree]);
    expect(safe.nodes).toEqual([
      {
        tag: 'div',
        children: [
          '\n',
          {
            tag: 'table',
            children: [
              {
                tag: 'thead',
                children: [
                  {
                    tag: 'tr',
                    children: [
                      { tag: 'th', children: [] },
                      { tag: 'th', children: ['county'] },
                    ],
                  },
                ],
              },
              {
                tag: 'tbody',
                children: [
                  {
                    tag: 'tr',
                    children: [
                      { tag: 'th', children: ['0'] },
                      { tag: 'td', children: ['沈阳'] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    expect(safe).toMatchObject({ hasTable: true, hasText: true, truncated: false });
    expect(isRenderableHtml(safe)).toBe(true);
  });

  it('脚本 / 嵌入 / 表单面连子树丢弃；on* 与 URL 属性无从带出', () => {
    const safe = sanitizeHtmlNodes([
      el('script', {}, [text('alert(1)')]),
      el('img', { src: 'http://evil.example/x.png', onerror: 'alert(1)' }),
      el('iframe', { src: 'javascript:alert(1)' }, [text('inner')]),
      el('svg', {}, [el('script', {}, [text('alert(1)')]), el('a', { href: 'javascript:1' }, [text('x')])]),
      el('form', { action: 'http://evil.example' }, [el('input', { value: 'v' }), text('f')]),
      el('td', { onclick: 'alert(1)', style: 'background:url(http://evil.example)', id: 'x' }, [text('ok')]),
    ]);
    expect(safe.nodes).toEqual([{ tag: 'td', children: ['ok'] }]);
  });

  it('未知标签解包：标签丢、正文留（<a href> 只剩文字）', () => {
    const safe = sanitizeHtmlNodes([
      el('section', {}, [
        el('a', { href: 'javascript:alert(1)' }, [text('link')]),
        el('font', { color: 'red' }, [el('b', {}, [text('bold')])]),
      ]),
    ]);
    expect(safe.nodes).toEqual(['link', { tag: 'b', children: ['bold'] }]);
    expect(safe.hasTable).toBe(false);
    expect(isRenderableHtml(safe)).toBe(false); // 非表格 → 回落 text/plain
  });

  it('colspan / rowspan 只接受 2..1000 的整数，且仅限 td / th', () => {
    const safe = sanitizeHtmlNodes([
      el('th', { colspan: '2', rowspan: ' 3 ' }, []),
      el('td', { colspan: '1', rowspan: '99999' }, []),
      el('td', { colspan: '2;x', rowspan: '-1' }, []),
      el('div', { colspan: '2' }, []),
    ]);
    expect(safe.nodes).toEqual([
      { tag: 'th', colSpan: 2, rowSpan: 3, children: [] },
      { tag: 'td', children: [] },
      { tag: 'td', children: [] },
      { tag: 'div', children: [] },
    ]);
  });

  it('注释节点丢弃；void 标签不收子节点', () => {
    const comment: HtmlNodeLike = { nodeType: 8, nodeName: '#comment', nodeValue: 'x', childNodes: [] };
    const safe = sanitizeHtmlNodes([comment, el('br', {}, [text('ignored')]), text('a')]);
    expect(safe.nodes).toEqual([{ tag: 'br', children: [] }, 'a']);
  });

  it('只有脚本的 repr（plotly 形态）→ 无文本无表格 → 不可渲染', () => {
    const safe = sanitizeHtmlNodes([el('div', {}, [el('script', {}, [text('Plotly.newPlot()')]), el('div')])]);
    expect(safe).toMatchObject({ hasTable: false, hasText: false });
    expect(isRenderableHtml(safe)).toBe(false);
  });

  it('节点预算：超过 MAX_HTML_NODES 截断并置 truncated', () => {
    const cells = Array.from({ length: MAX_HTML_NODES + 50 }, () => el('td'));
    const safe = sanitizeHtmlNodes([el('table', {}, [el('tbody', {}, [el('tr', {}, cells)])])]);
    expect(safe.truncated).toBe(true);
    const row = (safe.nodes[0] as { children: { children: { children: unknown[] }[] }[] }).children[0]!.children[0]!;
    expect(row.children.length).toBe(MAX_HTML_NODES - 3); // table + tbody + tr 各占 1
  });
});
