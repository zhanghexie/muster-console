import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NativeConfigLaunchFields, NativeSessionConfigControl } from '../../src/renderer/src/components/NativeSessionConfig';
import { ApprovalCard } from '../../src/renderer/src/chatSurface/guiApprovalCards';
import type { NativeConfigSnapshot } from '../../src/shared/nativeSessionConfig';
import { currentApiMock } from './helpers/api-mock';
import { applyLocaleSetting } from '../../src/shared/i18n';
import { AppTipHost } from '../../src/renderer/src/components/AppTip';
import { dismissTip } from '../../src/renderer/src/tips';

afterEach(() => { act(() => dismissTip()); });

function snapshot(revision: number, currentValue = 'build', runtimeId = 'acp'): NativeConfigSnapshot {
  return { identity: { runtimeId, presetId: 'fixture', sourceKey: 'workspace' }, revision, source: 'session', status: 'ready', options: [{
    id: 'permission-mode', name: 'Native workspace mode', description: 'Controls how native permissions are requested.',
    category: '_unfamiliar', type: 'select', currentValue, changePolicy: 'live',
    choices: [{ id: 'modes', name: 'Native modes', choices: [{ value: 'build', name: 'Build', description: 'Native build permissions.' }, { value: 'architect-v2', name: 'Architect v2' }] }]
  }, { id: 'review', name: 'Use native reviewer', type: 'boolean', currentValue: false, changePolicy: 'idle' }] };
}

test.each(['launch', 'session'])('localizes %s setting titles without changing native choices or values', async entry => {
  const api = currentApiMock();
  const state = snapshot(1);
  const titles = [
    ['Permission Mode', '权限模式'], ['Sandbox', '沙箱'], ['Multitask', '多任务'],
    ['Workflow mode', '工作流模式'], ['Approval Policy', '审批策略'], ['Collaboration Mode', '协作模式'],
    ['Experimental boundary', 'Experimental boundary']
  ];
  state.options = titles.map(([name], index) => ({ ...state.options[0], id: `native-${index}`, name }));
  api.override('agentSession.describeNativeConfig', async () => ({ ...state, source: 'catalog' }));
  api.override('agentSession.getNativeConfig', async () => state);
  api.override('agentSession.setNativeConfig', async () => ({ ok: true, snapshot: state }));
  const onChange = vi.fn();
  try {
    act(() => { applyLocaleSetting('zh-CN'); });
    render(entry === 'launch'
      ? <NativeConfigLaunchFields target={{ runtimeId: 'acp', source: { workspaceId: 'w', rootId: 'root' } }} onChange={onChange} />
      : <NativeSessionConfigControl sessionId="worker" busy={false} />);
    if (entry === 'session') fireEvent.click(screen.getByRole('button', { name: '引擎设置' }));
    for (const [, title] of titles) expect(await screen.findByRole('button', { name: title })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '权限模式' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Architect v2' }));
    if (entry === 'launch') expect(onChange).toHaveBeenCalledWith({ identity: state.identity, selections: [{ id: 'native-0', value: 'architect-v2' }] });
    else await waitFor(() => expect(api.mockOf('agentSession.setNativeConfig')).toHaveBeenCalledWith('worker', {
      identity: state.identity, revision: 1, id: 'native-0', value: 'architect-v2'
    }));
    act(() => { applyLocaleSetting('en'); });
    expect(screen.getByRole('button', { name: 'Permission Mode' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Multitask' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Experimental boundary' })).toBeTruthy();
  } finally {
    act(() => { applyLocaleSetting('zh-CN'); });
  }
});

test.each(['launch', 'session'])('%s refresh stays accessible with an empty catalog and moves beside the first title', async entry => {
  const api = currentApiMock();
  const empty = { ...snapshot(1), options: [] };
  let complete!: (value: NativeConfigSnapshot) => void;
  const refreshResult = new Promise<NativeConfigSnapshot>(resolve => { complete = resolve; });
  api.override('agentSession.describeNativeConfig', async ({ refresh }: { refresh?: boolean }) => refresh ? refreshResult : empty);
  api.override('agentSession.getNativeConfig', async () => empty);
  api.override('agentSession.refreshNativeConfig', () => refreshResult);
  render(entry === 'launch'
    ? <NativeConfigLaunchFields target={{ runtimeId: 'acp', source: { workspaceId: 'w', rootId: 'root' } }} onChange={() => {}} />
    : <NativeSessionConfigControl sessionId="worker" busy={false} />);
  if (entry === 'session') fireEvent.click(screen.getByRole('button', { name: '引擎设置' }));
  const refresh = await screen.findByRole('button', { name: '刷新引擎设置' });
  await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
  expect(refresh.textContent).toBe('');
  expect(refresh.title).toBe('刷新引擎设置');
  fireEvent.click(refresh);
  expect((refresh as HTMLButtonElement).disabled).toBe(true);
  expect(refresh.getAttribute('aria-busy')).toBe('true');
  if (entry === 'launch') expect(api.mockOf('agentSession.describeNativeConfig')).toHaveBeenLastCalledWith({
    runtimeId: 'acp', source: { workspaceId: 'w', rootId: 'root' }, refresh: true
  });
  else expect(api.mockOf('agentSession.refreshNativeConfig')).toHaveBeenCalledWith('worker');
  await act(async () => complete(snapshot(2)));
  await screen.findByRole('button', { name: 'Native workspace mode' });
  const placed = screen.getByRole('button', { name: '刷新引擎设置' });
  expect(placed.closest('.native-config-field-heading')?.textContent).toBe('Native workspace mode');
  expect((placed as HTMLButtonElement).disabled).toBe(false);
});

test('engine settings use advertised IDs and do not mark a rejected change as active', async () => {
  const api = currentApiMock();
  api.override('agentSession.getNativeConfig', async () => snapshot(1));
  api.override('agentSession.setNativeConfig', async () => ({ ok: false, error: 'Engine refused the change' }));
  const view = render(<><NativeSessionConfigControl sessionId="worker" busy /><AppTipHost /></>);
  fireEvent.click(screen.getByRole('button', { name: '引擎设置' }));
  const trigger = await screen.findByRole('button', { name: 'Native workspace mode' });
  expect(trigger.textContent).toContain('Build');
  expect(screen.queryByText('Controls how native permissions are requested.')).toBeNull();
  expect((screen.getByRole('button', { name: 'Use native reviewer' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const listbox = await screen.findByRole('listbox');
  expect(within(listbox).getByText('Native modes')).toBeTruthy();
  expect(within(listbox).queryByText('Native build permissions.')).toBeNull();
  fireEvent.keyDown(listbox, { key: 'ArrowDown' });
  fireEvent.keyDown(listbox, { key: 'Enter' });
  await waitFor(() => expect(api.mockOf('agentSession.setNativeConfig')).toHaveBeenCalledWith('worker', {
    identity: snapshot(1).identity, revision: 1, id: 'permission-mode', value: 'architect-v2'
  }));
  expect((await screen.findByRole('status')).textContent).toContain('Engine refused the change');
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(view.container.contains(screen.getByRole('status'))).toBe(false);
  expect(trigger.textContent).toContain('Build');
  act(() => api.emit('agentSession:event', { kind: 'native-config', sessionId: 'worker', snapshot: snapshot(2, 'architect-v2') }));
  expect(trigger.textContent).toContain('Architect v2');
});

test('old session reads cannot replace the new session, and retirement clears observed options', async () => {
  const api = currentApiMock();
  let complete!: (value: NativeConfigSnapshot) => void;
  api.override('agentSession.getNativeConfig', (id: string) => id === 'old' ? new Promise(resolve => { complete = resolve; }) : Promise.resolve(snapshot(2, 'architect-v2')));
  const { rerender } = render(<NativeSessionConfigControl sessionId="old" busy={false} />);
  fireEvent.click(screen.getByRole('button', { name: '引擎设置' }));
  rerender(<NativeSessionConfigControl sessionId="new" busy={false} />);
  fireEvent.click(screen.getByRole('button', { name: '引擎设置' }));
  const trigger = await screen.findByRole('button', { name: 'Native workspace mode' });
  await act(async () => complete(snapshot(30)));
  expect(trigger.textContent).toContain('Architect v2');
  act(() => api.emit('agentSession:event', { kind: 'native-config', sessionId: 'new',
    snapshot: { ...snapshot(31), status: 'uninitialized', options: [] } }));
  expect(screen.queryByRole('button', { name: 'Native workspace mode' })).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('尚未读取引擎设置');
});

test('false stays pending until the native notification and an earlier read cannot undo confirmation', async () => {
  const api = currentApiMock();
  const review = (revision: number, value: boolean) => {
    const state = snapshot(revision);
    state.options[1].currentValue = value;
    return state;
  };
  let lateRead!: (value: NativeConfigSnapshot) => void;
  let reads = 0;
  api.override('agentSession.getNativeConfig', () => ++reads === 1 ? Promise.resolve(review(1, true)) : new Promise(resolve => { lateRead = resolve; }));
  api.override('agentSession.setNativeConfig', async () => ({ ok: true, pending: true,
    snapshot: { ...review(2, true), requested: [{ id: 'review', value: false }] } }));
  render(<NativeSessionConfigControl sessionId="worker" busy={false} />);
  const toggle = screen.getByRole('button', { name: '引擎设置' });
  fireEvent.click(toggle);
  const button = await screen.findByRole('button', { name: 'Use native reviewer' });
  fireEvent.click(button);
  fireEvent.click(await screen.findByRole('option', { name: '关闭' }));
  await waitFor(() => expect(api.mockOf('agentSession.setNativeConfig')).toHaveBeenCalledWith('worker', {
    identity: snapshot(1).identity, revision: 1, id: 'review', value: false
  }));
  expect((await screen.findByRole('status')).textContent).toContain('等待引擎确认设置');
  expect(button.textContent).toContain('开启');
  fireEvent.click(toggle);
  fireEvent.click(toggle);
  act(() => api.emit('agentSession:event', { kind: 'native-config', sessionId: 'worker', snapshot: review(3, false) }));
  await act(async () => lateRead(review(1, true)));
  expect(button.textContent).toContain('关闭');
  expect(screen.queryByRole('status')).toBeNull();
});

test('creation follows engine defaults until an option is explicitly picked', async () => {
  const api = currentApiMock();
  const onChange = vi.fn();
  api.override('agentSession.describeNativeConfig', async () => ({ ...snapshot(1), source: 'catalog' }));
  render(<NativeConfigLaunchFields target={{ runtimeId: 'acp', presetId: 'fixture', source: { workspaceId: 'w', rootId: 'root' } }} onChange={onChange} />);
  const trigger = await screen.findByRole('button', { name: 'Native workspace mode' });
  expect(trigger.textContent).toContain('跟随引擎默认');
  expect(screen.queryByText('Controls how native permissions are requested.')).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  expect(within(await screen.findByRole('listbox')).queryByText('Native build permissions.')).toBeNull();
  fireEvent.click(await screen.findByRole('option', { name: 'Architect v2' }));
  expect(onChange).toHaveBeenCalledWith({ identity: snapshot(1).identity, selections: [{ id: 'permission-mode', value: 'architect-v2' }] });
});

test('native approval forwards the exact selected ID once', async () => {
  const api = currentApiMock();
  api.override('agentSession.respondApproval', async () => ({ ok: true }));
  render(<ApprovalCard sessionId="worker" approval={{ approvalId: 'approval', toolCallId: 'call', toolName: 'Review project',
    input: {}, nativeSource: 'ACP', nativeChoices: [
      { id: 'native-persisted-denial', name: 'Always decline in this project', kind: 'reject_always', scope: 'persistent' }
    ] }} />);
  const button = screen.getByRole('button', { name: /Always decline in this project/ });
  expect(button.textContent).toContain('持久规则');
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(api.mockOf('agentSession.respondApproval')).toHaveBeenCalledTimes(1));
  expect(api.mockOf('agentSession.respondApproval')).toHaveBeenCalledWith({ sessionId: 'worker', approvalId: 'approval', nativeChoiceId: 'native-persisted-denial' });
});
