import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatResetDialog, RESET_MEMORY_PROMPT, type ChatResetTarget } from '../../src/renderer/src/components/ChatResetDialog';
import type { ChatSurface } from '../../src/shared/chatSurface';
import { getDraft, setDraft } from '../../src/renderer/src/composerDrafts';
import { applyLocaleSetting } from '../../src/shared/i18n';

beforeEach(() => setDraft('one', ''));

function setup(purpose: ChatResetTarget['purpose'] = 'dispatch', busy = false) {
  const send = vi.fn(async () => true), clear = vi.fn(async () => {});
  const snapshot = { messages: [], busy, queuedCount: 0, queuedItems: [], status: null, mode: null, preset: null };
  const surface: ChatSurface = {
    sessionId: 'one', caps: { surfaceKind: 'gui-session', draftKey: 'one', images: false },
    subscribe: () => () => {}, getSnapshot: () => snapshot,
    actions: { send, clear, stop: () => {}, retry: () => {}, cancelQueued: () => {} }
  };
  function Harness() {
    const [target, setTarget] = useState<ChatResetTarget | null>({ workspaceId: 'one', purpose, surface });
    return <ChatResetDialog target={target} onClose={() => setTarget(null)}/>;
  }
  render(<Harness/>);
  return { send, clear };
}

it.each([
  ['dispatch', 'Reset dispatcher conversation?'],
  ['memory', 'Reset memory conversation?'],
  ['safety', 'Reset approval conversation?']
] as const)('%s 重置确认框随语言切换且不会自动执行', async (purpose, title) => {
  const { clear, send } = setup(purpose);
  try {
    act(() => { applyLocaleSetting('en'); });
    expect(await screen.findByRole('dialog', { name: title })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirm reset' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    if (purpose !== 'safety') expect(screen.getByRole('button', { name: 'Fill memory prompt' })).toBeTruthy();
    expect(clear).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
});

it.each(['dispatch', 'memory'] as const)('%s 重置必须确认，取消不发送也不清空', async purpose => {
  const { send, clear } = setup(purpose);
  expect(screen.getByRole('button', { name: '填入记忆提示词' })).toBeTruthy();
  expect(clear).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(clear).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
});

it('填入记忆提示词只修改草稿，不发送也不清空', async () => {
  const { send, clear } = setup();
  fireEvent.click(screen.getByRole('button', { name: '填入记忆提示词' }));
  expect(getDraft('one')).toBe(RESET_MEMORY_PROMPT);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(clear).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
});

it('确认重置仅清空一次，不发送记忆消息', async () => {
  const { send, clear } = setup();
  const confirm = screen.getByRole('button', { name: '确认重置' });
  fireEvent.click(confirm); fireEvent.click(confirm);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(clear).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
});

it('已有草稿保留，提示词追加在后面', async () => {
  const { send, clear } = setup(); setDraft('one', '尚未发送的内容');
  fireEvent.click(screen.getByRole('button', { name: '填入记忆提示词' }));
  expect(getDraft('one')).toBe(`尚未发送的内容\n\n${RESET_MEMORY_PROMPT}`);
  expect(clear).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
});

it('重置失败保留确认框并显示实际错误', async () => {
  const { clear } = setup(); clear.mockRejectedValue(new Error('清空失败'));
  fireEvent.click(screen.getByRole('button', { name: '确认重置' }));
  expect((await screen.findByRole('alert')).textContent).toBe('清空失败');
  expect(screen.getByRole('dialog')).toBeTruthy();
});

it('审批重置说明取消待办并保留规则记录，处理中也只能确认后重置一次', async () => {
  const { send, clear } = setup('safety', true);
  expect(screen.getByRole('dialog', { name: '重置审批会话？' })).toBeTruthy();
  expect(screen.getByText(/取消尚未完成的审批/)).toBeTruthy();
  expect(screen.getByText(/保留放行规则和审批事项记录/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: '填入记忆提示词' })).toBeNull();
  expect(clear).not.toHaveBeenCalled();
  const confirm = screen.getByRole('button', { name: '确认重置' });
  fireEvent.click(confirm); fireEvent.click(confirm);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(clear).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
});
