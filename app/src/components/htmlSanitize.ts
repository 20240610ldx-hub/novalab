/**
 * htmlSanitize.ts — 内核 text/html 输出的白名单重建（ADR-011）。
 *
 * 内核经 `_repr_html_()` 给出的 HTML 是不可信输入（数据内容可经劣质 repr 未转义地
 * 流入标签）。这里不"过滤字符串"，而是**解析后重建**：
 *   DOMParser（脱离页面的文档；解析期脚本/网络行为须在目标浏览器验收）→ 遍历节点树 →
 *   只产出白名单标签 + 两个整数属性的 SafeHtmlNode 树 → React createElement 渲染。
 * 重建阶段不把 HTML 串回写进 DOM（无 innerHTML / dangerouslySetInnerHTML），避开
 * 消毒后回写字符串的 mutation-XSS 路径；输出树不保留带 URL 的属性、style / class /
 * id / on* 或脚本/资源标签。解析期行为仍须由目标浏览器验收，不能从输出树反推。
 *
 * 遍历函数对结构化节点接口 HtmlNodeLike 编程（DOM Node 结构兼容），无 DOM 依赖，
 * 可在 node 环境单测（htmlSanitize.test.ts）。
 */

/** DOM Node 的结构子集（Element 才有 getAttribute）。 */
export interface HtmlNodeLike {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly nodeValue: string | null;
  readonly childNodes: ArrayLike<HtmlNodeLike>;
  getAttribute?(name: string): string | null;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** 表格结构标签：其直接子级的纯空白文本要丢弃（否则 React 报非法嵌套）。 */
const TABLE_STRUCTURE = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup']);

/** 白名单：表格族 + 行内格式 + 最小块级容器。其余标签一律不产出。 */
const ALLOWED_TAGS = new Set([
  ...TABLE_STRUCTURE,
  'th', 'td', 'caption', 'col',
  'b', 'strong', 'i', 'em', 'u', 's', 'code', 'kbd', 'samp', 'sub', 'sup', 'small', 'mark', 'span',
  'div', 'p', 'pre', 'br', 'hr', 'ul', 'ol', 'li',
]);

const VOID_TAGS = new Set(['br', 'hr', 'col']);

/**
 * 连同子树整体丢弃：其文本内容不是给人看的正文（脚本 / 样式源码），或本身是
 * 嵌入 / 表单面。不在此表也不在白名单的标签 → 解包（丢标签、留子节点文本）。
 */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'template', 'noscript', 'title', 'head',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'svg', 'math', 'canvas', 'audio', 'video', 'picture', 'img',
  'form', 'input', 'button', 'select', 'option', 'textarea',
  'link', 'meta', 'base',
]);

/** 单次输出的节点预算：内核侧 html 上限 1e6 字符，仍可能是数万单元格，防渲染卡死。 */
export const MAX_HTML_NODES = 20_000;
/** colspan / rowspan 上限（HTML 规范 colspan 上限即 1000）。 */
const MAX_SPAN = 1000;

export type SafeHtmlNode =
  | string
  | { tag: string; colSpan?: number; rowSpan?: number; children: SafeHtmlNode[] };

export interface SafeHtml {
  nodes: SafeHtmlNode[];
  /** 产出过 <table>。 */
  hasTable: boolean;
  /** 产出过非空白文本。 */
  hasText: boolean;
  /** 触达 MAX_HTML_NODES，后续节点被截掉。 */
  truncated: boolean;
}

function spanAttr(node: HtmlNodeLike, name: string): number | undefined {
  const raw = node.getAttribute?.(name);
  if (raw == null || !/^\d{1,4}$/.test(raw.trim())) return undefined;
  const n = Number(raw.trim());
  return n >= 2 && n <= MAX_SPAN ? n : undefined;
}

/** 节点列表 → 白名单树。纯函数，不触碰 DOM API 之外的任何全局。 */
export function sanitizeHtmlNodes(roots: ArrayLike<HtmlNodeLike>): SafeHtml {
  const res: SafeHtml = { nodes: [], hasTable: false, hasText: false, truncated: false };
  let budget = MAX_HTML_NODES;

  const walk = (list: ArrayLike<HtmlNodeLike>, parentTag: string | null, out: SafeHtmlNode[]): void => {
    for (let i = 0; i < list.length; i++) {
      const node = list[i]!;
      if (budget <= 0) {
        res.truncated = true;
        return;
      }
      if (node.nodeType === TEXT_NODE) {
        const text = node.nodeValue ?? '';
        const blank = text.trim() === '';
        if (text === '' || (blank && parentTag !== null && TABLE_STRUCTURE.has(parentTag))) continue;
        if (!blank) res.hasText = true;
        budget--;
        out.push(text);
        continue;
      }
      if (node.nodeType !== ELEMENT_NODE) continue; // 注释 / CDATA / PI：丢弃
      const tag = node.nodeName.toLowerCase();
      if (DROP_WITH_CONTENT.has(tag)) continue;
      if (!ALLOWED_TAGS.has(tag)) {
        walk(node.childNodes, parentTag, out); // 解包：标签丢、正文留
        continue;
      }
      budget--;
      const el: Exclude<SafeHtmlNode, string> = { tag, children: [] };
      if (tag === 'td' || tag === 'th') {
        const colSpan = spanAttr(node, 'colspan');
        const rowSpan = spanAttr(node, 'rowspan');
        if (colSpan !== undefined) el.colSpan = colSpan;
        if (rowSpan !== undefined) el.rowSpan = rowSpan;
      }
      if (tag === 'table') res.hasTable = true;
      if (!VOID_TAGS.has(tag)) walk(node.childNodes, tag, el.children);
      out.push(el);
    }
  };

  walk(roots, null, res.nodes);
  return res;
}

/**
 * 是否值得用 HTML 渲染（否则回落 text/plain）。白名单只保留表格 / 行内格式，
 * 所以只对"表格型" repr 成立：pandas / polars DataFrame、statsmodels summary 等。
 * 依赖脚本或大量 CSS 的 repr（plotly、xarray、sklearn）消毒后只剩碎片，
 * 回落到 text/plain 反而更可读。
 */
export function isRenderableHtml(safe: SafeHtml): boolean {
  return safe.hasTable && safe.hasText;
}

/** HTML 串 → 白名单树。仅浏览器可用（DOMParser）；无 DOM 环境返回空树。 */
export function parseSafeHtml(html: string): SafeHtml {
  if (typeof DOMParser === 'undefined') {
    return { nodes: [], hasTable: false, hasText: false, truncated: false };
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return sanitizeHtmlNodes(doc.body.childNodes);
}
