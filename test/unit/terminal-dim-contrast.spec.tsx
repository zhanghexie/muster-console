import { afterEach, expect, it, vi } from 'vitest';
import { attachDimContrast, readableDimForeground } from '../../src/renderer/src/terminal/dimContrast';
import { appearanceContrast } from '../../src/shared/resolvedAppearance';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it('repairs DIM, ANSI and truecolor foregrounds against their actual background without modifying text or explicit backgrounds', () => {
  const container = document.createElement('div');
  container.innerHTML = '<div class="xterm-rows"><div><span class="xterm-dim" style="color:rgba(44,44,44,.5)">DIM</span><span class="xterm-dim xterm-fg-2" style="color:rgba(0,140,80,.5)">ANSI</span><span class="xterm-dim" style="color:rgba(80,110,180,.5)">RGB</span><span class="xterm-dim" style="color:rgba(180,160,200,.5);background-color:rgb(40,28,46)">TUI</span><span style="color:rgb(0,140,80)">ordinary ANSI</span></div></div>';
  document.body.append(container);
  let render: ((range: { start: number; end: number }) => void) | undefined;
  const dispose = vi.fn(), refresh = vi.fn();
  const guard = attachDimContrast({ rows: 1, refresh, onRender: fn => { render = fn; return { dispose }; } }, container, { enabled: true, background: '#ffffff' });
  const spans = Array.from(container.querySelectorAll<HTMLElement>('span'));
  const original = spans.map(span => ({ color: span.style.color, background: span.style.backgroundColor, text: span.textContent }));
  render!({ start: 0, end: 0 });
  for (let index = 0; index < 4; index++) {
    expect(appearanceContrast(spans[index].style.color, index === 3 ? '#281c2e' : '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(spans[index].style.backgroundColor).toBe(original[index].background);
    expect(spans[index].textContent).toBe(original[index].text);
  }
  expect(spans[1].style.color).not.toBe(spans[0].style.color);
  expect(spans[2].style.color).not.toBe(spans[0].style.color);
  expect(spans[4].style.color).toBe(original[4].color);
  guard.update({ enabled: false, background: '#141416' });
  expect(spans.map(span => span.style.color)).toEqual(original.map(value => value.color));
  render!({ start: 0, end: 0 });
  expect(spans.map(span => span.style.color)).toEqual(original.map(value => value.color));
  guard.update({ enabled: true, background: '#ffffff' });
  render!({ start: 0, end: 0 });
  expect(spans[0].style.color).not.toBe(original[0].color);
  spans[0].remove();
  render!({ start: 0, end: 0 }); // Detached nodes are discarded before a palette reset.
  guard.dispose();
  expect(dispose).toHaveBeenCalledOnce();
  expect(spans[1].style.color).toBe(original[1].color);
  expect(refresh).toHaveBeenCalledTimes(2);
});

it('keeps readable dark DIM unchanged and restores only our inline overrides on disposal', () => {
  expect(readableDimForeground('rgba(237,237,238,.5)', '#141416')).toBeNull();
  const container = document.createElement('div');
  container.innerHTML = '<div class="xterm-rows"><div><span class="xterm-dim" style="color:rgba(44,44,44,.5)!important">text</span></div></div>';
  document.body.append(container);
  let render: ((range: { start: number; end: number }) => void) | undefined;
  const guard = attachDimContrast({ rows: 1, refresh: vi.fn(), onRender: fn => { render = fn; return { dispose: vi.fn() }; } }, container, { enabled: true, background: '#ffffff' });
  const span = container.querySelector<HTMLElement>('span')!;
  const original = span.style.color;
  render!({ start: 0, end: 0 });
  guard.dispose();
  expect(span.style.color).toBe(original);
  expect(span.style.getPropertyPriority('color')).toBe('important');
});
