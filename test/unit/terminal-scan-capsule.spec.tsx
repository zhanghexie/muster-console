import React, { useRef } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ flashTip: vi.fn() }));
vi.mock('../../src/renderer/src/store', () => ({ useUiStore: () => store }));
import { TerminalScanCapsule } from '../../src/renderer/src/components/TerminalScanCapsule';

it('普通 Shell 和后台终端可通过独立胶囊启动或关闭识屏', async () => {
  const onScan = vi.fn();
  function Host({ active }: { active: boolean }): React.JSX.Element {
    const ref = useRef<HTMLDivElement>(null);
    return <div ref={ref}><TerminalScanCapsule sessionId="shell-1" visible active={active} viewRef={ref} onScan={onScan} /></div>;
  }
  const user = userEvent.setup();
  const view = render(<Host active={false} />);
  const drag = screen.getByRole('button', { name: '拖动识屏胶囊' });
  expect(drag.parentElement?.lastElementChild).toBe(drag);
  await user.click(screen.getByRole('button', { name: '识屏' }));
  expect(onScan).toHaveBeenCalledWith({ x: expect.any(Number), y: expect.any(Number) });
  view.rerender(<Host active />);
  const close = screen.getByRole('button', { name: '关闭识屏' });
  expect(close.getAttribute('aria-pressed')).toBe('true');
  await user.click(close);
  expect(onScan).toHaveBeenCalledTimes(2);
});

it('父终端引用在子组件布局阶段之后就绪时仍能测量和拖动', async () => {
  localStorage.removeItem('muster.cli-composer-position:terminal-scan:drag-test');
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  }
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const isHost = this.dataset.testid === 'terminal-host';
    return { x: 0, y: 0, left: 0, top: 0, right: isHost ? 800 : 100, bottom: isHost ? 600 : 30,
      width: isHost ? 800 : 100, height: isHost ? 600 : 30, toJSON: () => ({}) };
  });
  try {
    function Host(): React.JSX.Element {
      const ref = useRef<HTMLDivElement>(null);
      return <div data-testid="terminal-host" ref={ref}><TerminalScanCapsule sessionId="drag-test" visible active={false} viewRef={ref} onScan={vi.fn()} /></div>;
    }
    render(<Host />);
    const handle = screen.getByRole('button', { name: '拖动识屏胶囊' });
    const capsule = handle.closest('.terminal-scan-capsule') as HTMLElement;
    await waitFor(() => expect(capsule.style.transform).toBe('translate(692px, 562px)'));
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 750, clientY: 570 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100, clientY: 200 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 100, clientY: 200 });
    expect(capsule.style.transform).not.toBe('translate(692px, 562px)');
    expect(localStorage.getItem('muster.cli-composer-position:terminal-scan:drag-test')).not.toBeNull();
  } finally { rect.mockRestore(); vi.unstubAllGlobals(); }
});
