import React, { useEffect, useRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { attachTerminalKeyHandler } from '../../src/renderer/src/terminal/keyEvents';
import { KeybindingProvider, useOverlayDismiss } from '../../src/renderer/src/keybindings/KeybindingHost';

// Simulates xterm's custom-handler -> onData boundary. Real xterm keyboard encoding
// is additionally checked by the Chromium fixture.
function TerminalHarness({ selected = false, blocked = false, input, cleared }: {
  selected?: boolean; blocked?: boolean; input: (data: string) => void; cleared: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    let selection = selected;
    let handler: (ev: KeyboardEvent) => boolean;
    attachTerminalKeyHandler({
      attachCustomKeyEventHandler: fn => { handler = fn; },
      hasSelection: () => selection,
      getSelection: () => selection ? 'selected output' : '',
      clearSelection: () => { selection = false; cleared(); }
    }, () => blocked, () => {});
    const element = ref.current!;
    const key = (ev: KeyboardEvent): void => {
      if (handler(ev) && ev.key === 'Escape') input('\x1b');
    };
    element.addEventListener('keydown', key);
    return () => element.removeEventListener('keydown', key);
  }, [selected, blocked, input, cleared]);
  return <div className="xterm"><textarea ref={ref} aria-label="TUI" /></div>;
}

function Overlay({ close }: { close: () => void }): null {
  useOverlayDismiss(true, close);
  return null;
}

it.each([false, true])('first and repeated Esc reach TUI with selection=%s', async selected => {
  const input = vi.fn(), cleared = vi.fn();
  await act(async () => { render(<KeybindingProvider><TerminalHarness selected={selected} input={input} cleared={cleared} /></KeybindingProvider>); });
  const terminal = screen.getByRole('textbox');
  terminal.focus();
  fireEvent.keyDown(terminal, { key: 'Escape', code: 'Escape' });
  fireEvent.keyDown(terminal, { key: 'Escape', code: 'Escape' });
  expect(input.mock.calls).toEqual([['\x1b'], ['\x1b']]);
  expect(cleared).toHaveBeenCalledTimes(selected ? 1 : 0);
  expect(document.activeElement).toBe(terminal);
});

it('modal overlay closes without also interrupting the underlying TUI', async () => {
  const input = vi.fn(), close = vi.fn();
  await act(async () => { render(<KeybindingProvider><TerminalHarness input={input} cleared={() => {}} /><Overlay close={close} /></KeybindingProvider>); });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
  expect(close).toHaveBeenCalledOnce();
  expect(input).not.toHaveBeenCalled();
});

it('scan/bang input guard prevents Esc leaking into TUI', async () => {
  const input = vi.fn();
  render(<TerminalHarness blocked selected input={input} cleared={() => {}} />);
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
  expect(input).not.toHaveBeenCalled();
});

it.each(['ctrlKey', 'metaKey'])('%s+C retains copy-selection behavior', async modifier => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const input = vi.fn(), cleared = vi.fn();
  render(<TerminalHarness selected input={input} cleared={cleared} />);
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'c', [modifier]: true });
  expect(writeText).toHaveBeenCalledWith('selected output');
  expect(cleared).toHaveBeenCalledOnce();
  expect(input).not.toHaveBeenCalled();
});
