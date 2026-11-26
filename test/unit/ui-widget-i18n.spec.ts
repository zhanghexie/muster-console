import fs from 'node:fs';
import { expect, it } from 'vitest';

const environment = (globalThis as any).jsdom;
const JSDOM = environment.constructor;
const scripts = ['bridge', 'expressions', 'components', 'data-components', 'advanced-components'].map(name => fs.readFileSync(`src/main/uiRuntime/${name}.js`, 'utf8'));

it('localizes runtime-owned controls without modifying author text, input, or raw diagnostics', async () => {
  let appearance: (value: unknown) => void = () => { throw new Error('appearance listener was not installed'); };
  const dom = new JSDOM(`<!doctype html><html lang="zh-CN"><head>${scripts.map(code => `<script>${code}</script>`).join('')}</head><body><main id="ma-ui-content">
    <ma-button id="default"></ma-button><ma-button id="author" label="继续"></ma-button>
    <ma-input id="input" name="draft" label="作者标签" value="原文"></ma-input>
    <ma-text id="broken" expr="1 / 0"></ma-text>
    <ma-table id="table" page-size="1"><script type="application/json">{"columns":[{"key":"name","label":"作者列"}],"rows":[{"name":"第一项"},{"name":"第二项"}]}</script></ma-table>
    <ma-list id="list" variant="steps"><script type="application/json">[{"id":"a","label":"作者项目","status":"done"},{"id":"b","label":"实现","status":"doing"},{"id":"c","label":"计划","status":"todo"},{"id":"d","label":"阻塞","status":"blocked"},{"id":"e","label":"自定义","status":"已完成"}]</script></ma-list>
    <ma-date-range id="dates"></ma-date-range><ma-file id="file"></ma-file>
  </main></body></html>`, {
    url: 'https://fixture.invalid/widget', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window: any) {
      Object.assign(window, { TextEncoder, ResizeObserver: class { observe() {} disconnect() {} } });
      window.__maUiHost = { read: async () => ({ state: { modelContent: {}, privateContent: {}, revision: 0 } }),
        save: async () => ({ state: { modelContent: {}, privateContent: {}, revision: 1 } }),
        onAppearance: (callback: (value: unknown) => void) => { appearance = callback; }, onState() {}, receipt: async () => {} };
    }
  });
  try {
    await new Promise<void>(resolve => dom.window.addEventListener('load', () => resolve(), { once: true }));
    await dom.window.maUi.whenReady();
    await new Promise(resolve => setTimeout(resolve, 0));
    const doc = dom.window.document, input = doc.querySelector('#input input');
    input.value = '用户输入'; input.focus();
    const diagnostics = JSON.stringify(dom.window.maUi.getDiagnostics());
    expect(diagnostics).toContain('除数不能为零');
    appearance({ locale: 'en' });
    expect(doc.querySelector('#default button').textContent).toBe('Continue');
    expect(doc.querySelector('#author button').textContent).toBe('继续');
    expect(doc.querySelector('#table .ma-table-pager button:last-child').textContent).toBe('Next');
    expect(doc.querySelector('#table th').textContent).toContain('作者列');
    expect(Array.from(doc.querySelectorAll('#list .ma-badge'), (node: any) => node.textContent)).toEqual(['Done', 'In progress', 'Not started', 'Blocked', '已完成']);
    expect(doc.querySelector('#dates label').textContent).toContain('Start date');
    expect(doc.querySelector('#file .ma-file-summary').textContent).toBe('No file selected');
    expect(doc.querySelector('#broken [role=alert]').textContent).toContain('Cannot divide by zero');
    expect(dom.window.maUi.displayError(new dom.window.Error('除数不能为零'))).toBe('除数不能为零');
    expect(JSON.stringify(dom.window.maUi.getDiagnostics())).toBe(diagnostics);
    expect(doc.querySelector('#input input')).toBe(input);
    expect(input.value).toBe('用户输入');
    expect(doc.activeElement).toBe(input);
    appearance({ theme: 'dark' });
    expect(doc.querySelector('#default button').textContent).toBe('Continue');
    dom.window.maUi.warn(dom.window.maUi.ownedError('交互状态名称无效'));
    expect(doc.querySelector('#ma-ui-warning').textContent).toBe('Invalid interactive state name');
    appearance({ locale: 'zh-CN' });
    expect(doc.querySelector('#default button').textContent).toBe('继续');
    expect(doc.querySelector('#file .ma-file-summary').textContent).toBe('尚未选择文件');
    expect(doc.querySelector('#ma-ui-warning').textContent).toBe('交互状态名称无效');
  } finally { dom.window.close(); }
});
