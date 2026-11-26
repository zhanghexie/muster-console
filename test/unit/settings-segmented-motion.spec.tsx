import React, { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Segmented } from '../../src/renderer/src/components/settings/shared';

const options = [{ value: 'a', label: '短' }, { value: 'b', label: '较长的标签' }, { value: 'c', label: '第三项' }] as const;
let geometry: Record<string, [number, number]>;
let groupWidth: number;
let resize: () => void;
let disconnect: ReturnType<typeof vi.fn>;
let fonts: EventTarget & { ready: Promise<unknown> };
let resolveFonts: () => void;
let savedFonts: PropertyDescriptor | undefined;

function Harness({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState<string>('a');
  return <Segmented label="布局选择" options={options} value={value} onChange={setValue} disabled={disabled}/>;
}
const plate = () => screen.getByRole('group', { name: '布局选择' }).querySelector<HTMLElement>('.s-seg-selection')!;

beforeEach(() => {
  geometry = { '短': [2, 50], '较长的标签': [54, 90], '第三项': [146, 70] };
  groupWidth = 220;
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('s-seg') ? groupWidth : geometry[this.textContent ?? '']?.[1] ?? 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
    return geometry[this.textContent ?? '']?.[0] ?? 0;
  });
  disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {} disconnect = disconnect;
  });
  fonts = Object.assign(new EventTarget(), { ready: new Promise<void>(resolve => { resolveFonts = resolve; }) });
  savedFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
});
afterEach(() => {
  if (savedFonts) Object.defineProperty(document, 'fonts', savedFonts);
  else Reflect.deleteProperty(document, 'fonts');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Segmented 的共享移动底片', () => {
  it('变量宽按钮保持原 DOM、文字和即时 aria 选择，快速反向只更新同一底片', () => {
    render(<Harness/>);
    const buttons = within(screen.getByRole('group')).getAllByRole('button');
    const selection = plate();
    expect(selection.getAttribute('aria-hidden')).toBe('true');
    expect(selection.style.width).toBe('50px');
    expect(selection.style.transform).toBe('translateX(2px)');
    buttons[1].focus();
    for (const index of [1, 2, 0, 1]) {
      fireEvent.click(buttons[index]);
      expect(plate()).toBe(selection);
      expect(within(screen.getByRole('group')).getAllByRole('button')).toEqual(buttons);
      expect(buttons.map(button => button.getAttribute('aria-pressed'))).toEqual(options.map((_, at) => String(at === index)));
      expect(selection.style.width).toBe(`${geometry[options[index].label][1]}px`);
      expect(selection.style.transform).toBe(`translateX(${geometry[options[index].label][0]}px)`);
      expect(buttons.every(button => button.getAttribute('style') === null)).toBe(true);
    }
    expect(document.activeElement).toBe(buttons[1]);
  });

  it('保留原生 Tab/Enter 选择和禁用行为，禁用不影响底片布局', async () => {
    const user = userEvent.setup();
    const view = render(<Harness/>);
    await user.tab(); await user.tab(); await user.keyboard('{Enter}');
    const selected = screen.getByRole('button', { name: '较长的标签' });
    expect(selected.getAttribute('aria-pressed')).toBe('true');
    expect(plate().style.width).toBe('90px');
    view.rerender(<Harness disabled/>);
    await user.click(screen.getByRole('button', { name: '短' }));
    expect(selected.getAttribute('aria-pressed')).toBe('true');
    expect(within(screen.getByRole('group')).getAllByRole('button').every(button => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(plate().style.width).toBe('90px');
  });

  it('字体完成、标签变动与容器 resize 校准；0宽不覆盖有效位置且不创建新底片', async () => {
    const view = render(<Segmented label="布局选择" value="b" options={options} onChange={() => {}}/>);
    const selection = plate();
    geometry['较长的标签'] = [63, 105];
    act(() => resize());
    expect(selection.style.transform).toBe('translateX(63px)');
    expect(selection.style.width).toBe('105px');
    groupWidth = 0; geometry['较长的标签'] = [0, 0];
    act(() => resize());
    expect(screen.getByRole('group').hasAttribute('data-seg-ready')).toBe(false);
    expect(selection.style.width).toBe('105px');
    expect(selection.style.transform).toBe('translateX(63px)');
    groupWidth = 260; geometry['较长的标签'] = [73, 115];
    act(() => resize());
    expect(selection.style.transform).toBe('translateX(73px)');
    expect(selection.style.transition).toBe('');
    geometry['较长的标签'] = [83, 125];
    await act(async () => { resolveFonts(); await fonts.ready; });
    expect(selection.style.width).toBe('125px');
    geometry['较长的标签'] = [93, 135];
    act(() => fonts.dispatchEvent(new Event('loadingdone')));
    expect(selection.style.transform).toBe('translateX(93px)');
    geometry['新标签'] = [103, 145];
    view.rerender(<Segmented label="布局选择" value="b" options={[...options.slice(0, 1), { value: 'b', label: '新标签' }, options[2]]} onChange={() => {}}/>);
    expect(plate()).toBe(selection);
    expect(selection.style.width).toBe('145px');
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('保活设置页隐藏/重开时即时恢复选中几何，异步字体回调卸载后不再读布局', async () => {
    const read = vi.spyOn(window, 'getComputedStyle');
    const view = render(<div className="settings-tabpane"><Harness/></div>);
    const selection = plate();
    const pane = selection.closest<HTMLElement>('.settings-tabpane')!;
    await act(async () => { pane.setAttribute('aria-hidden', 'true'); });
    expect(selection.parentElement?.hasAttribute('data-seg-ready')).toBe(false);
    geometry['短'] = [12, 60];
    await act(async () => { pane.removeAttribute('aria-hidden'); });
    expect(plate()).toBe(selection);
    expect(selection.style.transform).toBe('translateX(12px)');
    expect(selection.style.transition).toBe('');
    view.unmount();
    read.mockClear();
    await act(async () => { resolveFonts(); await fonts.ready; fonts.dispatchEvent(new Event('loadingdone')); });
    expect(read).not.toHaveBeenCalled();
  });
});
