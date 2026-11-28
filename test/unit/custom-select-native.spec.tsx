import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomSelect, type CustomSelectProps } from '../../src/renderer/src/components/CustomSelect';
import { KeybindingProvider, useOverlayDismiss } from '../../src/renderer/src/keybindings/KeybindingHost';
import { closeTopOverlay, resetOverlayStackForTest } from '../../src/renderer/src/keybindings/overlayStack';

// jsdom has no UA picker. These tests exercise the modern branch's React/DOM
// wiring; real click, arrows, Tab, Escape and layout live in the Chromium scenario.
let pickerOpen = false;
beforeEach(() => {
  pickerOpen = false;
  resetOverlayStackForTest();
  vi.stubGlobal('CSS', { supports: () => true });
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function(this: Element, selector) {
    return selector === ':open' ? pickerOpen : matches.call(this, selector);
  });
  const query = document.querySelector.bind(document);
  vi.spyOn(document, 'querySelector').mockImplementation(((selector: string) => selector === 'select.c-select-native:open'
    ? pickerOpen ? query('select.c-select-native') : null : query(selector)) as typeof document.querySelector);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetOverlayStackForTest(); });
const defaults: CustomSelectProps = {
  id: 'endpoint', ariaLabel: 'Endpoint', value: 'a', onChange: () => {},
  options: [
    { value: 'a', label: 'Alpha', description: 'Read only', icon: <span>◈</span>, badge: 'GUI', group: 'Available' },
    { value: 'b', label: 'Beta', description: 'Can write', group: 'Available' },
    { value: 'c', label: 'Offline', disabled: true, group: 'Other' }
  ]
};
const field = () => screen.getByRole<HTMLSelectElement>('combobox', { name: 'Endpoint' });

describe('CustomSelect customizable picker wiring', () => {
  it('keeps native values, groups, disabled options, rich details and a concise controlled button', () => {
    const { container } = render(<CustomSelect {...defaults} ariaInvalid ariaDescribedBy="help" menuClassName="task-permission-menu" testId="endpoint-test" />);
    const select = field();
    expect(select.firstElementChild?.tagName).toBe('BUTTON');
    expect(select.firstElementChild?.textContent).toBe('◈AlphaGUI');
    expect(select.value).toBe('a');
    expect(select.name).toBe('endpoint');
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(select.getAttribute('aria-describedby')).toBe('help');
    expect(select.classList.contains('task-permission-menu')).toBe(true);
    expect(select.querySelectorAll('optgroup')).toHaveLength(2);
    expect(within(select).getByRole<HTMLOptionElement>('option', { name: 'Offline' }).disabled).toBe(true);
    const alpha = select.querySelector('option[value="a"]')!;
    expect(document.getElementById(alpha.getAttribute('aria-describedby')!)?.textContent).toBe('Read only');
    expect(container.querySelector('.c-select-menu')).toBeNull();
  });

  it.each(['combobox', 'button'] as const)('keeps the fixed trigger icon decorative in the %s', (role) => {
    vi.stubGlobal('CSS', { supports: () => role === 'combobox' });
    render(<CustomSelect {...defaults} triggerLabel="Fixed label" triggerIcon={<span>Fixed icon</span>} />);

    const trigger = screen.getByRole(role, { name: 'Endpoint' });
    const triggerIcon = trigger.querySelector('.c-select-trigger-icon');
    expect(triggerIcon?.textContent).toBe('Fixed icon');
    expect(triggerIcon?.getAttribute('aria-hidden')).toBe('true');
    expect(trigger.getAttribute('title')).toBe('Endpoint');
    expect(trigger.querySelector('.c-select-value')?.textContent).toBe('Fixed label');
  });

  it('reports a valid choice once, preserves controlled values, and rejects disabled choices', () => {
    const changed = vi.fn();
    const view = render(<CustomSelect {...defaults} onChange={changed} />);
    fireEvent.change(field(), { target: { value: 'b' } });
    expect(changed).toHaveBeenCalledExactlyOnceWith('b');
    expect(field().value).toBe('a');
    view.rerender(<CustomSelect {...defaults} value="b" onChange={changed} />);
    expect(field().value).toBe('b');
    expect(field().firstElementChild?.textContent).toBe('Beta');
    fireEvent.change(field(), { target: { value: 'c' } });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('missing values show the placeholder, including after a selected option disappears; empty string is valid', () => {
    const changed = vi.fn();
    const view = render(<CustomSelect {...defaults} value="missing" placeholder="Choose" onChange={changed} />);
    expect(field().selectedOptions[0].hidden).toBe(true);
    expect(field().firstElementChild?.textContent).toBe('Choose');
    expect(changed).not.toHaveBeenCalled();
    view.rerender(<CustomSelect {...defaults} value="" options={[{ value: '', label: 'Automatic' }]} />);
    expect(field().value).toBe('');
    expect(field().firstElementChild?.textContent).toBe('Automatic');
    view.rerender(<CustomSelect {...defaults} value="" options={[]} placeholder="Choose" />);
    expect(field().firstElementChild?.textContent).toBe('Choose');
  });

  it('updates React rich content and compact descriptions without cloning duplicate IDs', () => {
    const view = render(<React.StrictMode><CustomSelect {...defaults} detailsAsTooltip /></React.StrictMode>);
    const option = field().querySelector('option[value="a"]')!;
    expect(option.getAttribute('title')).toBe('Read only');
    expect(option.querySelector('.c-select-detail-sr-only')?.textContent).toBe('Read only');
    view.rerender(<React.StrictMode><CustomSelect {...defaults} options={[{ value: 'a', label: 'Renamed', description: 'Updated' }]} /></React.StrictMode>);
    expect(field().firstElementChild?.textContent).toBe('Renamed');
    expect(field().querySelector('option')?.textContent).toBe('RenamedUpdated');
    expect(document.querySelectorAll('[id]')).toHaveLength(new Set([...document.querySelectorAll('[id]')].map(el => el.id)).size);
  });

  it('replaces the native shell when its parent collapses or it becomes disabled, dropping the old picker', () => {
    const view = render(<CustomSelect {...defaults} />);
    const original = field();
    view.rerender(<CustomSelect {...defaults} menuEnabled={false} />);
    expect(original.isConnected).toBe(false);
    expect(field().disabled).toBe(true);
    view.rerender(<CustomSelect {...defaults} />);
    expect(field().disabled).toBe(false);
    const enabled = field();
    view.rerender(<CustomSelect {...defaults} disabled />);
    expect(enabled.isConnected).toBe(false);
    expect(field().disabled).toBe(true);
  });

  it('lets native Escape run before a parent overlay, and supports programmatic dismissal', async () => {
    const close = vi.fn();
    function Parent() { useOverlayDismiss(true, close); return <CustomSelect {...defaults} />; }
    await act(async () => { render(<KeybindingProvider><Parent /></KeybindingProvider>); });
    const original = field();
    pickerOpen = true;
    fireEvent.focus(original);
    const key = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { original.dispatchEvent(key); });
    expect(key.defaultPrevented).toBe(false);
    expect(close).not.toHaveBeenCalled();
    pickerOpen = false; // UA closes when the old select is removed.
    act(() => { closeTopOverlay(); });
    expect(original.isConnected).toBe(false);
    expect(document.activeElement).toBe(field());
    pickerOpen = false;
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves explicit same-value selection without duplicating a changed pointer selection', () => {
    const changed = vi.fn();
    render(<CustomSelect {...defaults} onChange={changed} />);
    const a = field().querySelector('option[value="a"]')!;
    fireEvent.pointerDown(a); fireEvent.click(a);
    expect(changed).toHaveBeenCalledExactlyOnceWith('a');
    changed.mockClear();
    const b = field().querySelector('option[value="b"]')!;
    fireEvent.pointerDown(b); fireEvent.change(field(), { target: { value: 'b' } }); fireEvent.click(b);
    expect(changed).toHaveBeenCalledExactlyOnceWith('b');
    changed.mockClear();
    fireEvent.keyDown(a, { key: 'Enter' });
    expect(changed).toHaveBeenCalledExactlyOnceWith('a');
  });

  it('drops an open picker when a host dialog takes focus without taking focus back', async () => {
    render(<><CustomSelect {...defaults} /><button>Confirm</button></>);
    const original = field();
    act(() => original.focus());
    pickerOpen = true;
    await act(async () => { screen.getByRole('button', { name: 'Confirm' }).focus(); });
    expect(original.isConnected).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm' }));
  });

  it('closes the open native picker when its DOM page becomes the peek page', async () => {
    const layout = (peek: boolean) => <div data-h-page="git" data-h-peek={peek ? '' : undefined}>
      <CustomSelect {...defaults} />
    </div>;
    const view = render(layout(false));
    const original = field();
    pickerOpen = true;
    fireEvent.focus(original);
    view.rerender(layout(true));
    await waitFor(() => expect(original.isConnected).toBe(false));
    expect(document.activeElement).not.toBe(field());
  });

  it('dismisses a themed fallback only when the trigger’s page becomes the peek page', async () => {
    vi.stubGlobal('CSS', { supports: () => false });
    const layout = (peek: 'git' | 'terminal') => <>
      <div data-h-page="git" data-h-peek={peek === 'git' ? '' : undefined}><CustomSelect {...defaults} /></div>
      <div data-h-page="terminal" data-h-peek={peek === 'terminal' ? '' : undefined} />
    </>;
    const view = render(layout('terminal'));
    fireEvent.click(screen.getByRole('button', { name: 'Endpoint' }));
    expect(screen.getByRole('listbox', { name: 'Endpoint' })).toBeTruthy();
    view.rerender(layout('git'));
    await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Endpoint' })).toBeNull());
  });

  it('uses the existing themed fallback when either capability is missing', () => {
    vi.stubGlobal('CSS', { supports: (property: string) => property === 'appearance' });
    render(<CustomSelect {...defaults} />);
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Endpoint' }));
    expect(screen.getByRole('listbox', { name: 'Endpoint' })).toBeTruthy();
  });
});
