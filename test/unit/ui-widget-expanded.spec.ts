import { describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import { runtimeFixture } from './helpers/ui-runtime-fixture';
import { UI_WIDGET_STATE_MAX_BYTES } from '../../src/shared/uiWidgetProtocol';

describe('expanded interactive UI runtime', () => {
  it('supports string/array functions and strict equality without eval or prototype access', async () => {
    const { api } = await runtimeFixture('');
    const values: any = { a: '2', rows: [{ status: 'done' }, { status: 'todo' }], title: 'Alpha' };
    const calculate = (text: string) => api.expression.compile(text).evaluate((key: string) => values[key]);
    expect(calculate('a === 2')).toBe(false); expect(calculate('a !== 2')).toBe(true); expect(calculate('a == 2')).toBe(true);
    expect(calculate('count(rows, "status", "done")')).toBe(1); expect(calculate('count(rows)')).toBe(2);
    expect(calculate('concat("合计", a, "项")')).toBe('合计2项'); expect(calculate('"合计" + a + "项"')).toBe('合计2项');
    expect(calculate('includes(lower(title), "pha")')).toBe(true); expect(calculate('len(trim(" hi "))')).toBe(2);
    expect(() => calculate('constructor(1)')).toThrow(); expect(() => calculate('rows.__proto__')).toThrow();
    expect(() => calculate('true ? '.repeat(40) + '1' + ' : 0'.repeat(40))).toThrow();
  });
  it('pinpoints separate compile failures and recovers runtime diagnostics on valid input', async () => {
    const { api, document } = await runtimeFixture('<ma-input name="n" type="number" value="2"></ma-input><ma-text id="bad-a" expr="n @ 2"></ma-text><ma-text id="bad-b" expr="n @ 3"></ma-text><ma-text id="division" expr="1 / n"></ma-text>');
    const diagnostics = api.getDiagnostics(); expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((entry: any) => entry.id)).toEqual(['bad-a', 'bad-b']);
    expect(diagnostics[0]).toMatchObject({ attribute: 'expr', code: 'expression_character', position: 3, expression: 'n @ 2' });
    expect(document.querySelector('#bad-a [role=alert]')!.textContent).toContain('bad-a');
    expect((document.querySelector('#bad-a [role=alert]') as HTMLElement).hidden).toBe(false);
    await api.set('n', 0); expect(api.getDiagnostics().some((entry: any) => entry.id === 'division')).toBe(true);
    await api.set('n', 4); expect(api.getDiagnostics().some((entry: any) => entry.id === 'division')).toBe(false);
  });
  it('binds tone to expressions and state, rejecting invalid colors and recovering', async () => {
    const { api, document } = await runtimeFixture('<ma-input name="n" type="number" value="2"></ma-input><ma-badge id="tone" tone-expr="n >= 2 ? \'success\' : \'warning\'">状态</ma-badge><ma-badge id="bound" tone-bind="color"></ma-badge>');
    expect((document.querySelector('#tone') as HTMLElement).dataset.tone).toBe('success');
    await api.set('n', 1); expect((document.querySelector('#tone') as HTMLElement).dataset.tone).toBe('warning');
    await api.set('color', 'red'); expect(document.querySelector('#bound')!.getAttribute('aria-invalid')).toBe('true');
    await api.set('color', 'info'); expect((document.querySelector('#bound') as HTMLElement).dataset.tone).toBe('info');
    expect(document.querySelector('#bound')!.hasAttribute('aria-invalid')).toBe(false);
  });
  it('keeps 1000 selected IDs compact, restores compact public values, and refuses oversized writes atomically', async () => {
    const { api } = await runtimeFixture(''); const ids = Array.from({ length: 1000 }, (_, i) => 'record-' + i);
    await api.set('checked', ids); expect(api.stateUsage().usedBytes).toBeLessThan(16000); expect(api.stateUsage().maxBytes).toBe(UI_WIDGET_STATE_MAX_BYTES);
    const saved = api.getWidgetState(); saved.privateContent.values = {}; await api.setWidgetState(saved); expect(api.get('checked')).toEqual(ids);
    await expect(api.set('checked', 'x'.repeat(300000))).rejects.toThrow('256 KiB'); expect(api.get('checked')).toEqual(ids);
  });
  it('validates date ranges without persisting invalid dates and supports correction/restoration', async () => {
    const { api, document, window } = await runtimeFixture('<ma-date-range name="dates" label="出行" min="2026-01-01" max="2026-12-31"></ma-date-range>');
    const inputs = document.querySelectorAll<HTMLInputElement>('ma-date-range input');
    const change = (index: number, text: string) => { inputs[index].value = text; inputs[index].dispatchEvent(new window.Event('input', { bubbles: true })); };
    change(0, '2026-10-26'); change(1, '2026-10-25'); expect(api.get('dates').end).toBe('');
    expect(document.querySelector('ma-date-range [role=alert]')!.textContent).toContain('开始日期不能晚于结束日期');
    change(1, '2026-10-28'); expect(api.get('dates')).toEqual({ start: '2026-10-26', end: '2026-10-28' });
    const saved = api.getWidgetState(); change(1, '2026-11-01'); await api.setWidgetState(saved); expect(inputs[1].value).toBe('2026-10-28');
  });
  it('resets dependent cascade choices and supports native tree expansion, keyboard and multi-selection', async () => {
    const data = [{ value: 'a', label: 'A', children: [{ value: 'a1', label: 'A1' }] }, { value: 'b', label: 'B' }];
    const { api, document, window, errors } = await runtimeFixture(`<script id="nodes" type="application/json">${JSON.stringify(data)}</script><ma-cascade name="location" source="nodes"></ma-cascade><ma-tree name="tree" source="nodes" multiple></ma-tree>`);
    let select = document.querySelector('ma-cascade select') as HTMLSelectElement; select.value = 'a'; select.dispatchEvent(new window.Event('change'));
    select = document.querySelectorAll<HTMLSelectElement>('ma-cascade select')[1]; select.value = 'a1'; select.dispatchEvent(new window.Event('change')); expect(api.get('location')).toEqual(['a', 'a1']);
    select = document.querySelector('ma-cascade select') as HTMLSelectElement; select.value = 'b'; select.dispatchEvent(new window.Event('change')); expect(api.get('location')).toEqual(['b']); expect(document.querySelectorAll('ma-cascade select')).toHaveLength(1);
    const tree = document.querySelectorAll<HTMLInputElement>('ma-tree input'); tree[0].focus(); tree[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.querySelector('ma-tree details')!.hasAttribute('open')).toBe(true);
    tree[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); expect(document.activeElement).toBe(tree[1]);
    tree[1].click(); expect(api.get('tree')).toEqual(['a1']); expect(api.getWidgetState().modelContent.tree).toEqual(['a1']); expect(errors).toEqual([]);
  });
  it('imports validated UTF-8 files privately until explicit sharing, and rejects invalid/oversized files', async () => {
    const { api, document, window } = await runtimeFixture('<ma-file name="files" label="数据文件"></ma-file>');
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    const choose = (file: File) => { Object.defineProperty(input, 'files', { value: [file], configurable: true }); input.dispatchEvent(new window.Event('change')); };
    choose(new window.File(['{"amount":7}'], 'data.json', { type: 'application/json' }));
    await waitFor(() => expect(api.get('files')).toHaveLength(1)); expect(api.getWidgetState().modelContent?.files).toBeUndefined();
    const consent = document.querySelector('input[type=checkbox]') as HTMLInputElement; consent.checked = true; consent.dispatchEvent(new window.Event('change'));
    await waitFor(() => expect(api.getWidgetState().modelContent.files[0].text).toBe('{"amount":7}'));
    const saved = api.getWidgetState(); await api.setWidgetState(saved); expect(consent.checked).toBe(true);
    consent.checked = false; consent.dispatchEvent(new window.Event('change')); await waitFor(() => expect(api.getWidgetState().modelContent?.files).toBeUndefined());
    choose(new window.File(['{broken'], 'bad.json')); await waitFor(() => expect(document.querySelector('ma-file [role=alert]')?.textContent).toContain('不是有效 JSON')); expect(api.get('files')[0].name).toBe('data.json');
    choose(new window.File(['x'.repeat(66000)], 'large.txt')); await waitFor(() => expect(document.querySelector('ma-file [role=alert]')?.textContent).toContain('大小上限'));
  });
  it('paginates, filters and retains ID selections while reporting counts; virtual tables bound the row DOM', async () => {
    const rows = Array.from({ length: 1000 }, (_, id) => ({ id: 'id-' + id, label: '项目 ' + id }));
    const { api, document, window } = await runtimeFixture('<ma-table id="paged" selection="chosen" selection-mode="multiple" stats="counts" search="search" page-size="20"></ma-table><ma-table id="virtual" virtual></ma-table>');
    (document.querySelector('#paged') as any).data = rows; (document.querySelector('#virtual') as any).data = rows;
    expect(document.querySelectorAll('#paged tbody tr')).toHaveLength(20); expect(api.get('counts').filteredCount).toBe(1000);
    (document.querySelector('#paged .ma-row-select') as HTMLButtonElement).click(); expect(api.get('chosen')).toEqual(['id-0']);
    (document.querySelectorAll('#paged .ma-table-pager button')[1] as HTMLButtonElement).click(); expect(document.querySelector('#paged tbody tr')!.textContent).toContain('id-20');
    await api.set('search', '项目 999'); expect(document.querySelectorAll('#paged tbody tr')).toHaveLength(1); expect(api.get('counts').filteredCount).toBe(1); expect(api.get('chosen')).toEqual(['id-0']);
    const wrapper = document.querySelector('#virtual .ma-table-scroll') as HTMLElement; wrapper.scrollTop = 16000; wrapper.dispatchEvent(new window.Event('scroll'));
    expect(document.querySelectorAll('#virtual tbody tr:not([aria-hidden])').length).toBeLessThan(25); expect(document.querySelector('#virtual tbody tr:not([aria-hidden])')!.textContent).toContain('id-396');
  });
});
