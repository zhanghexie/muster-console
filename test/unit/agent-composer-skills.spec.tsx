/**
 * GUI 会话斜杠菜单收录 skill（与调度同一 listSkills 数据源，不特判滤掉）。
 * 运行: npx vitest run test/unit/agent-composer-skills.spec.tsx
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi, beforeEach } from 'vitest';
import { AgentComposer } from '../../src/renderer/src/components/AgentComposer';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { popOverlay, pushOverlay } from '../../src/renderer/src/keybindings/overlayStack';

function freshProps() {
  return {
    workspaceId: 'ws-skills',
    busy: false,
    surfaceKind: 'gui-session' as const,
    onSend: vi.fn(async (_text: string) => true),
    onClear: vi.fn(async () => undefined)
  };
}

function typeInEditor(text: string): void {
  const editor = screen.getByRole('textbox');
  editor.textContent = text;
  fireEvent.input(editor);
}

describe('AgentComposer GUI skill 菜单', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
    if (typeof document.execCommand !== 'function') {
      document.execCommand = () => false;
    }
    currentApiMock().override('agent.listSkills', () =>
      Promise.resolve({
        skills: [{ name: 'journal', description: '写工作日志' }]
      })
    );
  });

  it('gui-session 斜杠菜单收录 /skill:journal', async () => {
    render(
      <StoreProvider>
        <AgentComposer {...freshProps()} />
      </StoreProvider>
    );
    typeInEditor('/');
    const item = await screen.findByRole('option', { name: /\/skill:journal/ });
    expect(item).toBeTruthy();
    expect(item.textContent).toMatch(/写工作日志/);
  });

  it.each(['claude-gui', 'codex-gui', 'cursor-gui', 'pi-gui'] as const)('技能菜单请求透传具体运行入口 %s', async target => {
    render(<StoreProvider><AgentComposer {...freshProps()} skillTarget={target} /></StoreProvider>);
    typeInEditor('/skill:journal');
    await screen.findByRole('option', { name: /\/skill:journal/ });
    expect(currentApiMock().mockOf('agent.listSkills')).toHaveBeenCalledWith('ws-skills', target);
  });

  it('调度菜单默认采用独立 pi-dispatcher 入口', async () => {
    render(<StoreProvider><AgentComposer {...freshProps()} surfaceKind="dispatch" /></StoreProvider>);
    typeInEditor('/skill:journal');
    await screen.findByRole('option', { name: /\/skill:journal/ });
    expect(currentApiMock().mockOf('agent.listSkills')).toHaveBeenCalledWith('ws-skills', 'pi-dispatcher');
  });

  it('菜单打开时关联变更刷新清单，晚到的旧关联结果不回填', async () => {
    const mock = currentApiMock(); let calls = 0;
    let finishOld: (result: unknown) => void = () => {};
    mock.override('agent.listSkills', () => ++calls === 1 ? new Promise(resolve => { finishOld = resolve; }) : Promise.resolve({ skills: [{ name: 'new-binding', description: 'Fresh' }] }));
    render(<StoreProvider><AgentComposer {...freshProps()} skillTarget="claude-gui" /></StoreProvider>);
    typeInEditor('/skill:');
    await waitFor(() => expect(calls).toBe(1));
    await act(async () => mock.emit('capabilityManagement:changed', { kind: 'skills', revision: 2 }));
    await screen.findByRole('option', { name: /\/skill:new-binding/ });
    await act(async () => finishOld({ skills: [{ name: 'old-binding', description: 'Stale' }] }));
    expect(screen.queryByRole('option', { name: /\/skill:old-binding/ })).toBeNull();
    expect(calls).toBe(2);
    expect(mock.mockOf('agent.listSkills')).toHaveBeenLastCalledWith('ws-skills', 'claude-gui');
    await act(async () => mock.emit('capabilityManagement:changed', { kind: 'mcp', revision: 3 }));
    expect(calls).toBe(2);
  });

  it('点选 skill 后插入 /skill:name，发送文本以技能命令开头', async () => {
    const props = freshProps();
    render(
      <StoreProvider>
        <AgentComposer {...props} />
      </StoreProvider>
    );
    typeInEditor('/');
    const item = await screen.findByRole('option', { name: /\/skill:journal/ });
    fireEvent.mouseDown(item);
    await waitFor(() => {
      expect(screen.getByRole('textbox').textContent).toMatch(/\/skill:journal/);
    });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1));
    const sent = props.onSend.mock.calls[0][0] as string;
    expect(sent.startsWith('/skill:journal')).toBe(true);
  });

  it('同名技能显示两个来源，点选第二根发送其限定命令', async () => {
    currentApiMock().override('agent.listSkills', () => Promise.resolve({ skills: [
      { name: 'fixture-review', description: 'Review', commandName: 'root:a/fixture-review', source: { label: 'Alpha', path: 'E:/Alpha' } },
      { name: 'fixture-review', description: 'Review', commandName: 'root:b/fixture-review', source: { label: 'Beta', path: 'D:/Beta' } }
    ] }));
    const props = freshProps();
    render(<StoreProvider><AgentComposer {...props} /></StoreProvider>);
    typeInEditor('/skill:fixture');
    const a = await screen.findByRole('option', { name: /Alpha/ });
    const b = await screen.findByRole('option', { name: /Beta/ });
    expect(a.textContent).toContain('E:/Alpha'); expect(b.textContent).toContain('D:/Beta');
    fireEvent.mouseDown(b);
    await waitFor(() => expect(screen.getByRole('textbox').textContent).toContain('/skill:root:b/fixture-review'));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1));
    expect(props.onSend.mock.calls[0][0]).toMatch(/^\/skill:root:b\/fixture-review/);
  });

  it('主进程返回技能来源错误时弹桌面通知，不当作空清单成功', async () => {
    currentApiMock().override('agent.listSkills', () => Promise.resolve({ skills: [], error: 'source folder changed' }));
    render(<StoreProvider><AgentComposer {...freshProps()} /></StoreProvider>);
    typeInEditor('/');
    // 输入框上方 hint 条已移除：错误不落 DOM，改弹桌面通知（notify.toast）
    await waitFor(() =>
      expect(currentApiMock().mockOf('notify.toast')).toHaveBeenCalledWith({
        text: expect.stringMatching(/source folder changed/)
      })
    );
    expect(screen.queryByText(/source folder changed/)).toBeNull();
  });

  it('Escape 后不被相同光标的 keyup 重新打开，随后 Enter 发送原文', async () => {
    const props = freshProps();
    render(<StoreProvider><AgentComposer {...props} /></StoreProvider>);
    typeInEditor('/skill:journal');
    await screen.findByRole('option', { name: /\/skill:journal/ });
    const editor = screen.getByRole('textbox');
    fireEvent.keyDown(editor, { key: 'Escape' });
    fireEvent.keyUp(editor, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(props.onSend).toHaveBeenCalledWith('/skill:journal', undefined));
    typeInEditor('/skill:journal again');
    typeInEditor('/skill:journal');
    expect(await screen.findByRole('option', { name: /\/skill:journal/ })).toBeTruthy();
  });

  it('全局 Escape 先关闭技能菜单，保留后方浮层并允许发送原文', async () => {
    const backgroundClose = vi.fn(); const layer = pushOverlay(backgroundClose);
    try {
      const props = freshProps();
      render(<KeybindingProvider><StoreProvider><AgentComposer {...props} /></StoreProvider></KeybindingProvider>);
      typeInEditor('/skill:journal');
      await screen.findByRole('option', { name: /\/skill:journal/ });
      const editor = screen.getByRole('textbox');
      fireEvent.keyDown(editor, { key: 'Escape' }); fireEvent.keyUp(editor, { key: 'Escape' });
      expect(backgroundClose).not.toHaveBeenCalled();
      expect(screen.queryByRole('listbox')).toBeNull();
      fireEvent.keyDown(editor, { key: 'Enter' });
      await waitFor(() => expect(props.onSend).toHaveBeenCalledWith('/skill:journal', undefined));
    } finally { popOverlay(layer); }
  });

  it('根显示名重复时仍用限定名消歧，完整路径和命令可查看', async () => {
    currentApiMock().override('agent.listSkills', () => Promise.resolve({ skills: [
      { name: 'fixture-review', description: 'Review', commandName: 'root:a/fixture-review', source: { label: 'Plugins', path: 'E:/Alpha' } },
      { name: 'fixture-review', description: 'Review', commandName: 'root:b/fixture-review', source: { label: 'Plugins', path: 'D:/Beta' } }
    ] }));
    render(<StoreProvider><AgentComposer {...freshProps()} /></StoreProvider>);
    typeInEditor('/skill:fixture');
    const second = await screen.findByRole('option', { name: /root:b\/fixture-review/ });
    expect(second.getAttribute('title')).toContain('D:/Beta');
    expect(second.getAttribute('title')).toContain('/skill:root:b/fixture-review');
  });

  it('根版本变化重新获取；晚到的旧来源结果不回填菜单', async () => {
    const mock = currentApiMock();
    const ws = { id: 'ws-skills', name: 'Skills', path: 'E:/Alpha', openedAt: 0, rootsRevision: 0 };
    mock.override('workspaces.list', async () => ({ workspaces: [ws], activeWorkspaceId: ws.id }));
    mock.override('config.get', async () => ({ workspaces: [ws], activeWorkspaceId: ws.id, locale: 'zh-CN' }));
    let finishOld: (value: unknown) => void = () => {}; let calls = 0;
    mock.override('agent.listSkills', () => ++calls === 1 ? new Promise(resolve => { finishOld = resolve; })
      : Promise.resolve({ skills: [{ name: 'fixture-review', commandName: 'fixture-review', description: 'Review', source: { label: 'Alpha', path: 'E:/Alpha' } }] }));
    render(<StoreProvider><AgentComposer {...freshProps()} /></StoreProvider>);
    await act(async () => { await Promise.resolve(); });
    typeInEditor('/skill:fixture');
    await waitFor(() => expect(calls).toBe(1));
    await act(async () => mock.emit('workspaces:changed', { workspaces: [{ ...ws, rootsRevision: 1 }], activeWorkspaceId: ws.id }));
    expect(await screen.findByRole('option', { name: /Alpha/ })).toBeTruthy();
    await act(async () => finishOld({ skills: [{ name: 'fixture-review', commandName: 'root:b/fixture-review', description: 'Review', source: { label: 'Beta', path: 'D:/Beta' } }] }));
    expect(screen.queryByRole('option', { name: /Beta/ })).toBeNull(); expect(calls).toBe(2);
  });
});
