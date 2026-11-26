import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TurnChangesCard } from '../../src/renderer/src/chatSurface/TurnChangesCard';
import { TurnSnapshotVisibilityProvider } from '../../src/renderer/src/chatSurface/TurnSnapshotVisibility';
import { currentApiMock } from './helpers/api-mock';
import type { TurnChanges, TurnReviewEntry } from '../../src/shared/turnChanges';

const owner = { kind: 'gui' as const, id: 'session-a' };
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
const make = (id: string) => {
  const summary: TurnChanges = { id: `snapshot-${id}`, state: 'ready', warnings: [],
    files: [{ path: `${id}.ts`, kind: 'modified', added: 1, removed: 1, revertible: true }] };
  return { id, role: 'assistant' as const, turnChanges: summary };
};
const entry = (message: ReturnType<typeof make>, currentOwner = owner): TurnReviewEntry => ({
  target: { ...currentOwner, messageId: message.id }, summary: message.turnChanges, label: message.id, createdAt: 1
});
function Cards({ messages, currentOwner = owner, active = true }: { messages: ReturnType<typeof make>[]; currentOwner?: typeof owner; active?: boolean }) {
  return <TurnSnapshotVisibilityProvider owner={currentOwner} messages={messages} active={active}>
    {messages.map(message => <TurnChangesCard key={message.id} summary={message.turnChanges} target={{ ...currentOwner, messageId: message.id }}/>) }
  </TurnSnapshotVisibilityProvider>;
}

it('shows only the latest usable card, including fallback when a newer snapshot is missing', async () => {
  const old = make('old'), usable = make('usable'), missing = make('missing');
  const api = currentApiMock();
  api.mockOf('turnChanges.list').mockResolvedValue({ ok: true, entries: [entry(usable)] });
  const { rerender } = render(<Cards messages={[old, usable, missing]}/>);
  await screen.findByRole('button', { name: /usable\.ts/ });
  expect(screen.queryByRole('button', { name: /old\.ts/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /missing\.ts/ })).toBeNull();
  expect(api.mockOf('turnChanges.list')).toHaveBeenCalledTimes(1);
  expect(api.mockOf('turnChanges.diff')).not.toHaveBeenCalled();

  const newer = make('newer');
  api.mockOf('turnChanges.list').mockResolvedValue({ ok: true, entries: [entry(newer)] });
  rerender(<Cards messages={[old, usable, missing, newer]}/>);
  await screen.findByRole('button', { name: /newer\.ts/ });
  expect(screen.queryByRole('button', { name: /usable\.ts/ })).toBeNull();
});

it('does not let a late response from another session reveal its cards', async () => {
  const a = make('a'), b = make('b');
  const ownerB = { kind: 'gui' as const, id: 'session-b' };
  let release!: (value: unknown) => void;
  const api = currentApiMock();
  api.mockOf('turnChanges.list').mockReturnValueOnce(new Promise(resolve => { release = resolve; }))
    .mockResolvedValueOnce({ ok: true, entries: [entry(b, ownerB)] });
  const { rerender } = render(<Cards messages={[a]}/>);
  rerender(<Cards currentOwner={ownerB} messages={[b]}/>);
  await screen.findByRole('button', { name: /b\.ts/ });
  await act(async () => { release({ ok: true, entries: [entry(a)] }); });
  expect(screen.getByRole('button', { name: /b\.ts/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /a\.ts/ })).toBeNull();
});

it('rechecks the session when a previously valid snapshot disappears', async () => {
  const old = make('old'), latest = make('latest');
  const api = currentApiMock();
  api.mockOf('turnChanges.list').mockResolvedValueOnce({ ok: true, entries: [entry(latest)] })
    .mockResolvedValueOnce({ ok: true, entries: [entry(old)] });
  api.mockOf('turnChanges.diff').mockResolvedValue({ ok: false, error: '该轮没有文件改动快照' });
  render(<Cards messages={[old, latest]}/>);
  fireEvent.focus(await screen.findByRole('button', { name: /latest\.ts/ }));
  await screen.findByRole('button', { name: /old\.ts/ });
  expect(screen.queryByRole('button', { name: /latest\.ts/ })).toBeNull();
});

it('surfaces an actual list failure and allows a focus refresh', async () => {
  const a = make('a');
  const api = currentApiMock();
  api.mockOf('turnChanges.list').mockRejectedValueOnce(new Error('读取失败'))
    .mockResolvedValueOnce({ ok: true, entries: [entry(a)] });
  render(<Cards messages={[a]}/>);
  await screen.findByRole('alert');
  act(() => window.dispatchEvent(new Event('focus')));
  await waitFor(() => expect(screen.getByRole('button', { name: /a\.ts/ })).toBeTruthy());
  expect(screen.queryByRole('alert')).toBeNull();
});

it('defers checking hidden conversations until they become active', async () => {
  const a = make('a');
  const api = currentApiMock(); api.mockOf('turnChanges.list').mockResolvedValue({ ok: true, entries: [entry(a)] });
  const { rerender } = render(<Cards messages={[a]} active={false}/>);
  act(() => window.dispatchEvent(new Event('focus')));
  expect(api.mockOf('turnChanges.list')).not.toHaveBeenCalled();
  rerender(<Cards messages={[a]} active/>);
  await screen.findByRole('button', { name: /a\.ts/ });
  expect(api.mockOf('turnChanges.list')).toHaveBeenCalledTimes(1);
});

it('查询超时后提示并忽略迟到结果', async () => {
  vi.useFakeTimers();
  try {
    const a = make('timeout');
    let resolve!: (value: unknown) => void;
    currentApiMock().mockOf('turnChanges.list').mockReturnValue(new Promise(done => { resolve = done; }));
    render(<Cards messages={[a]}/>);
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(screen.getByRole('alert').textContent).toContain('本轮改动快照不可用');
    await act(async () => { resolve({ ok: true, entries: [entry(a)] }); });
    expect(screen.queryByRole('button', { name: /timeout\.ts/ })).toBeNull();
  } finally { vi.useRealTimers(); }
});
