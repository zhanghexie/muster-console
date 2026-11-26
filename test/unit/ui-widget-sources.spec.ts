import { describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import { runtimeFixture } from './helpers/ui-runtime-fixture';

describe('read-only JSON sources and whitelisted method syntax', () => {
  it('shares table data with expressions without state registration, collisions or persistent copies', async () => {
    const { api, document, errors } = await runtimeFixture(`
      <script type="application/json" id="demo-data">{"rows":[{"id":"a","label":"智能 A"},{"id":"b","label":"普通 B"}],"values":[1,2,3],"name":"智能 Agent"}</script>
      <ma-table source="demo-data"></ma-table>
      <ma-text id="count" expr="count(source('demo-data').rows)"></ma-text>
      <ma-text id="total" expr="sum(source('demo-data').values)"></ma-text>
      <ma-text id="length" expr="source('demo-data').rows.length"></ma-text>
      <ma-text id="match" expr="source('demo-data').name.toUpperCase().includes('智能 AGENT')"></ma-text>`);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(document.querySelector('#count .ma-text-value')!.textContent).toBe('2');
    expect(document.querySelector('#total .ma-text-value')!.textContent).toBe('6');
    expect(document.querySelector('#length .ma-text-value')!.textContent).toBe('2');
    expect(document.querySelector('#match .ma-text-value')!.textContent).toBe('true');
    expect(api.getWidgetState()).toMatchObject({ modelContent: null, privateContent: { values: {} } });
    const source = api.source('demo-data'); expect(Object.isFrozen(source)).toBe(true); expect(Object.isFrozen(source.rows)).toBe(true);
    expect((document.querySelector('ma-table') as any).data).toBe(source);
    const used = api.stateUsage().usedBytes;
    await api.set('demo', '用户选择'); expect(api.get('demo')).toBe('用户选择'); expect(api.source('demo-data')).toBe(source);
    expect(api.stateUsage().usedBytes - used).toBeLessThan(100); expect(errors).toEqual([]);
  });
  it('updates source-backed tables and calculated outputs together, including head scripts and malformed JSON recovery', async () => {
    const { api, document } = await runtimeFixture(`<script type="application/json" id="rows">[{"id":"a"}]</script><ma-table source="rows"></ma-table><ma-text id="n" expr="len(source('rows'))"></ma-text>`);
    const script = document.getElementById('rows')!; document.head.append(script);
    script.textContent = '[{"id":"a"},{"id":"b"},{"id":"c"}]';
    await waitFor(() => expect(document.querySelectorAll('tbody tr')).toHaveLength(3));
    expect(document.querySelector('#n .ma-text-value')!.textContent).toBe('3');
    script.textContent = '{broken';
    await waitFor(() => expect(api.getDiagnostics().some((entry: any) => entry.message.includes('JSON 数据源 rows 格式错误'))).toBe(true));
    script.textContent = '[{"id":"fixed"}]';
    await waitFor(() => expect(api.getDiagnostics()).toEqual([]));
    expect(document.querySelector('#n .ma-text-value')!.textContent).toBe('1');
    expect(document.querySelector('tbody')!.textContent).toContain('fixed');
    script.setAttribute('type', 'text/plain');
    await waitFor(() => expect(api.getDiagnostics().some((entry: any) => entry.message.includes('application/json'))).toBe(true));
    script.setAttribute('type', 'application/json');
    await waitFor(() => expect(api.getDiagnostics()).toEqual([]));
    script.id = 'renamed';
    await waitFor(() => expect(api.getDiagnostics().some((entry: any) => entry.message.includes('JSON 数据源不存在'))).toBe(true));
    script.id = 'rows'; await waitFor(() => expect(api.getDiagnostics()).toEqual([]));
    script.remove(); await waitFor(() => expect(api.getDiagnostics().some((entry: any) => entry.message.includes('JSON 数据源不存在'))).toBe(true));
  });
  it('keeps inline JSON and explicit .data overrides compatible with source refresh', async () => {
    const { api, document } = await runtimeFixture(`<script type="application/json" id="shared">[{"id":"source"}]</script><ma-table id="override" source="shared"></ma-table><ma-table id="inline"><script type="application/json">[{"id":"inline"}]</script></ma-table>`);
    (document.querySelector('#override') as any).data = [{ id: 'override' }];
    await api.set('selection', 1);
    expect(document.querySelector('#inline tbody')!.textContent).toBe('inline'); expect(document.querySelector('#override tbody')!.textContent).toBe('override');
    document.getElementById('shared')!.textContent = '[{"id":"updated-source"}]';
    await waitFor(() => expect(api.source('shared')[0].id).toBe('updated-source'));
    expect(document.querySelector('#override tbody')!.textContent).toBe('override');
  });
  it('recovers tables and lists whose source is invalid or missing at initial mount', async () => {
    const { api, document } = await runtimeFixture(`<script type="application/json" id="bad">{broken</script><ma-table source="bad"></ma-table><ma-list source="later"></ma-list>`);
    expect(api.getDiagnostics()).toHaveLength(2);
    document.getElementById('bad')!.textContent = '[{"id":"a","label":"恢复"}]';
    const later = document.createElement('script'); later.type = 'application/json'; later.id = 'later'; later.textContent = '[{"id":"b","label":"后加入"}]'; document.head.append(later);
    await waitFor(() => expect(api.getDiagnostics()).toEqual([]));
    expect(document.querySelector('tbody')!.textContent).toContain('恢复'); expect(document.querySelector('ma-list')!.textContent).toContain('后加入');
    later.textContent = '{broken'; await waitFor(() => expect(api.getDiagnostics()).toHaveLength(1));
    later.textContent = '[{"id":"b","label":"后加入"}]'; await waitFor(() => expect(api.getDiagnostics()).toEqual([]));
  });
  it('maps only approved methods and retains property access, short circuit and private dependency tracking', async () => {
    const { api, document } = await runtimeFixture(`<ma-input name="name" value=" 智能 Agent " private></ma-input><ma-text name="upperName" expr="name.trim().toUpperCase()"></ma-text>`);
    const values: any = { name: '智能 Agent', rows: ['a', 'b'], selected: { name: 'Hello' }, number: 7 };
    const calculate = (text: string) => api.expression.compile(text).evaluate((key: string) => key === 'rows.length' ? values.rows.length : key === 'selected.name' ? values.selected.name : values[key]);
    expect(calculate('name.includes("智能")')).toBe(true); expect(calculate('name.toUpperCase()')).toBe('智能 AGENT');
    expect(calculate('rows.includes("b")')).toBe(true); expect(calculate('selected.name.toLowerCase()')).toBe('hello');
    expect(calculate('rows.includes("a", 1)')).toBe(false); expect(calculate('name.includes("智能", 2)')).toBe(false);
    expect(calculate('rows.length')).toBe(2); expect(calculate('(" A ").trim().toLowerCase()')).toBe('a');
    expect(() => calculate('false && name.sort()')).toThrow('不支持的方法'); // Dead branches still validate method names.
    expect(api.get('upperName')).toBe('智能 AGENT'); expect(api.getWidgetState().modelContent?.upperName).toBeUndefined();
    expect(document.querySelector('ma-text .ma-text-value')!.textContent).toBe('智能 AGENT');
    expect(() => calculate('number.toUpperCase()')).toThrow('类型不正确');
    expect(() => calculate('rows.sort()')).toThrow('不支持的方法'); expect(() => calculate('rows.constructor()')).toThrow('字段无效');
  });
  it('reports missing/non-JSON sources, unsafe members, unknown methods and bounded chains with actionable hints', async () => {
    const { api } = await runtimeFixture('<div id="not-json">[]</div><script type="application/json" id="nested">{"constructor":{"value":1},"name":" A "}</script>');
    const calculate = (text: string) => api.expression.compile(text).evaluate(() => undefined);
    expect(() => calculate('source("missing")')).toThrow('不存在'); expect(() => calculate('source("not-json")')).toThrow('application/json');
    expect(() => calculate('source("nested").constructor.value')).toThrow('字段无效');
    expect(() => calculate('source("nested").name.replace("A","B")')).toThrow('不支持的方法');
    expect(() => calculate('source("nested").missing')).toThrow('数据中不存在字段');
    expect(() => calculate('source("nested").name' + '.trim()'.repeat(40))).toThrow('32 层');
    try { calculate('source("nested").name.toString()'); } catch (error: any) { expect(error.diagnostic).toMatchObject({ code: 'expression_method' }); expect(error.diagnostic.hint).toContain('.toUpperCase()'); }
  });
});
