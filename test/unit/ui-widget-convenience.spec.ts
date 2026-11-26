import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

type WidgetState = { modelContent: Record<string, unknown> };
type WidgetApi = {
  get(key: string): unknown;
  set(key: string, value: unknown): Promise<unknown>;
  getWidgetState(): WidgetState;
  setWidgetState(state: WidgetState): Promise<unknown>;
  expression: { compile(text: string): { evaluate(read: (key: string) => unknown): unknown } };
};
type FixtureConsole = { on(event: string, listener: (error: Error) => void): void };
type FixtureWindow = Window & typeof globalThis & { maUi: WidgetApi; _virtualConsole: FixtureConsole };
type FixtureDom = { window: FixtureWindow };
type FixtureOptions = { url: string; runScripts: string; pretendToBeVisual: boolean; virtualConsole: FixtureConsole; beforeParse(window: FixtureWindow): void };
type DomConstructor = new (html: string, options: FixtureOptions) => FixtureDom;

const scripts = ['bridge', 'expressions', 'components', 'data-components'].map(name => fs.readFileSync(`src/main/uiRuntime/${name}.js`, 'utf8'));
// Reuse constructors already loaded by Vitest's environment, outside its VM module transformer.
const environment = (globalThis as unknown as { jsdom: FixtureDom }).jsdom;
const JSDOM = environment.constructor as DomConstructor;
const VirtualConsole = environment.window._virtualConsole.constructor as new () => FixtureConsole;
const windows: FixtureDom[] = [];
async function fixture(html: string) {
  const errors: string[] = [], console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(`<!doctype html><html lang="zh-CN"><head>${scripts.map(code => `<script>${code}</script>`).join('')}</head><body><main id="ma-ui-content">${html}</main></body></html>`, {
    url: 'https://fixture.invalid/convenience', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: console,
    beforeParse(window) { Object.assign(window, { TextEncoder, ResizeObserver: class { observe() {} disconnect() {} } }); }
  });
  windows.push(dom);
  await new Promise(resolve => dom.window.addEventListener('load', resolve, { once: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  return { document: dom.window.document, api: dom.window.maUi, window: dom.window, errors };
}
afterEach(() => { windows.splice(0).forEach(dom => dom.window.close()); });

describe('declarative widget convenience', () => {
  it('renders text attributes and retains explicit value and bound-state precedence', async () => {
    const { api, document, errors } = await fixture(`
      <ma-text id="static" text="说明文字"></ma-text>
      <ma-text id="value" value="显式值" text="备用属性">子文本</ma-text>
      <ma-text id="empty" value="" text="不能覆盖空值"></ma-text>
      <ma-text id="child">子文本</ma-text>
      <ma-text id="bound" bind="selected" text="尚未选择"></ma-text>
      <ma-text id="fallback" bind="missing" text="静态" fallback="显式备用"></ma-text>
      <ma-badge id="badge" bind="selected" text="备用标签"></ma-badge>`);
    const text = (id: string) => document.querySelector(`#${id} .ma-text-value`)!.textContent;
    expect(text('static')).toBe('说明文字'); expect(text('value')).toBe('显式值');
    expect(text('empty')).toBe(''); expect(text('child')).toBe('子文本');
    expect(text('bound')).toBe('尚未选择'); expect(text('fallback')).toBe('显式备用');
    expect(document.querySelector('#badge')!.textContent).toBe('备用标签');
    await api.set('selected', '已选择'); expect(text('bound')).toBe('已选择');
    expect(document.querySelector('#badge')!.textContent).toBe('已选择');
    expect(errors).toEqual([]);
  });
  it('calculates and formats without author JavaScript, supports chained outputs and restores inputs', async () => {
    const { api, document, window, errors } = await fixture(`
      <ma-input name="price" label="单价" type="number" value="80"></ma-input>
      <ma-input name="quantity" label="数量" type="number" value="3"></ma-input>
      <ma-text id="subtotal" name="subtotal" expr="price * quantity" format="number" digits="2" unit="元" variant="metric" label="合计"></ma-text>
      <ma-text id="final" name="final" expr="round(subtotal * 0.9, 2)"></ma-text>
      <ma-text id="percent" value="0.7" format="percent" digits="0" trend="数量 {quantity}" tone="success"></ma-text>`);
    expect(document.querySelector('#subtotal .ma-text-value')!.textContent).toBe('240.00 元');
    expect(api.get('final')).toBe(216); expect(document.querySelector('#percent .ma-text-value')!.textContent).toBe('70%');
    expect(document.querySelector('#percent .ma-text-trend')!.textContent).toBe('数量 3');
    const saved = api.getWidgetState(), input = document.querySelector('ma-input input') as HTMLInputElement;
    input.value = '100'; input.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(api.get('final')).toBe(270);
    await api.setWidgetState(saved); expect(api.get('final')).toBe(216); expect(input.value).toBe('80');
    expect(errors).toEqual([]);
  });
  it('shows recoverable calculation errors and clears stale outputs; private dependencies stay private', async () => {
    const { api, document } = await fixture(`
      <ma-input name="secret" label="私人单价" type="number" value="6" private></ma-input>
      <ma-input name="divisor" label="份数" type="number" value="2"></ma-input>
      <ma-text id="result" name="result" expr="secret / divisor" format="number" digits="1"></ma-text>`);
    expect(api.get('result')).toBe(3); expect(api.getWidgetState().modelContent.result).toBeUndefined();
    await api.set('divisor', 0);
    expect(document.querySelector('#result [role=alert]')!.textContent).toContain('除数不能为零'); expect(api.get('result')).toBeNull();
    await api.set('divisor', 3);
    expect(document.querySelector('#result [role=alert]')!.getAttribute('hidden')).not.toBeNull();
    expect(api.get('result')).toBe(2); expect(api.getWidgetState().modelContent.result).toBeUndefined();
  });
  it('supports bounded expressions, Unicode names and conditional branches without dynamic code', async () => {
    const { api } = await fixture('');
    const evaluate = (text: string, state: Record<string, unknown> = {}) => api.expression.compile(text).evaluate((key: string) => state[key]);
    expect(evaluate('月数 > 3 ? round(pow(2, 月数) / 3, 2) : 0', { 月数: 4 })).toBe(5.33);
    expect(evaluate('mode == "annual" ? 80 : 100', { mode: 'annual' })).toBe(80);
    expect(evaluate('false && missing')).toBe(false);
    expect(evaluate('mode ? 10 : 20', { mode: '0' })).toBe(20);
    expect(evaluate('mode == 1', { mode: '1.0' })).toBe(true);
    for (const text of ['window.alert(1)', 'constructor(1)', 'price = 7', '1 +', '('.repeat(40) + '1' + ')'.repeat(40)]) expect(() => api.expression.compile(text)).toThrow();
    expect(() => evaluate('1 / 0')).toThrow(); expect(() => evaluate('pow(10, 1000)')).toThrow();
  });
  it('reports circular calculated bindings instead of recursing', async () => {
    const { document, api } = await fixture('<ma-text id="a" name="a" expr="b + 1"></ma-text><ma-text id="b" name="b" expr="a + 1"></ma-text>');
    expect(document.querySelector('#a [role=alert]')!.textContent).toContain('循环引用');
    expect(document.querySelector('#b [role=alert]')!.textContent).toContain('循环引用');
    expect(api.get('a')).toBeUndefined();
  });
  it('segmented selection shares the select state, skips disabled options and supports keyboard restoration', async () => {
    const { api, document, window } = await fixture(`<ma-select id="mode" name="mode" label="模式" appearance="segmented" value="a"><option value="a">标准</option><option value="b" disabled>不可用</option><option value="c">增强</option></ma-select>`);
    const radios = document.querySelectorAll<HTMLButtonElement>('[role=radio]');
    expect(document.querySelector('[role=radiogroup]')!.getAttribute('aria-labelledby')).toBe('mode-label');
    expect(radios[0].getAttribute('aria-checked')).toBe('true'); expect(radios[1].disabled).toBe(true);
    const saved = api.getWidgetState(); radios[0].focus(); radios[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(api.get('mode')).toBe('c'); expect(document.activeElement).toBe(radios[2]); expect(radios[2].tabIndex).toBe(0);
    await api.setWidgetState(saved); expect(radios[0].getAttribute('aria-checked')).toBe('true');
  });
  it('comparison and details share the table renderer with recommendation, formatted cells and no default sort controls', async () => {
    const { document, errors } = await fixture(`
      <ma-table id="compare" variant="comparison"><script type="application/json">{"columns":[{"key":"label","label":"维度"},{"key":"a","label":"A","recommended":true},{"key":"b","label":"B"}],"rows":[{"label":"适配","a":["适合","success"],"b":["一般","neutral"]}]}</script></ma-table>
      <ma-table id="details" variant="details"><script type="application/json">{"环境":"生产","数量":0}</script></ma-table>
      <ma-table id="formatted"><script type="application/json">{"columns":[{"key":"ratio","format":"percent","digits":0},{"key":"cost","format":"number","digits":2,"unit":"元"}],"rows":[{"ratio":0.7,"cost":20}]}</script></ma-table>`);
    expect(document.querySelector('#compare .is-recommended .ma-badge')!.textContent).toBe('推荐');
    expect(document.querySelector('#compare tbody td.is-recommended .ma-badge')!.getAttribute('data-tone')).toBe('success');
    expect(document.querySelector('#compare .ma-sort-button')).toBeNull();
    expect(document.querySelector('#details thead')!.hasAttribute('hidden')).toBe(true);
    expect(document.querySelectorAll('#details tbody th[scope=row]')).toHaveLength(2); expect(document.querySelector('#details tbody tr:last-child')!.textContent).toBe('数量0');
    expect(Array.from(document.querySelectorAll('#formatted tbody td'), cell => cell.textContent)).toEqual(['70%', '20.00 元']);
    expect(errors).toEqual([]);
  });
  it('steps and checklist share a list, preserve checkbox focus and restore completion including initially done items', async () => {
    const { api, document } = await fixture(`
      <script type="application/json" id="tasks">[{"id":"a","label":"设计","status":"done"},{"id":"b","label":"实现","status":"doing","description":"完善接口","progress":50,"date":"10-13"}]</script>
      <ma-list id="steps" source="tasks" variant="steps" completion="doneTasks" label="进度"></ma-list>
      <ma-list id="todo" source="tasks" variant="checklist" name="doneTasks" label="待办"></ma-list>`);
    expect(document.querySelector('#steps progress')!.getAttribute('value')).toBe('50');
    const checks = document.querySelectorAll<HTMLInputElement>('#todo input'); expect(checks[0].checked).toBe(true);
    const saved = api.getWidgetState(); checks[1].focus(); checks[1].click();
    expect(api.get('doneTasks')).toEqual(['a', 'b']); expect(document.activeElement).toBe(checks[1]);
    expect(document.querySelector('#steps li:last-child')!.getAttribute('data-status')).toBe('done');
    expect(document.querySelector('#steps progress')!.getAttribute('value')).toBe('100');
    checks[0].click(); expect(api.get('doneTasks')).toEqual(['b']);
    await api.setWidgetState(saved); expect(checks[0].checked).toBe(true); expect(checks[1].checked).toBe(false);
    expect(document.querySelector('#steps progress')!.getAttribute('value')).toBe('50');
    expect(document.querySelector('#todo input')).toBe(checks[0]);
  });
  it('native radio bindings retain option values and follow the shared selection', async () => {
    const { api, document } = await fixture('<input type="radio" name="choice" value="a" data-ma-bind="choice" checked><input type="radio" name="choice" value="b" data-ma-bind="choice">');
    const radios = document.querySelectorAll<HTMLInputElement>('input');
    await api.set('choice', 'b'); expect(radios[1].checked).toBe(true); expect(radios[0].value).toBe('a'); expect(radios[1].value).toBe('b');
  });
});
