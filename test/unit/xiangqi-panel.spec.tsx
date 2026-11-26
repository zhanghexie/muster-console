import { readFileSync } from 'node:fs';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const markup = readFileSync('resources/extensions/xiangqi/ui/panel.html', 'utf8');
const packagePath = '../../resources/extensions/xiangqi';
const { mountXiangqi } = await import(`${packagePath}/ui/panel.mjs`);
const { createDomainRuntime } = await import(`${packagePath}/domain.mjs`);
let mounted: { dispose(): void } | undefined;

function fixture() {
  document.body.innerHTML = new DOMParser().parseFromString(markup, 'text/html').body.innerHTML;
  let contents: string | null = null;
  const runtime = createDomainRuntime({
    async broker(method: string, [_path, value]: [string, string]) {
      if (method === 'data.read') return contents === null ? null : { content: contents };
      contents = value;
      return { ok: true };
    }
  });
  const host = {
    ready: Promise.resolve({}),
    on: vi.fn((_topic: string, listener: (event: { version: number }) => void) => runtime.subscribe(listener)),
    ui: { confirm: vi.fn().mockResolvedValue(false) },
    agent: { domain: { snapshot: vi.fn(runtime.getSnapshot), query: vi.fn(runtime.query), command: vi.fn(runtime.execute) } }
  };
  return { host, runtime, start() { const panel = mountXiangqi(document, host); mounted = panel; return panel.ready; } };
}

const point = (logical: number) => document.querySelector<HTMLButtonElement>(`button[data-square='${logical}']`)!;

afterEach(() => {
  mounted?.dispose();
  mounted = undefined;
  document.body.replaceChildren();
});

it('exposes one board tab stop, moves focus by arrow and guards illegal destinations', async () => {
  const { host, start } = fixture();
  await start();
  const board = screen.getByRole('grid', { name: '中国象棋棋盘' });
  expect(board.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  expect(point(58).tabIndex).toBe(0);
  point(58).focus();
  fireEvent.click(point(58));
  expect(point(58).getAttribute('aria-pressed')).toBe('true');
  expect(point(49).hasAttribute('data-legal')).toBe(true);
  fireEvent.click(point(57));
  expect(host.agent.domain.command).not.toHaveBeenCalled();
  expect(screen.getByText(/不能落子/)).toBeTruthy();
  point(58).focus();
  fireEvent.keyDown(point(58), { key: 'ArrowUp' });
  expect(document.activeElement).toBe(point(49));
  fireEvent.keyDown(point(49), { key: 'Escape' });
  expect(point(49).hasAttribute('data-legal')).toBe(false);
  fireEvent.click(point(58));
  fireEvent.click(point(49));
  await screen.findByText('2 着');
  expect(host.agent.domain.command).toHaveBeenCalledWith('game.move', { from: 58, to: 49, expected: 0 });
  expect(point(49).textContent).toBe('兵');
});

it('hints without a write, flips the grid, and uses confirmation before abandoning a game', async () => {
  const { host, start } = fixture();
  await start();
  fireEvent.click(screen.getByRole('button', { name: /^提示$/ }));
  await screen.findByText(/^建议：/);
  expect(document.querySelectorAll('[data-hint]')).toHaveLength(2);
  expect(host.agent.domain.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '翻转' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '翻转' }).getAttribute('aria-pressed')).toBe('true'));
  expect(point(58).dataset.visual).toBe('31');
  expect(point(58).tabIndex).toBe(0);
  fireEvent.click(point(58));
  fireEvent.click(point(49));
  await screen.findByText('2 着');
  const local = screen.getByRole<HTMLButtonElement>('button', { name: '双人同屏' });
  fireEvent.click(local);
  await waitFor(() => expect(local.disabled).toBe(false));
  expect(host.ui.confirm).toHaveBeenCalledTimes(1);
  expect(local.getAttribute('aria-pressed')).toBe('false');
  expect(screen.getByText('2 着')).toBeTruthy();
  host.ui.confirm.mockResolvedValueOnce({ confirmed: true });
  fireEvent.click(local);
  await screen.findByText('轮到红方');
  expect(screen.getByText('0 着')).toBeTruthy();
  expect(local.getAttribute('aria-pressed')).toBe('true');
});

it('offers a real retry after a snapshot read fails and surfaces external changes', async () => {
  const { host, runtime, start } = fixture();
  host.agent.domain.snapshot.mockRejectedValueOnce(new Error('存储暂不可用'));
  await start();
  expect(screen.getByRole('alert').textContent).toContain('存储暂不可用');
  expect(point(58).tabIndex).toBe(-1);
  fireEvent.click(screen.getByRole('button', { name: '重试读取' }));
  await screen.findByText('轮到你走棋');
  await runtime.execute('game.new', { mode: 'local', expected: 0 });
  await screen.findByText('轮到红方');
  expect(host.agent.domain.snapshot).toHaveBeenCalledTimes(3);
});
