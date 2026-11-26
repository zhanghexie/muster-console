import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (s: string) => s }) }));
vi.mock('../../src/renderer/src/keybindings/KeybindingHost', () => ({ useOverlayDismiss: () => {} }));
import { ImageLightbox } from '../../src/renderer/src/components/ImageLightbox';
import { MOTION } from '../../src/renderer/src/components/motion';

// jsdom 无指针捕获 API，桩掉（组件在 pointerdown 里调用）
beforeEach(() => {
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (Element.prototype as { setPointerCapture?: unknown }).setPointerCapture;
  delete (Element.prototype as { releasePointerCapture?: unknown }).releasePointerCapture;
});

function mount(onClose: () => void) {
  render(<ImageLightbox src="data:image/png;base64,," alt="图" onClose={onClose} />);
  const viewport = document.querySelector('.md-mermaid-viewport') as HTMLElement;
  const img = viewport.querySelector('img') as HTMLElement;
  const stage = viewport.querySelector('.md-mermaid-stage') as HTMLElement;
  return { viewport, img, stage };
}

function click(el: HTMLElement, x = 10, y = 10): void {
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: x, clientY: y, bubbles: true });
  fireEvent.pointerUp(el, { pointerId: 1, button: 0, clientX: x, clientY: y, bubbles: true });
}

it('点击图片外空白区域关闭查看器', () => {
  const onClose = vi.fn();
  const { viewport } = mount(onClose);
  click(viewport, 300, 40);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('拖动平移不触发关闭（位移超过点击阈值）', () => {
  const onClose = vi.fn();
  const { viewport } = mount(onClose);
  fireEvent.pointerDown(viewport, { pointerId: 1, button: 0, clientX: 10, clientY: 10, bubbles: true });
  fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 40, clientY: 12, bubbles: true });
  fireEvent.pointerUp(viewport, { pointerId: 1, button: 0, clientX: 40, clientY: 12, bubbles: true });
  expect(onClose).not.toHaveBeenCalled();
});

it('点击图片本身不关闭（img/stage 命中都算内容区；真实浏览器里 img 为 pointer-events:none，命中点即 stage）', () => {
  const onClose = vi.fn();
  const { img, stage } = mount(onClose);
  click(img, 5, 5);
  click(stage, 5, 5);
  expect(onClose).not.toHaveBeenCalled();
});

it('pointercancel 不当作点击关闭', () => {
  const onClose = vi.fn();
  const { viewport } = mount(onClose);
  fireEvent.pointerDown(viewport, { pointerId: 1, button: 0, clientX: 10, clientY: 10, bubbles: true });
  fireEvent.pointerCancel(viewport, { pointerId: 1, clientX: 10, clientY: 10, bubbles: true });
  expect(onClose).not.toHaveBeenCalled();
});

it('首帧定位前舞台隐藏，防左上角闪帧', async () => {
  const { viewport } = mount(vi.fn());
  const stage = viewport.querySelector('.md-mermaid-stage') as HTMLElement;
  expect(stage.getAttribute('style')).toContain('visibility: hidden');
  await waitFor(() => expect(stage.getAttribute('style')).not.toContain('visibility: hidden'));
});

it('右键按下不进入拖拽也不关闭', () => {
  const onClose = vi.fn();
  const { viewport } = mount(onClose);
  fireEvent.pointerDown(viewport, { pointerId: 1, button: 2, clientX: 10, clientY: 10, bubbles: true });
  fireEvent.pointerUp(viewport, { pointerId: 1, button: 2, clientX: 10, clientY: 10, bubbles: true });
  expect(onClose).not.toHaveBeenCalled();
});

it('关闭后保留磨砂退场，重新打开沿用同一遮罩', () => {
  vi.useFakeTimers();
  function Preview() {
    const [open, setOpen] = React.useState(false);
    return <>
      <button onClick={() => setOpen(true)}>打开大图</button>
      <ImageLightbox src={open ? 'data:image/png;base64,,' : null} alt="图" onClose={() => setOpen(false)} />
    </>;
  }

  render(<Preview />);
  const open = screen.getByRole('button', { name: '打开大图' });
  fireEvent.click(open);
  const dialog = screen.getByRole('dialog', { name: '图片查看' });
  const scrim = dialog.querySelector('.backdrop-blur-overlay.mp-scrim');
  expect(scrim?.getAttribute('data-mp-stage')).toBe('in');

  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(screen.queryByRole('dialog', { name: '图片查看' })).toBeNull();
  expect(scrim?.getAttribute('data-mp-stage')).toBe('out');
  expect(scrim?.isConnected).toBe(true);

  fireEvent.click(open);
  expect(screen.getByRole('dialog', { name: '图片查看' })).toBe(dialog);
  expect(scrim?.getAttribute('data-mp-stage')).toBe('in');
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  act(() => vi.advanceTimersByTime(MOTION.exitMs + 80));
  expect(scrim?.isConnected).toBe(false);
});
