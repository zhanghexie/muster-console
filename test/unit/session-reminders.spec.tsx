import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionReminders } from '../../src/renderer/src/components/SessionReminders';
import { closeTopOverlay } from '../../src/renderer/src/keybindings/overlayStack';
import type { SessionReminder, SessionReminderSnapshot, SessionReminderTarget } from '../../src/shared/sessionReminders';
import { applyLocaleSetting, t } from '../../src/shared/i18n';
import { currentApiMock } from './helpers/api-mock';

beforeEach(() => dismissTip());

const initial: SessionReminder[] = [
  { id: 'a', text: '确认目标分支', createdAt: 1, completedAt: null, completedBy: null, sourceMessageId: 'message-a' },
  { id: 'b', text: '确定显示位置', createdAt: 2, completedAt: 3, completedBy: 'ai', sourceMessageId: null }
];

it('provides English labels and interpolates reminder counts in both languages', () => {
  try {
    applyLocaleSetting('en');
    expect(t('用户待办提醒')).toBe('Reminders for you');
    expect(t('关闭用户待办提醒')).toBe('Close reminders for you');
    expect(t('我的提醒')).toBe('My reminders');
    expect(t('当前会话 · {{number}} 项待处理', { number: 2 })).toBe('Current conversation · 2 pending');
    expect(t('标记完成：{{text}}', { text: 'Branch' })).toBe('Mark complete: Branch');
    expect(t('删除提醒：{{text}}', { text: 'Branch' })).toBe('Delete reminder: Branch');
    applyLocaleSetting('zh-CN');
    expect(t('当前会话 · {{number}} 项待处理', { number: 2 })).toBe('当前会话 · 2 项待处理');
  } finally { applyLocaleSetting('zh-CN'); }
});

it('lets the user delete pending and completed items, preserving other reminders and updating the count', async () => {
  const user = userEvent.setup();
  const api = currentApiMock();
  let items = structuredClone(initial);
  api.override('sessionReminders.list', async () => ({ scope: 'scope-a', items: structuredClone(items) }));
  api.override('sessionReminders.delete', async (_target, _scope, id) => { items = items.filter(item => item.id !== id); });
  render(<SessionReminders kind="session" id="gui" visible/>);
  const trigger = screen.getByRole('button', { name: '用户待办提醒' });
  expect(trigger.textContent).toContain('我的提醒');
  await waitFor(() => expect(trigger.textContent).toContain('1'));
  await user.click(trigger);
  await user.click(screen.getByRole('button', { name: '删除提醒：确认目标分支' }));
  await waitFor(() => expect(trigger.querySelector('.session-reminder-count')).toBeNull());
  expect(screen.getByRole('button', { name: '用户待办提醒' })).toBe(trigger);
  expect(screen.queryByText('确认目标分支')).toBeNull();
  expect(screen.getByText('确定显示位置')).toBeTruthy();
  expect(api.mockOf('sessionReminders.delete')).toHaveBeenCalledWith({ kind: 'session', sessionId: 'gui' }, 'scope-a', 'a');
  expect(api.mockOf('sessionReminders.setCompleted')).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '删除提醒：确定显示位置' }));
  await waitFor(() => expect(screen.queryByText('确定显示位置')).toBeNull());
});

it('keeps an item visible and reports a failed deletion', async () => {
  const api = currentApiMock();
  api.override('sessionReminders.list', async () => ({ scope: 'scope', items: initial }));
  api.override('sessionReminders.delete', async () => { throw new Error('offline'); });
  const user = userEvent.setup();
  render(<SessionReminders kind="session" id="gui" visible/>);
  await user.click(screen.getByRole('button', { name: '用户待办提醒' }));
  await user.click(await screen.findByRole('button', { name: '删除提醒：确认目标分支' }));
  await waitFor(() => expect(getTipSnapshot()?.text).toContain('offline'));
  expect(screen.getByText('确认目标分支')).toBeTruthy();
  expect(screen.getByRole('button', { name: '用户待办提醒' }).textContent).toContain('!');
});

it('ignores a deletion result that arrives after switching conversations', async () => {
  const api = currentApiMock();
  let finishDelete!: () => void;
  api.override('sessionReminders.list', async (target: SessionReminderTarget) => ({
    scope: target.kind === 'session' ? target.sessionId : '',
    items: [{ ...initial[0], text: target.kind === 'session' && target.sessionId === 'new' ? '新会话提醒' : '旧会话提醒' }]
  }));
  api.override('sessionReminders.delete', () => new Promise<void>(resolve => { finishDelete = resolve; }));
  const user = userEvent.setup();
  const { rerender } = render(<SessionReminders kind="session" id="old" visible/>);
  await user.click(screen.getByRole('button', { name: '用户待办提醒' }));
  await user.click(await screen.findByRole('button', { name: '删除提醒：旧会话提醒' }));
  rerender(<SessionReminders kind="session" id="new" visible/>);
  const next = await screen.findByRole('button', { name: '删除提醒：新会话提醒' });
  await act(async () => finishDelete());
  expect((next as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText('新会话提醒')).toBeTruthy();
  expect(screen.queryByText('旧会话提醒')).toBeNull();
});

it('floats a conversation checklist, updates the count, preserves focus and navigates to a real source', async () => {
  const user = userEvent.setup();
  const api = currentApiMock();
  let items = structuredClone(initial);
  api.override('sessionReminders.list', async () => ({ scope: 'scope-a', items: structuredClone(items) }));
  api.override('sessionReminders.setCompleted', async (_target, _scope, id, done) => {
    items = items.map(item => item.id === id ? { ...item, completedAt: done ? 4 : null, completedBy: done ? 'user' : null } : item);
    return items.find(item => item.id === id);
  });
  const source = vi.fn(() => true);
  const { container } = render(<div style={{ position: 'relative' }}><SessionReminders kind="session" id="gui" visible onOpenSource={source}/></div>);
  const trigger = screen.getByRole('button', { name: '用户待办提醒' });
  await waitFor(() => expect(trigger.textContent).toContain('1'));
  expect(container.querySelector('.session-reminder-overlay')).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.click(trigger);
  const panel = screen.getByRole('dialog', { name: '用户待办提醒' });
  expect(within(panel).getByText('由 AI 完成')).toBeTruthy();
  await user.click(within(panel).getByRole('checkbox', { name: '标记完成：确认目标分支' }));
  await waitFor(() => expect(trigger.querySelector('.session-reminder-count')).toBeNull());
  expect(within(panel).getByText('当前会话')).toBeTruthy();
  const completed = await within(panel).findByRole('checkbox', { name: '重新打开：确认目标分支' });
  await waitFor(() => expect(document.activeElement).toBe(completed));
  expect(api.mockOf('sessionReminders.setCompleted')).toHaveBeenCalledWith({ kind: 'session', sessionId: 'gui' }, 'scope-a', 'a', true);
  await user.click(completed);
  await waitFor(() => expect(trigger.textContent).toContain('1'));
  await user.click(within(panel).getByRole('button', { name: '查看原消息' }));
  expect(source).toHaveBeenCalledWith('message-a');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});

it('refreshes from host events, closes on Escape and does not offer a fake CLI source', async () => {
  const user = userEvent.setup();
  const api = currentApiMock();
  let items: SessionReminder[] = [];
  api.override('sessionReminders.list', async () => ({ scope: 'cli', items: structuredClone(items) }));
  render(<SessionReminders kind="session" id="cli" visible/>);
  const trigger = screen.getByRole('button', { name: '用户待办提醒' });
  await user.click(trigger);
  items = [{ ...initial[0], sourceMessageId: null }];
  act(() => api.emit('sessionReminders:changed', { kind: 'session', sessionId: 'cli' }));
  expect(await screen.findByText('确认目标分支')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '查看原消息' })).toBeNull();
  const portal = document.createElement('div'); portal.setAttribute('data-overlay-root', ''); document.body.append(portal);
  fireEvent.pointerDown(portal);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  portal.remove();
  await user.click(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  await user.click(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(await screen.findByText('确认目标分支')).toBeTruthy();
  act(() => { closeTopOverlay(); });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});

it('hides the overlay and releases Escape when its conversation is not visible', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<SessionReminders kind="session" id="gui" visible/>);
  await user.click(screen.getByRole('button', { name: '用户待办提醒' }));
  expect(screen.getByRole('dialog', { name: '用户待办提醒' })).toBeTruthy();
  rerender(<SessionReminders kind="session" id="gui" visible={false}/>);
  expect(screen.queryByRole('button', { name: '用户待办提醒' })).toBeNull();
  expect(closeTopOverlay()).toBe(false);
});

it('ignores a late response from a different conversation', async () => {
  const api = currentApiMock();
  let resolveOld!: (snapshot: SessionReminderSnapshot) => void;
  const old = new Promise<SessionReminderSnapshot>(resolve => { resolveOld = resolve; });
  api.override('sessionReminders.list', (target: SessionReminderTarget) => target.kind === 'session' && target.sessionId === 'old'
    ? old : Promise.resolve({ scope: 'new-scope', items: [{ ...initial[0], id: 'new', text: '新会话提醒' }] }));
  const { rerender } = render(<SessionReminders kind="session" id="old" visible/>);
  rerender(<SessionReminders kind="session" id="new" visible/>);
  await userEvent.click(screen.getByRole('button', { name: '用户待办提醒' }));
  expect(await screen.findByText('新会话提醒')).toBeTruthy();
  await act(async () => resolveOld({ scope: 'old-scope', items: initial }));
  expect(screen.queryByText('确认目标分支')).toBeNull();
  expect(screen.getByText('新会话提醒')).toBeTruthy();
});

it('does not let a late completion replace or disable a newly selected conversation', async () => {
  const api = currentApiMock();
  let resolveUpdate!: () => void;
  api.override('sessionReminders.list', async (target: SessionReminderTarget) => ({ scope: target.kind === 'session' ? target.sessionId : '',
    items: [{ ...initial[0], text: target.kind === 'session' && target.sessionId === 'new' ? '新会话提醒' : '旧会话提醒' }] }));
  api.override('sessionReminders.setCompleted', () => new Promise<void>(resolve => { resolveUpdate = resolve; }));
  const user = userEvent.setup();
  const { rerender } = render(<SessionReminders kind="session" id="old" visible/>);
  await user.click(screen.getByRole('button', { name: '用户待办提醒' }));
  await user.click(await screen.findByRole('checkbox', { name: '标记完成：旧会话提醒' }));
  rerender(<SessionReminders kind="session" id="new" visible/>);
  const next = await screen.findByRole('checkbox', { name: '标记完成：新会话提醒' });
  await act(async () => resolveUpdate());
  expect((next as HTMLInputElement).disabled).toBe(false);
  expect(screen.queryByText('旧会话提醒')).toBeNull();
  expect(screen.getByText('新会话提醒')).toBeTruthy();
});

it('shows failures instead of treating an unreadable list as empty, and lets the user retry', async () => {
  const api = currentApiMock();
  let available = false;
  api.override('sessionReminders.list', async () => {
    if (!available) throw new Error('offline');
    return { scope: 'scope', items: initial };
  });
  const user = userEvent.setup();
  render(<SessionReminders kind="session" id="gui" visible/>);
  const trigger = screen.getByRole('button', { name: '用户待办提醒' });
  await waitFor(() => expect(trigger.textContent).toContain('!'));
  await user.click(trigger);
  expect(getTipSnapshot()?.text).toContain('offline');
  available = true;
  await user.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('确认目标分支')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});
