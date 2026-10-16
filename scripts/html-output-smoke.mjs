#!/usr/bin/env node
/** Browser acceptance of the real HTML parser and OutputRenderer (A08).
 * Start the app with the preview launcher, then pass its URL. No Bridge/provider
 * is needed. All synthetic outbound requests are intercepted before networking.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const appURL = process.argv[2] ?? 'http://127.0.0.1:5299/';
const origin = new URL(appURL).origin;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const attempted = [];
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/*', (route) => {
  const url = new URL(route.request().url());
  if (url.origin === origin) return route.continue();
  if (url.hostname === 'novalab-output-sentinel.invalid') attempted.push(url.pathname);
  return route.abort();
});

try {
  await page.goto(appURL);
  const result = await page.evaluate(async () => {
    const react = await import('/node_modules/.vite/deps/react.js');
    const reactDOM = await import('/node_modules/.vite/deps/react-dom_client.js');
    const createElement = (react.default ?? react).createElement;
    const createRoot = (reactDOM.default ?? reactDOM).createRoot;
    const { OutputRenderer } = await import('/src/components/OutputRenderer.tsx');
    const { parseSafeHtml } = await import('/src/components/htmlSanitize.ts');
    // Isolate the renderer while retaining real application CSS and modules.
    const host = document.createElement('main');
    document.body.replaceChildren(host);
    const root = createRoot(host);
    const output = (html, plain = 'PLAIN_FALLBACK_SENTINEL') => ({
      stdout: '', stderr: '', traceback: null, writes: [],
      mime: { 'text/html': html, 'text/plain': plain },
    });
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const render = async (html) => { root.render(createElement(OutputRenderer, { output: output(html) })); await frame(); };
    const sentinel = 'https://novalab-output-sentinel.invalid';
    const malicious = `<base href="${sentinel}/base/"><link rel="stylesheet" href="${sentinel}/style">
      <meta http-equiv="refresh" content="0;url=${sentinel}/redirect">
      <style>@import url('${sentinel}/css');</style>
      <script>window.__nlHtmlExecuted = true</script>
      <img src="${sentinel}/image" onerror="window.__nlHtmlExecuted = true">
      <iframe src="${sentinel}/frame" srcdoc="&lt;script&gt;parent.__nlHtmlExecuted=true&lt;/script&gt;"></iframe>
      <svg onload="window.__nlHtmlExecuted=true"><image href="${sentinel}/svg"></image></svg>
      <object data="${sentinel}/object"></object><form action="${sentinel}/form"><input></form>
      <table id="evil" class="evil" style="background-image:url('${sentinel}/inline')" onclick="window.__nlHtmlExecuted=true">
      <tr><td colspan="2" rowspan="3"><a href="javascript:window.__nlHtmlExecuted=true">SAFE_TABLE_TEXT</a></td></tr></table>`;
    const safe = parseSafeHtml(malicious);
    await render(malicious);
    const table = host.querySelector('table');
    table?.click();
    const forbidden = host.querySelectorAll('script,img,iframe,svg,math,object,form,input,link,meta,base,a').length;
    const attrs = [...host.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.name));
    const stripped = !attrs.some((name) => name.startsWith('on') || ['href', 'src', 'srcdoc', 'action', 'style', 'id'].includes(name));
    const cell = host.querySelector('td');
    const rich = host.textContent.includes('SAFE_TABLE_TEXT') && !host.textContent.includes('PLAIN_FALLBACK_SENTINEL');
    const spans = cell?.colSpan === 2 && cell?.rowSpan === 3;
    const dark = getComputedStyle(host.querySelector('.nl-out-panel')).backgroundColor;
    document.documentElement.dataset.theme = 'light';
    await frame();
    const light = getComputedStyle(host.querySelector('.nl-out-panel')).backgroundColor;
    const themed = dark !== light;
    await render('<div>not a table</div>');
    const fallback = host.textContent.includes('PLAIN_FALLBACK_SENTINEL') && host.textContent.includes('unrendered mime: text/html');
    await render('<table><tr><td><img src="' + sentinel + '/empty"></td></tr></table>');
    const emptyFallback = host.textContent.includes('PLAIN_FALLBACK_SENTINEL');
    const large = '<table><tbody>' + '<tr><td>row</td></tr>'.repeat(8_000) + '</tbody></table>';
    await render(large);
    const truncated = host.textContent.includes('html output truncated');
    const panel = host.querySelector('.nl-out-panel');
    const longScroll = panel.scrollHeight > panel.clientHeight && getComputedStyle(panel).overflowY === 'auto';
    await render('<table><tr><td>' + 'wide'.repeat(800) + '</td></tr></table>');
    const widePanel = host.querySelector('.nl-out-panel');
    const wideScroll = widePanel.scrollWidth > widePanel.clientWidth && getComputedStyle(widePanel).overflowX === 'auto';
    // A distinct deeply nested input tests that the parser/traversal budget is bounded.
    let deepError = null;
    try { parseSafeHtml('<table><tr><td>' + '<span>'.repeat(12_000) + 'deep' + '</span>'.repeat(12_000) + '</td></tr></table>'); }
    catch (error) { deepError = String(error); }
    const scriptExecuted = window.__nlHtmlExecuted === true;
    root.unmount();
    return { parserRenderable: safe.hasTable && safe.hasText, rich, forbidden, stripped, spans, themed, fallback, emptyFallback, truncated, longScroll, wideScroll, scriptExecuted, deepError };
  });
  await page.waitForTimeout(100);
  console.log(JSON.stringify({ ...result, outboundAttempts: attempted.length, pageErrors: errors.length }, null, 2));
  for (const key of ['parserRenderable', 'rich', 'stripped', 'spans', 'themed', 'fallback', 'emptyFallback', 'truncated', 'longScroll', 'wideScroll']) assert.equal(result[key], true, key);
  assert.equal(result.forbidden, 0, 'no executable or URL-bearing nodes');
  assert.equal(result.scriptExecuted, false, 'scripts and event handlers must not execute');
  assert.equal(result.deepError, null, 'deep HTML must not crash traversal');
  assert.deepEqual(attempted, [], 'parsing and rendering must not attempt outbound requests');
  assert.deepEqual(errors, [], 'no renderer errors');
  console.log('HTML_OUTPUT_SMOKE_OK');
} finally {
  await browser.close();
}
