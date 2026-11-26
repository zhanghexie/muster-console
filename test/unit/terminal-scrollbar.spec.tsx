import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';

const observed = vi.hoisted(() => ({ terminal: null as Terminal | null }));
const store = vi.hoisted(() => ({ flashTip: vi.fn(), requestOpenWorkspaceFile: vi.fn() }));
vi.mock('@xterm/xterm', async importOriginal => {
  const actual = await importOriginal<typeof import('@xterm/xterm')>();
  class ObservedTerminal extends actual.Terminal {
    constructor(options?: ConstructorParameters<typeof actual.Terminal>[0]) {
      super(options);
      observed.terminal = this;
    }
  }
  return { ...actual, Terminal: ObservedTerminal };
});
vi.mock('../../src/renderer/src/store', () => ({
  useUiStore: () => store,
  useHStripBusy: () => false
}));

let TerminalView: typeof import('../../src/renderer/src/components/TerminalView').TerminalView;

beforeAll(async () => {
  const context = {
    font: '', fillStyle: '', globalCompositeOperation: 'copy',
    measureText: () => ({ width: 8, fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 4 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    clearRect() {}, fillRect() {}, drawImage() {},
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) })
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => context) as unknown as typeof HTMLCanvasElement.prototype.getContext);
  vi.stubGlobal('OffscreenCanvas', class { getContext(): typeof context { return context; } });
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  vi.stubGlobal('matchMedia', (query: string) => ({ media: query, matches: false, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }));
  ({ TerminalView } = await import('../../src/renderer/src/components/TerminalView'));
});

beforeEach(() => { observed.terminal = null; });
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('隐藏终端滚动条但保留真实 xterm 回滚缓冲', async () => {
  const view = render(<TerminalView sessionId="scrollbar-fixture" visible={false} onScanControl={() => {}}/>);
  const term = observed.terminal;
  expect(term).not.toBeNull();
  expect(term!.options.scrollbar?.showScrollbar).toBe(false);
  const scrollbar = view.container.querySelector('.xterm-scrollbar.xterm-vertical');
  expect(scrollbar).not.toBeNull();
  expect(scrollbar!.classList.contains('xterm-invisible')).toBe(true);
  await new Promise<void>(resolve => term!.write(Array.from({ length: 120 }, (_, i) => `row ${i}`).join('\r\n'), resolve));
  expect(term!.buffer.active.baseY).toBeGreaterThan(0);
  await waitFor(() => expect(term!.buffer.active.viewportY).toBeGreaterThan(0));
  term!.options.smoothScrollDuration = 0;
  term!.scrollToTop();
  await waitFor(() => expect(term!.buffer.active.viewportY).toBe(0));
});
