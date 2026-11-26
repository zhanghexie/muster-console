import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (s: string) => s }) }));
vi.mock('pele', () => ({ render: state.render }));
vi.mock('../../src/renderer/src/keybindings/KeybindingHost', () => ({ useOverlayDismiss: () => {} }));
import { MermaidBlock } from '../../src/renderer/src/components/MermaidBlock';
import { contrastMermaidLabels } from '../../src/shared/mermaidView';

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" class="pele pele-flowchart" viewBox="0 0 200 100" width="200" height="100" style="max-width:100%;height:auto;color:var(--pele-fg,#1f1f1f)"><g class="pele-nodes"><g class="pele-node pele-shape-rect" data-id="A"><rect x="-40" y="-20" width="80" height="40" fill="var(--_s)" stroke="var(--_b)"/><text class="pele-label">普通</text></g><g class="pele-node pele-shape-stadium" data-id="S"><rect x="-42" y="-24" width="84" height="48" rx="24" fill="var(--_s)" stroke="var(--_b)" style="fill:#e0f7fa;stroke:#4dd0e1"/><text class="pele-label">开始</text></g></g></svg>';

let resolveFonts: () => void;

beforeEach(() => {
  state.render.mockReset();
  state.render.mockReturnValue({ svg: SVG });
  // 字体就绪时机可控：先挂起，测试内显式放行
  resolveFonts = () => {};
  const fontsReady = new Promise<void>((resolve) => {
    resolveFonts = resolve;
  });
  Object.defineProperty(document, 'fonts', { value: { ready: fontsReady }, configurable: true });
  document.documentElement.style.setProperty('--font-sans', 'OPPO Sans, sans-serif');
  // jsdom 无指针捕获 API，灯箱交互需要；getBBox 亦缺失（fit 里 sizeFromSvg 兜底路径会用到）
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
    ({ x: 0, y: 0, width: 200, height: 100, toJSON: () => {} }) as DOMRect;
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('style');
  delete (Element.prototype as { setPointerCapture?: unknown }).setPointerCapture;
  delete (Element.prototype as { releasePointerCapture?: unknown }).releasePointerCapture;
  delete (SVGElement.prototype as unknown as { getBBox?: unknown }).getBBox;
});

it('renders pele svg with the repo font family and strips inline sizing', async () => {
  const view = render(<MermaidBlock source="flowchart LR; A-->B" />);
  await screen.findByRole('button', { name: '点击放大 mermaid 图' });
  expect(state.render).toHaveBeenCalledWith('flowchart LR; A-->B', { fontFamily: 'OPPO Sans, sans-serif' });
  const host = document.querySelector('.md-mermaid');
  expect(host).toBeTruthy();
  const svg = host?.querySelector('svg');
  expect(svg?.getAttribute('viewBox')).toBe('0 0 200 100');
  // normalizeMermaidSvg：剥 pele 内联 max-width/height，尺寸交给容器 CSS
  expect(svg?.getAttribute('style')).not.toMatch(/max-width/);
  expect(svg?.getAttribute('style')).toMatch(/aspect-ratio: 200 \/ 100/);
  expect(svg?.getAttribute('width')).toBe('200');
  // 自然尺寸只缩不放：容器不得走 is-sized 拉伸铺满（旧方案 width:100%+绝对定位会把窄长图放大）
  expect(host?.className).not.toMatch(/is-sized/);
  expect(host?.getAttribute('style')).toBe(null);
  expect(svg?.getAttribute('style')).not.toMatch(/width\s*:\s*100%/);
  view.unmount();
});

it('节点字面浅色填充自动配深色文字（AI classDef 浅青开始节点在深色主题不可读的回归）', async () => {
  render(<MermaidBlock source="flowchart TD; S([开始]):::sc --> A[普通]" />);
  await screen.findByRole('button', { name: '点击放大 mermaid 图' });
  const stadiumText = document.querySelector('g[data-id="S"] text') as SVGElement;
  expect(stadiumText.getAttribute('fill')).toBe('#1f1f1f');
  // 未带字面填充的普通节点文字不动
  const plainText = document.querySelector('g[data-id="A"] text') as SVGElement;
  expect(plainText.getAttribute('fill')).toBe(null);
});

describe('contrastMermaidLabels 纯函数', () => {
  it('深色字面填充配浅字；var 填充与显式文字色不动', () => {
    const dark = contrastMermaidLabels(
      '<svg xmlns="http://www.w3.org/2000/svg"><g class="pele-node"><rect width="10" height="10" style="fill:#1a2b3c"/><text>深底</text></g></svg>'
    );
    expect(dark).toMatch(/<text fill="#fafafa">深底<\/text>/);

    const varFill = contrastMermaidLabels(
      '<svg xmlns="http://www.w3.org/2000/svg"><g class="pele-node"><rect width="10" height="10" style="fill:var(--_s)"/><text>变量底</text></g></svg>'
    );
    expect(varFill).not.toMatch(/<text fill=/);

    const explicit = contrastMermaidLabels(
      '<svg xmlns="http://www.w3.org/2000/svg"><g class="pele-node"><rect width="10" height="10" style="fill:#e0f7fa"/><text style="fill:#7b1fa2">自定字色</text></g></svg>'
    );
    expect(explicit).toMatch(/<text style="fill:#7b1fa2">自定字色<\/text>/);
    expect(explicit).not.toMatch(/<text style="fill:#7b1fa2" fill=/);
  });
});

it('re-renders exactly once after fonts become ready and stays stable afterwards', async () => {
  render(<MermaidBlock source="flowchart LR; A-->B" />);
  await screen.findByRole('button', { name: '点击放大 mermaid 图' });
  expect(state.render).toHaveBeenCalledTimes(1);
  resolveFonts();
  await waitFor(() => expect(state.render).toHaveBeenCalledTimes(2));
  // 主题色走 CSS 变量：无外观订阅、无额外重渲（防回归：曾按 appearance 订阅全量重渲）
  await new Promise((r) => setTimeout(r, 250));
  expect(state.render).toHaveBeenCalledTimes(2);
});

it('falls back to source code when pele fails to parse streaming partials', async () => {
  state.render.mockImplementation(() => {
    throw new Error('unsupported-diagram');
  });
  render(<MermaidBlock source="flowchart LR; A--" />);
  const fallback = await waitFor(() => {
    const el = document.querySelector('pre.md-mermaid-fallback.is-error');
    expect(el).toBeTruthy();
    return el!;
  });
  expect(fallback.querySelector('code.language-mermaid')?.textContent).toContain('A--');
});

function openLightbox(): HTMLElement {
  const host = screen.getByRole('button', { name: '点击放大 mermaid 图' });
  fireEvent.click(host);
  const overlay = document.querySelector('.md-mermaid-overlay');
  expect(overlay).toBeTruthy();
  return overlay as HTMLElement;
}

it('全屏查看器：首帧防闪（定位前舞台隐藏）、点击图外空白关闭、点图和拖动不关', async () => {
  render(<MermaidBlock source="flowchart LR; A-->B" />);
  await screen.findByRole('button', { name: '点击放大 mermaid 图' });
  openLightbox();
  const viewport = document.querySelector('.md-mermaid-overlay .md-mermaid-viewport') as HTMLElement;
  const stage = viewport.querySelector('.md-mermaid-stage') as HTMLElement;

  // 首帧防闪：打开瞬间（fit 尚未跑）舞台隐藏，fit 定位后再显示——防左上角闪一帧
  expect(stage.getAttribute('style')).toContain('visibility: hidden');
  await waitFor(() => expect(stage.getAttribute('style')).not.toContain('visibility: hidden'));

  // 点图（stage 命中）不关
  fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 5, clientY: 5, bubbles: true });
  fireEvent.pointerUp(stage, { pointerId: 1, button: 0, clientX: 5, clientY: 5, bubbles: true });
  expect(document.querySelector('.md-mermaid-overlay')).toBeTruthy();

  // 拖动（≥4px）不关
  fireEvent.pointerDown(viewport, { pointerId: 1, button: 0, clientX: 10, clientY: 10, bubbles: true });
  fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 60, clientY: 15, bubbles: true });
  fireEvent.pointerUp(viewport, { pointerId: 1, button: 0, clientX: 60, clientY: 15, bubbles: true });
  expect(document.querySelector('.md-mermaid-overlay')).toBeTruthy();

  // 点空白关闭并卸载
  fireEvent.pointerDown(viewport, { pointerId: 1, button: 0, clientX: 300, clientY: 40, bubbles: true });
  fireEvent.pointerUp(viewport, { pointerId: 1, button: 0, clientX: 300, clientY: 40, bubbles: true });
  await waitFor(() => expect(document.querySelector('.md-mermaid-overlay')).toBe(null));
});
