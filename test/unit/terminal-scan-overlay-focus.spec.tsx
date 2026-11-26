import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { resetOverlayStackForTest } from '../../src/renderer/src/keybindings/overlayStack';

vi.mock('../../src/renderer/src/theme', () => ({
  getResolvedAppearance: () => ({ cssVars: { '--scrim': 'rgba(0,0,0,0.4)' } }),
  subscribeAppearance: () => () => {}
}));
import { TerminalScanOverlay } from '../../src/renderer/src/components/TerminalScanOverlay';

afterEach(() => { resetOverlayStackForTest(); vi.unstubAllGlobals(); });

it('CLI 识屏不抢输入焦点，Esc 路由到输入区，点击命中后可操作识屏层', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const close = vi.fn(), escape = vi.fn();
  const overlay = <TerminalScanOverlay hits={[{ id: 'h1', kind: 'url', text: 'https://example.com',
    rects: [{ left: 10, top: 10, width: 80, height: 20 }] }]} snapshot={null} autoFocus={false}
    onClose={close} onEscape={escape} onTip={() => {}} onPreviewFile={() => {}} />;
  const view = render(<KeybindingProvider><input aria-label="输入框" /></KeybindingProvider>);
  const input = screen.getByRole('textbox', { name: '输入框' });
  input.focus();
  view.rerender(<KeybindingProvider><input aria-label="输入框" />{overlay}</KeybindingProvider>);
  expect(document.activeElement).toBe(input);
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(escape).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  fireEvent.mouseDown(view.container.querySelector('.term-scan-hit')!);
  expect(document.activeElement).toBe(view.container.querySelector('.term-scan-mask'));
});
