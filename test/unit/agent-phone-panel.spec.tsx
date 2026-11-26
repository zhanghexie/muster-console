import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { AgentFloat } from '../../src/renderer/src/panels/AgentFloat';
import { resetOrchestratorListenersForTest } from '../../src/renderer/src/chatSurface/orchestratorSurface';
import { builtInAgentApps } from '../../src/shared/agentAppsBuiltins';
import { currentApiMock } from './helpers/api-mock';
import { phonePosition } from '../../src/renderer/src/agentApps/phonePosition';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { pushOverlay, popOverlay } from '../../src/renderer/src/keybindings/overlayStack';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
let scenario = 0;
function setup() {
  const id = `phone-panel-${++scenario}`, mock = currentApiMock();
  const workspaces = [{ id, name: '手机工作区', path: 'E:/demo/phone', openedAt: 1 }];
  mock.override('workspaces.list', async () => ({ workspaces, activeWorkspaceId: id }));
  mock.override('config.get', async () => ({ workspaces, activeWorkspaceId: id, locale: 'zh-CN' }));
  mock.override('agentApps.snapshot', async () => ({ workspaceId: id, apps: builtInAgentApps().map(definition => ({ definition, enabled: true, installedAt: 1 })), connections: [], operations: [], errors: [] }));
  mock.override('agentApps.query', async () => ({ records: [], total: 0 }));
  resetOrchestratorListenersForTest();
  localStorage.removeItem('muster.agentPhone.auto');
  render(<StoreProvider><KeybindingProvider><AgentFloat stackInline/></KeybindingProvider></StoreProvider>);
  return { id, mock };
}

it('只显示手机外壳，不禁用调度正文；开合可反转，记忆互斥', async () => {
  const { mock } = setup();
  await screen.findByTitle(/手机工作区/);
  fireEvent.click(document.querySelector('.agent-ws-stack:not(.agent-ws-stack-ghost) .agent-notify-chat')!);
  const trigger = await screen.findByRole('button', { name: '打开手机应用' });
  await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(trigger);
  const phone = await screen.findByRole('region', { name: '手机工作区的手机' });
  await screen.findByRole('heading', { name: '我的应用' });
  expect(phone.querySelector('.ap-panel-toolbar')).toBeNull();
  expect(document.querySelector('.agent-phone-sheet-host')).toBeNull();
  expect(parseFloat(phone.style.width)).toBe(310);
  expect(document.querySelector('[data-agent-purpose="dispatch"]')?.hasAttribute('inert')).toBe(false);
  fireEvent.click(trigger); expect(phone.getAttribute('data-mp-stage')).toBe('out');
  expect(phone.textContent).toContain('我的应用');
  fireEvent.click(trigger); expect(phone.getAttribute('data-mp-stage')).toBe('in');
  expect(screen.getByRole('region')).toBe(phone);
  const editor = within(document.querySelector('[data-agent-purpose="dispatch"]') as HTMLElement).getByRole('textbox');
  fireEvent.pointerDown(editor); editor.focus(); fireEvent.click(editor);
  expect(document.activeElement).toBe(editor);
  expect(mock.mockOf('chat.clear')).not.toHaveBeenCalled();
  expect(phone.getAttribute('data-mp-stage')).toBe('in');
  fireEvent.click(screen.getByRole('button', { name: '打开记忆子系统' }));
  await screen.findByRole('dialog', { name: '记忆子系统' });
  expect(phone.getAttribute('data-mp-stage')).toBe('out');
  fireEvent.click(trigger);
  expect(phone.getAttribute('data-mp-stage')).toBe('in');
  expect(screen.queryByRole('dialog', { name: '记忆子系统' })).toBeNull();
  within(phone).getByRole('button', { name: '手机主页' }).focus();
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(phone.getAttribute('data-mp-stage')).toBe('out');
  expect(document.activeElement).toBe(trigger);
});

it('全局已有浮层时 Escape 只收起手机，关闭后恢复手机按钮焦点', async () => {
  const backgroundClose = vi.fn(), background = pushOverlay(backgroundClose);
  try {
    setup(); await screen.findByTitle(/手机工作区/);
    fireEvent.click(document.querySelector('.agent-ws-stack:not(.agent-ws-stack-ghost) .agent-notify-chat')!);
    const trigger = await screen.findByRole('button', { name: '打开手机应用' });
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(trigger);
    const phone = await screen.findByRole('region', { name: '手机工作区的手机' });
    const home = within(phone).getByRole('button', { name: '手机主页' }); home.focus();
    fireEvent.keyDown(home, { key: 'Escape' });
    expect(phone.getAttribute('data-mp-stage')).toBe('out');
    expect(document.activeElement).toBe(trigger);
    expect(backgroundClose).not.toHaveBeenCalled();
  } finally { popOverlay(background); }
});

it('调度面板收起时工具也能展开手机和调度输出，查看不再执行业务命令', async () => {
  const { id, mock } = setup(); await screen.findByTitle(/手机工作区/);
  act(() => mock.emit('agentApps:operation', { workspaceId: id, agentId: `orchestrator:${id}`, appId: 'tasks', commandId: 'list', title: '读取待办', operationId: 'open', sequence: 1, runId: 'run', actor: 'agent', phase: 'succeeded', at: 1, viewId: 'main' }));
  const phone = await screen.findByRole('region', { name: '手机工作区的手机' });
  await screen.findByRole('heading', { name: '待办' });
  expect(document.querySelector('.agent-float-panel')).not.toBeNull();
  expect(document.querySelector('[data-agent-purpose="dispatch"]')?.hasAttribute('inert')).toBe(false);
  expect(mock.mockOf('agentApps.call')).not.toHaveBeenCalled();
});

it('手机优先对齐调度面板中心；只有越出视口时才让位', () => {
  const anchor = { left: 240, right: 760, top: 300, bottom: 890 };
  const centered = phonePosition(anchor, { width: 1200, height: 900 });
  expect(centered.width).toBe(310);
  expect(centered.left + centered.width / 2).toBe((anchor.left + anchor.right) / 2);
  expect(centered.top + centered.height / 2).toBe((anchor.top + anchor.bottom) / 2);
  const topEdge = phonePosition({ left: 0, right: 360, top: 0, bottom: 260 }, { width: 1200, height: 900 });
  expect(topEdge.left + topEdge.width / 2).toBe(180); expect(topEdge.top).toBe(12);
  const narrow = phonePosition(anchor, { width: 390, height: 400 });
  expect(narrow.left).toBeGreaterThanOrEqual(12); expect(narrow.top).toBeGreaterThanOrEqual(12);
  expect(narrow.left + narrow.width).toBeLessThanOrEqual(378);
  expect(narrow.top + narrow.height).toBeLessThanOrEqual(388);
});
