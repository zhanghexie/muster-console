import React from 'react';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { act, render, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ExtensionHomePeekContext, ExtensionSurface, ExtensionTabHost, prepareExtensionSurfaceReturn } from '../../src/renderer/src/components/ExtensionSurface';
import { dispatchPeekPointer, setPeekPointerHandler } from '../../src/renderer/src/browserPointer';
import { applyLocaleSetting } from '../../src/shared/i18n';

afterEach(() => { vi.unstubAllGlobals(); setPeekPointerHandler(null); });

it('reports unsupported state-preserving moves in the current language', () => {
  const error = vi.fn();
  const tree = (inTab: boolean) => <><ExtensionSurface surfaceKey="i18n-move" inTab={inTab} onError={error}><span>draft</span></ExtensionSurface><ExtensionTabHost surfaceKey="i18n-move"/></>;
  const view = render(tree(false));
  try {
    applyLocaleSetting('en');
    view.rerender(tree(true));
    expect(error).toHaveBeenCalledWith('This browser cannot move extension pages without reloading. Update your browser or use the desktop app.');
    expect(view.container.querySelector<HTMLElement>('.extension-surface-home')?.style.display).not.toBe('none');
  } finally { applyLocaleSetting('zh-CN'); }
});

it('keeps the original surface visible and reports a failed state-preserving move', () => {
  const move = vi.fn(() => { throw new Error('move failed'); });
  Object.defineProperty(HTMLElement.prototype, 'moveBefore', { configurable: true, value: move });
  const error = vi.fn();
  const tree = (inTab: boolean) => <><ExtensionSurface surfaceKey="failed-move" inTab={inTab} onError={error}>
    <input aria-label="保留草稿" defaultValue="原文"/></ExtensionSurface><ExtensionTabHost surfaceKey="failed-move"/></>;
  try {
    applyLocaleSetting('en');
    const view = render(tree(false));
    const draft = screen.getByLabelText('保留草稿') as HTMLInputElement;
    fireEvent.change(draft, { target: { value: '未保存' } });
    view.rerender(tree(true));
    expect(error).toHaveBeenCalledWith('The extension page could not be moved without reloading. Try again or keep it in its current location.');
    expect(view.container.querySelector<HTMLElement>('.extension-surface-home')?.style.display).not.toBe('none');
    expect(screen.getByLabelText('保留草稿')).toBe(draft);
    expect(draft.value).toBe('未保存');
  } finally { applyLocaleSetting('zh-CN'); delete (HTMLElement.prototype as HTMLElement & { moveBefore?: unknown }).moveBefore; }
});

it('keeps the floating toolbar rule separate after removing legacy placement geometry', () => {
  const css = postcss.parse(readFileSync('src/renderer/src/styles/split.css', 'utf8'));
  const selector = ".center-split-pane[data-floating='true'] .center-split-pane-toolbar";
  const rules: string[][] = [];
  css.walkRules(rule => {
    if (!rule.selectors.includes(selector)) return;
    rules.push(rule.selectors);
    const radius = rule.nodes.find(node => node.type === 'decl' && node.prop === 'border-radius');
    expect(radius && radius.type === 'decl' ? radius.value : undefined).toBe('var(--radius-card) var(--radius-card) 0 0');
  });
  expect(rules).toEqual([[selector]]);
});

it('routes the right extension peek through the host screen before allowing guest interaction', () => {
  const pointer = vi.fn(); setPeekPointerHandler(pointer);
  const view = render(<div data-h-page="git"><ExtensionTabHost surfaceKey="peek" peek/></div>);
  const overlay = view.container.querySelector('.extension-tab-peek');
  expect(overlay).not.toBeNull();
  fireEvent.pointerMove(overlay!);
  fireEvent.pointerDown(overlay!, { button: 0 });
  expect(pointer.mock.calls).toEqual([['move', 'git'], ['down', 'git']]);
  view.rerender(<div data-h-page="git"><ExtensionTabHost surfaceKey="peek"/></div>);
  expect(view.container.querySelector('.extension-tab-peek')).toBeNull();
});

it('routes left iframe peek gestures to the left screen and removes its shield after activation or moving right', () => {
  const pointer = vi.fn(); setPeekPointerHandler(pointer);
  const error = vi.fn();
  const tree = (peek: boolean, inTab = false) => <ExtensionHomePeekContext.Provider value={peek}><div data-h-page="terminal">
    <ExtensionSurface surfaceKey="left-peek" inTab={inTab} onError={error}><input aria-label="左侧草稿" defaultValue="保留"/></ExtensionSurface>
  </div></ExtensionHomePeekContext.Provider>;
  const view = render(tree(true));
  const draft = screen.getByLabelText('左侧草稿');
  const shield = view.container.querySelector('.extension-home-peek');
  expect(shield).not.toBeNull();
  fireEvent.pointerMove(shield!); fireEvent.pointerDown(shield!, { button: 0 });
  expect(pointer.mock.calls).toEqual([['move', 'terminal'], ['down', 'terminal']]);
  fireEvent.pointerDown(shield!, { button: 2 }); expect(pointer).toHaveBeenCalledTimes(2);
  view.rerender(tree(false)); expect(view.container.querySelector('.extension-home-peek')).toBeNull();
  fireEvent.change(draft, { target: { value: '继续编辑' } });
  view.rerender(tree(true, true)); expect(view.container.querySelector('.extension-home-peek')).toBeNull();
  expect(screen.getByLabelText('左侧草稿')).toBe(draft);
  expect((draft as HTMLInputElement).value).toBe('继续编辑');
  expect(error).not.toHaveBeenCalled();
});

it('resolves the target screen from the overlay DOM position; outside any screen nothing is dispatched', () => {
  const pointer = vi.fn(); setPeekPointerHandler(pointer);
  const view = render(<><div data-h-page="git"><span data-testid="right-overlay"/></div><span data-testid="loose"/></>);
  dispatchPeekPointer('down', view.getByTestId('right-overlay'));
  dispatchPeekPointer('down', view.getByTestId('loose'));
  expect(pointer.mock.calls).toEqual([['down', 'git']]);
});

it('moves one portal owner to the right and returns it before its tab host is removed', () => {
  // jsdom lacks state-preserving moves; real iframe load/draft is checked in Electron.
  const move = vi.fn(function(this: HTMLElement, node: Node, child: Node | null) { this.insertBefore(node, child); });
  Object.defineProperty(HTMLElement.prototype, 'moveBefore', { configurable: true, value: move });
  const error = vi.fn();
  const tree = (inTab: boolean, showTab = true) => <><div data-testid="left"><ExtensionSurface surfaceKey="draft" inTab={inTab} onError={error}><input aria-label="草稿" defaultValue=""/></ExtensionSurface></div>{showTab && <div data-testid="right"><ExtensionTabHost surfaceKey="draft"/></div>}</>;
  const view = render(tree(false));
  const draft = screen.getByLabelText('草稿'); fireEvent.change(draft, { target: { value: '保留内容' } });
  view.rerender(tree(true));
  expect(screen.getByTestId('right').contains(draft)).toBe(true);
  view.rerender(tree(true, false));
  expect(screen.getByTestId('left').contains(draft)).toBe(true);
  view.rerender(tree(false, false));
  expect(screen.getByLabelText('草稿')).toBe(draft);
  expect((draft as HTMLInputElement).value).toBe('保留内容');
  expect(error).not.toHaveBeenCalled(); expect(move).toHaveBeenCalledTimes(2);
  view.unmount(); delete (HTMLElement.prototype as HTMLElement & { moveBefore?: unknown }).moveBefore;
});

it('prepares a return while the tab is connected and rolls back if saving fails', () => {
  const move = vi.fn(function(this: HTMLElement, node: Node, child: Node | null) { this.insertBefore(node, child); });
  Object.defineProperty(HTMLElement.prototype, 'moveBefore', { configurable: true, value: move });
  try {
    const view = render(<><ExtensionSurface surfaceKey="prepared" inTab onError={vi.fn()}><input aria-label="prepared-draft"/></ExtensionSurface><ExtensionTabHost surfaceKey="prepared"/></>);
    const draft = screen.getByLabelText('prepared-draft') as HTMLInputElement;
    fireEvent.change(draft, { target: { value: 'keep' } });
    let rollback: (() => void) | undefined;
    act(() => { rollback = prepareExtensionSurfaceReturn('prepared'); });
    expect(view.container.querySelector('.extension-surface-home')?.contains(draft)).toBe(true);
    expect(prepareExtensionSurfaceReturn('prepared')).toBe(rollback);
    act(() => rollback?.());
    expect(view.container.querySelector('.extension-tab-host')?.contains(draft)).toBe(true);
    expect(draft.value).toBe('keep');
    move.mockImplementation(() => { throw new Error('failed'); });
    expect(() => prepareExtensionSurfaceReturn('prepared')).toThrow();
    expect(view.container.querySelector('.extension-tab-host')?.contains(draft)).toBe(true);
  } finally { delete (HTMLElement.prototype as HTMLElement & { moveBefore?: unknown }).moveBefore; }
});
