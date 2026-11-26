import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentComposer } from '../../src/renderer/src/components/AgentComposer';
import { SessionReminders } from '../../src/renderer/src/components/SessionReminders';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';

it.each([
  ['dispatch', 'scheduler', { kind: 'scheduler', workspaceId: 'ws' }],
  ['gui-session', 'session', { kind: 'session', sessionId: 'ws' }]
] as const)('在 %s 输入框底栏打开当前会话待办，不改变草稿', async (surfaceKind, kind, target) => {
  const api = currentApiMock();
  api.override('sessionReminders.list', async () => ({ scope: 'scope', items: [{ id: 'r', text: '确认方案',
    createdAt: 1, completedAt: null, completedBy: null, sourceMessageId: null }] }));
  const user = userEvent.setup();
  const view = render(<StoreProvider><AgentComposer workspaceId="ws" surfaceKind={surfaceKind} busy={false}
    onClear={async () => {}} onSend={async () => true}
    reminders={<SessionReminders kind={kind} id="ws" visible/>}/></StoreProvider>);
  const editor = screen.getByRole('textbox');
  await user.type(editor, '保留草稿');
  const trigger = screen.getByRole('button', { name: '用户待办提醒' });
  expect(trigger.closest('.agent-composer-toolbar')).toBeTruthy();
  await waitFor(() => expect(trigger.textContent).toContain('1'));
  expect(api.mockOf('sessionReminders.list')).toHaveBeenCalledWith(target);
  await user.click(trigger);
  const panel = screen.getByRole('dialog', { name: '用户待办提醒' });
  expect(panel.parentElement).toBe(trigger.closest('.session-reminder-overlay'));
  expect(panel.classList.contains('mp-pop-up')).toBe(true);
  expect(within(panel).getByText('确认方案')).toBeTruthy();
  expect(editor.textContent).toContain('保留草稿');
  await user.click(within(panel).getByRole('button', { name: '关闭用户待办提醒' }));
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(view.container.querySelector('.composer-editable')).toBe(editor);
  expect(editor.textContent).toContain('保留草稿');
});
