// jsdom lacks base-select: these cases deliberately cover the themed fallback.
// Modern wiring and actual UA interactions have separate native specs/scenarios.
import React, { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CustomSelect } from '../../src/renderer/src/components/CustomSelect';
import { closeTopOverlay } from '../../src/renderer/src/keybindings/overlayStack';

const options = [{ value: 'all', label: 'All' }, { value: 'cli', label: 'CLI' }, { value: 'gui', label: 'GUI' }];
function Example({ disabled = false, onChange = () => {} }: { disabled?: boolean; onChange?: (value: string) => void }): React.JSX.Element {
  const [value, setValue] = useState('all');
  return <CustomSelect ariaLabel="Endpoint" value={value} disabled={disabled} options={options} onChange={next => { onChange(next); setValue(next); }}/>;
}

describe('CustomSelect keyboard and portal focus', () => {
  it('opens into the listbox, navigates options, selects once and returns focus without scrolling', () => {
    const changed = vi.fn();
    render(<Example onChange={changed}/>);
    const trigger = screen.getByRole('button', { name: 'Endpoint' });
    trigger.focus();
    const focus = vi.spyOn(trigger, 'focus');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const menu = screen.getByRole('listbox', { name: 'Endpoint' });
    expect(document.activeElement).toBe(menu);
    expect(menu.parentElement).toBe(document.body);
    expect(trigger.getAttribute('aria-controls')).toBe(menu.id);
    fireEvent.keyDown(menu, { key: 'End' }); fireEvent.keyDown(menu, { key: 'Enter' });
    expect(changed).toHaveBeenCalledExactlyOnceWith('gui');
    expect(document.activeElement).toBe(trigger);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    expect(trigger.textContent).toContain('GUI');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect((document.querySelector('.c-select-menu') as HTMLElement).inert).toBe(true);
  });

  it('reveals keyboard-active options in a long plain list without scrolling on hover', () => {
    const plainOptions = Array.from({ length: 20 }, (_, index) => ({ value: String(index), label: `Option ${index}` }));
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView');
    try {
      render(<CustomSelect ariaLabel="Endpoint" value="14" options={plainOptions} onChange={() => {}} />);
      fireEvent.keyDown(screen.getByRole('button', { name: 'Endpoint' }), { key: 'ArrowDown' });
      const menu = screen.getByRole('listbox');
      expect(scrolled.mock.contexts.at(-1)).toBe(screen.getByRole('option', { name: 'Option 14' }));
      fireEvent.keyDown(menu, { key: 'End' });
      const lastOption = screen.getByRole('option', { name: 'Option 19' });
      expect(menu.getAttribute('aria-activedescendant')).toBe(lastOption.id);
      expect(scrolled.mock.contexts.at(-1)).toBe(lastOption);
      expect(scrolled).toHaveBeenLastCalledWith({ block: 'nearest' });

      scrolled.mockClear();
      fireEvent.mouseEnter(screen.getByRole('option', { name: 'Option 18' }));
      expect(scrolled).not.toHaveBeenCalled();
    } finally {
      scrolled.mockRestore();
    }
  });

  it('click selection and Escape restore the trigger; exit retains an inert menu for its animation', () => {
    render(<Example/>);
    const trigger = screen.getByRole('button', { name: 'Endpoint' });
    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'CLI' }));
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    const menu = screen.getByRole('listbox');
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(menu.getAttribute('data-mp-stage')).toBe('out');
    expect(menu.getAttribute('aria-hidden')).toBe('true');
    expect(menu.inert).toBe(true);
    const inertOnFocus: boolean[] = [];
    const originalFocus = menu.focus.bind(menu);
    const focus = vi.spyOn(menu, 'focus').mockImplementation((options) => {
      inertOnFocus.push(menu.inert);
      originalFocus(options);
    });
    fireEvent.click(trigger);
    focus.mockRestore();
    expect(inertOnFocus).toEqual([false]);
    expect(document.activeElement).toBe(menu);
    act(() => closeTopOverlay());
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('disabled controls do not open or emit a selection', () => {
    const changed = vi.fn();
    render(<Example disabled onChange={changed}/>);
    const trigger = screen.getByRole('button', { name: 'Endpoint' });
    fireEvent.click(trigger); fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });

  it('Tab and Shift Tab close a portal menu and continue the logical form order', async () => {
    const user = userEvent.setup();
    render(<><button type="button">Before</button><Example/><button type="button">After</button></>);
    const trigger = screen.getByRole('button', { name: 'Endpoint' });
    await user.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole('listbox'));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After' }));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await user.click(trigger);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Before' }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
