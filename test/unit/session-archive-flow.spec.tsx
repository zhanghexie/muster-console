import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { SessionMeta } from '../../src/shared/types';
import { useArchiveFlow } from '../../src/renderer/src/components/sessionArchiveFlow';
import { currentApiMock } from './helpers/api-mock';

const session: SessionMeta = { id: 'worker', name: 'Worker', type: 'terminal', createdAt: 1, worktreePath: 'task-tree',
  phase: { value: 'needs_you', source: 'user' } } as SessionMeta;
function Harness() {
  const flow = useArchiveFlow();
  return <><button onClick={() => flow.requestArchive(session, true, { activeId: 'worker', nextId: 'next' })}>archive</button>
    <button onClick={() => flow.requestArchive({ ...session, worktreePath: undefined, lifecycle: 'working', phase: { value: 'done', source: 'user', ts: 1 } }, true)}>archive busy</button>
    <button onClick={() => flow.requestArchive({ ...session, worktreePath: undefined, worktreeGroups: { groups: [{}] } as unknown as SessionMeta['worktreeGroups'] }, true)}>archive group</button>
    <button onClick={() => flow.requestArchive({ ...session, archived: true }, false)}>restore</button>{flow.archiveFlowNode}</>;
}

it('also confirms unfinished multi-repository worktrees', () => {
  render(<Harness/>);
  fireEvent.click(screen.getByText('archive group'));
  expect(currentApiMock().mockOf('sessions.setArchived')).not.toHaveBeenCalled();
  expect(screen.getByText('归档隔离会话')).toBeTruthy();
});

it('confirms unfinished isolated work before archiving, but restores directly', async () => {
  render(<Harness/>);
  fireEvent.click(screen.getByText('archive'));
  expect(currentApiMock().mockOf('sessions.setArchived')).not.toHaveBeenCalled();
  expect(screen.getByText('归档隔离会话')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^归档$/ }));
  expect(currentApiMock().mockOf('sessions.setArchived')).toHaveBeenCalledWith('worker', true, { activeId: 'worker', nextId: 'next' });
  await waitFor(() => expect(screen.queryByText('归档隔离会话')).toBeNull());
  fireEvent.click(screen.getByText('restore'));
  expect(currentApiMock().mockOf('sessions.setArchived')).toHaveBeenCalledWith('worker', false);
});

it('shows archive and restore failures instead of silently discarding them', async () => {
  currentApiMock().override('sessions.setArchived', async () => { throw Error("Error invoking remote method 'sessions:setArchived': Error: epoch storage unavailable"); });
  render(<Harness/>);
  fireEvent.click(screen.getByText('restore'));
  expect(await screen.findByText('会话恢复失败')).toBeTruthy();
  expect(screen.getByText(/epoch storage unavailable/)).toBeTruthy();
  expect(screen.queryByText(/Error invoking remote method/)).toBeNull();
  fireEvent.click(screen.getByText('知道了'));
  await waitFor(() => expect(screen.queryByText('会话恢复失败')).toBeNull());
  fireEvent.click(screen.getByText('archive'));
  fireEvent.click(screen.getByRole('button', { name: /^归档$/ }));
  expect(await screen.findByText('会话归档失败')).toBeTruthy();
  expect(screen.getByText(/epoch storage unavailable/)).toBeTruthy();
});

it('puts cancel in focus and requires confirmation to stop an executing session marked done', async () => {
  render(<Harness/>);
  fireEvent.click(screen.getByText('archive busy'));
  expect(screen.getByRole('dialog', { name: '停止并归档？' })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' }));
  expect(currentApiMock().mockOf('sessions.setArchived')).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(currentApiMock().mockOf('sessions.setArchived')).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByText('archive busy'));
  fireEvent.click(screen.getByRole('button', { name: '停止并归档' }));
  expect(currentApiMock().mockOf('sessions.setArchived')).toHaveBeenCalledWith('worker', true, undefined, ['worker']);
});
