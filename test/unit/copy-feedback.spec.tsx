/** Actual copy buttons: shared fixed DOM slot, clipboard failure and feedback lifecycle. */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatHoverbar } from '../../src/renderer/src/components/ChatMessageView';
import { MarkdownBody } from '../../src/renderer/src/components/MarkdownBody';
import type { ChatMessage } from '../../src/shared/types';

const assistant: ChatMessage = {
  id: 'copy-fixture', role: 'assistant', createdAt: 1, content: 'fallback content',
  parts: [
    { kind: 'text', text: '  first paragraph' },
    { kind: 'thinking', text: 'never copied' },
    { kind: 'text', text: 'second paragraph  ' }
  ]
};
const cases = [
  {
    name: 'ChatHoverbar', label: '复制内容', expected: 'first paragraph\n\nsecond paragraph',
    mount: () => render(<ChatHoverbar message={assistant} timeLabel="12:34" />)
  },
  {
    name: 'MarkdownBody CodeBlock', label: '复制代码', expected: 'const answer = 42;\nconsole.log(answer);\n',
    mount: () => render(<MarkdownBody text={'```ts\nconst answer = 42;\nconsole.log(answer);\n```'} />)
  }
];
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

async function click(button: HTMLElement): Promise<void> {
  await act(async () => { fireEvent.click(button); });
}

describe.each(cases)('$name copy feedback', ({ mount, label, expected }) => {
  it('copies the unchanged payload and keeps one stable icon slot through success/reset', async () => {
    mount();
    const button = screen.getByRole('button', { name: label });
    const slot = button.querySelector('.copy-feedback');
    const icon = slot?.querySelector('svg');
    expect(slot).toBeTruthy();
    expect(slot?.getAttribute('aria-hidden')).toBe('true');
    expect(button.textContent).toBe('');
    await click(button);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(expected);
    expect(screen.getByRole('button', { name: '已复制' })).toBe(button);
    expect(button.querySelector('.copy-feedback')).toBe(slot);
    expect(slot?.querySelector('svg')).toBe(icon);
    expect(slot?.getAttribute('data-copied')).toBe('true');
    expect(button.textContent).toBe('');
    expect(button.querySelectorAll('svg')).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByRole('button', { name: label })).toBe(button);
    expect(button.querySelector('.copy-feedback')).toBe(slot);
    expect(slot?.querySelector('svg')).toBe(icon);
    expect(slot?.hasAttribute('data-copied')).toBe(false);
  });

  it('does not claim success on a rejected clipboard request and clears a preceding success', async () => {
    mount();
    const button = screen.getByRole('button', { name: label });
    await click(button);
    expect(screen.getByRole('button', { name: '已复制' })).toBe(button);
    writeText.mockRejectedValueOnce(new Error('denied'));
    await click(button);
    expect(screen.queryByRole('button', { name: '已复制' })).toBeNull();
    expect(screen.getByRole('button', { name: label })).toBe(button);
    expect(button.title).toBe('复制失败');
    expect(button.querySelector('.copy-feedback')?.hasAttribute('data-copied')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also handles a synchronous clipboard exception without an unhandled rejection', async () => {
    writeText.mockImplementationOnce(() => { throw new Error('clipboard unavailable'); });
    mount();
    const button = screen.getByRole('button', { name: label });
    await click(button);
    expect(button.title).toBe('复制失败');
    expect(screen.queryByRole('button', { name: '已复制' })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes the feedback lifetime so the old timer cannot revoke a later copy', async () => {
    mount();
    const button = screen.getByRole('button', { name: label });
    await click(button);
    act(() => vi.advanceTimersByTime(1000));
    await click(button);
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('button', { name: '已复制' })).toBe(button);
    act(() => vi.advanceTimersByTime(999));
    expect(screen.getByRole('button', { name: '已复制' })).toBe(button);
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('button', { name: label })).toBe(button);
  });

  it('clears its feedback timer on unmount', async () => {
    const view = mount();
    await click(screen.getByRole('button', { name: label }));
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a clipboard completion after unmount without starting a feedback timer', async () => {
    let resolve!: () => void;
    writeText.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    const view = mount();
    fireEvent.click(screen.getByRole('button', { name: label }));
    view.unmount();
    await act(async () => { resolve(); });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let an older successful completion overwrite the latest failure', async () => {
    let finishOld!: () => void;
    writeText.mockImplementationOnce(() => new Promise<void>((resolve) => { finishOld = resolve; }))
      .mockRejectedValueOnce(new Error('newer request denied'));
    mount();
    const button = screen.getByRole('button', { name: label });
    fireEvent.click(button);
    await click(button);
    expect(button.title).toBe('复制失败');
    await act(async () => { finishOld(); });
    expect(button.title).toBe('复制失败');
    expect(screen.queryByRole('button', { name: '已复制' })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

it('ChatHoverbar keeps user content verbatim and retains the assistant fallback', async () => {
  const view = render(<ChatHoverbar message={{ ...assistant, role: 'user', content: '  user\ncontent  ' }} />);
  await click(screen.getByRole('button', { name: '复制内容' }));
  expect(writeText).toHaveBeenLastCalledWith('  user\ncontent  ');
  view.rerender(<ChatHoverbar message={{ ...assistant, parts: [{ kind: 'thinking', text: 'not copied' }] }} />);
  await click(screen.getByRole('button', { name: '已复制' }));
  expect(writeText).toHaveBeenLastCalledWith('fallback content');
});
