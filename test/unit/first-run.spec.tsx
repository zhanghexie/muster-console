import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FirstRun } from '../../src/renderer/src/onboarding/FirstRun';
import { WorkbenchSetupGuide } from '../../src/renderer/src/onboarding/WorkbenchSetupGuide';
import { readSetupProgress, writeSetupProgress, type MoveSetup, type SetupState } from '../../src/renderer/src/onboarding/setupProgress';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';

const recommended = '/home/test/Muster';
const workspace = { id: 'new-ws', path: recommended, name: '我的工作区', openedAt: 1,
  roots: [{ id: 'prj', path: recommended }], defaultRootId: 'prj', rootsRevision: 3 };
const visibleGuide = { mounted: true, stage: 'in', spread: { 'data-mp-stage': 'in' } } as const;

function start(step: 'tools' | 'model' | 'remote' | 'done') {
  const mock = currentApiMock();
  const snapshot = { workspaces: [], activeWorkspaceId: '' };
  mock.override('config.get', async () => snapshot);
  mock.override('workspaces.list', async () => ({ ...snapshot, recommendedRoot: recommended }));
  mock.override('agentSession.listHarnessPickerChoices', async () => ({ choices: [], checkedAt: 1 }));
  const updates = vi.fn();
  const openSettings = vi.fn();
  function Flow() {
    const [progress, setProgress] = useState<SetupState>({ step, deferred: [] });
    const move: MoveSetup = (next, outcome) => {
      updates(next, outcome);
      setProgress(state => ({ step: next, deferred: outcome?.skipped ? [...state.deferred, outcome.step] : state.deferred }));
    };
    if (progress.step === 'workspace' || progress.step === 'session') return <WorkbenchSetupGuide key={progress.step}
      setup={{ ...progress, step: progress.step, onBack: () => move('remote'), onSkipSession: () => {}, onShowSession: () => {}, onDismiss: () => {} }}
      onOpenSettings={openSettings} presence={visibleGuide} />;
    return <FirstRun progress={progress.step} deferred={progress.deferred} onProgress={move} />;
  }
  render(<StoreProvider><Flow /></StoreProvider>);
  return { mock, snapshot, updates, openSettings };
}

describe('首次设置', () => {
  it('主动检测，按工具合并对话/终端结果并解释本机账号，切步后焦点进入新标题', async () => {
    const { mock } = start('tools');
    mock.override('agentSession.listHarnessPickerChoices', async () => ({ checkedAt: 1, choices: [
      { harnessId: 'codex', runtimeId: 'codex-gui', label: 'Codex', surface: 'gui', available: true, status: 'available' },
      { harnessId: 'codex', runtimeId: 'codex', label: 'Codex', surface: 'cli', available: false, status: 'disabled' }
    ] }));
    expect(mock.mockOf('runtimes.availability')).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '检测本机工具' }));
    await screen.findByText('发现 1 个本机工具，登录状态由工具管理。');
    expect(mock.mockOf('runtimes.availability')).toHaveBeenCalledWith(true);
    expect(screen.getAllByText('Codex', { exact: true })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    const heading = await screen.findByRole('heading', { name: '让 Muster Core 使用你的模型' });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByRole('listitem', { current: 'step' }).textContent).toBe('连接模型');
    expect(screen.queryByRole('button', { name: '重新检测' })).toBeNull();
  });

  it('验证失败时遮去错误里的 Key，成功后保存并可跳过远程连接', async () => {
    const { mock, snapshot } = start('model');
    mock.override('config.testLlm', vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'HTTP 401: fixture-key' })
      .mockResolvedValueOnce({ ok: true }));
    mock.override('config.update', async patch => ({ ...snapshot, ...patch }));
    fireEvent.change(await screen.findByLabelText('接口地址'), { target: { value: 'http://127.0.0.1:12345/v1' } });
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'model-a' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'fixture-key' } });
    expect(screen.getByLabelText('API Key').getAttribute('type')).toBe('password');
    const save = screen.getByRole('button', { name: '测试并保存' });
    fireEvent.click(save);
    expect((await screen.findByRole('alert')).textContent).toContain('HTTP 401: ••••');
    expect(mock.mockOf('config.update')).not.toHaveBeenCalled();
    fireEvent.click(save);
    await screen.findByRole('heading', { name: '在手机或另一台电脑上继续' });
    expect(mock.mockOf('config.update')).toHaveBeenCalledWith({ llm: {
      activeProviderId: 'custom', activeModelId: 'model-a',
      providers: [{ id: 'custom', name: '自定义供应商', baseUrl: 'http://127.0.0.1:12345/v1', api: 'openai-completions', enabled: true,
        apiKey: 'fixture-key', models: [{ id: 'model-a', name: 'model-a' }] }]
    } });
    expect(mock.mockOf('webAccess.status')).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '稍后连接' }));
    await screen.findByRole('heading', { name: '在工作台创建工作区' });
    expect(mock.mockOf('webAccess.status')).not.toHaveBeenCalled();
  });

  it('默认选中推荐目录，提交一次即创建，目录失败允许继续选择真实项目', async () => {
    const { mock } = start('done');
    mock.override('workspaces.open', vi.fn()
      .mockResolvedValueOnce({ ok: false, message: '没有目录权限' })
      .mockResolvedValueOnce({ ok: true, workspaces: [workspace], activeWorkspaceId: workspace.id }));
    mock.override('workspaces.pickDir', async () => ({ ok: true, path: '/existing/my-project' }));
    const suggested = await screen.findByRole('button', { name: /使用推荐文件夹/ });
    expect(suggested.getAttribute('aria-pressed')).toBe('true');
    const create = screen.getByRole('button', { name: '创建工作区' });
    expect((create as HTMLButtonElement).disabled).toBe(false);
    expect(mock.mockOf('workspaces.open')).not.toHaveBeenCalled();
    fireEvent.click(create);
    await screen.findByText('没有目录权限');
    expect(mock.mockOf('workspaces.open')).toHaveBeenNthCalledWith(1, { path: recommended, ensureRecommendedRoot: true, name: '我的工作区' });
    const existing = screen.getByRole('button', { name: /选择已有文件夹/ });
    fireEvent.click(existing);
    await waitFor(() => expect(existing.getAttribute('aria-pressed')).toBe('true'));
    expect((screen.getByLabelText('工作区名称') as HTMLInputElement).value).toBe('my-project');
    fireEvent.click(create);
    await waitFor(() => expect(mock.mockOf('workspaces.open')).toHaveBeenNthCalledWith(2, { path: '/existing/my-project', name: 'my-project' }));
  });

  it('远程方式由用户主动显示，网关失败可以重试，回环地址保留本机复制入口', async () => {
    const { mock } = start('remote');
    mock.override('webAccess.status', vi.fn()
      .mockResolvedValueOnce({ running: false, urls: [], disabledReason: '网关启动失败' })
      .mockResolvedValueOnce({ running: true, urls: ['http://127.0.0.1:7950/?token=fixture'], qrDataUrl: 'data:image/png;base64,AA==' }));
    expect(mock.mockOf('webAccess.status')).not.toHaveBeenCalled();
    const reveal = screen.getByRole('button', { name: '显示连接方式' });
    fireEvent.click(reveal);
    await screen.findByText('网关启动失败');
    fireEvent.click(reveal);
    await screen.findByText('当前地址仅可在这台电脑上打开');
    expect(screen.queryByRole('img', { name: '网页访问二维码' })).toBeNull();
    expect(screen.getByRole('button', { name: '复制连接地址' })).toBeTruthy();
  });

  it('跳过后在下一步给出路径，并在工作台直达对应设置', async () => {
    const { openSettings, updates } = start('tools');
    const tools = '设置 → Harness 接入 → 引擎配置 → 刷新';
    const model = '设置 → 模型与输入 → 模型服务商';
    const remote = '设置 → 远程访问 → 用网址打开';
    fireEvent.click(screen.getByRole('button', { name: '跳过检测' }));
    const modelStep = await screen.findByRole('region', { name: '让 Muster Core 使用你的模型' });
    expect(within(modelStep).getByText(tools)).toBeTruthy();
    fireEvent.click(within(modelStep).getByRole('button', { name: '稍后配置' }));
    const remoteStep = await screen.findByRole('region', { name: '在手机或另一台电脑上继续' });
    expect(within(remoteStep).getByText(model)).toBeTruthy();
    fireEvent.click(within(remoteStep).getByRole('button', { name: '稍后连接' }));
    const workbench = await screen.findByRole('region', { name: '在工作台创建工作区' });
    for (const label of [tools, model, remote]) fireEvent.click(within(workbench).getByRole('button', { name: label }));
    expect(openSettings.mock.calls).toEqual([['worker', 'worker-engines'], ['agent', 'agent-provider'], ['remoteAccess', 'webaccess-url']]);
    expect(updates).toHaveBeenLastCalledWith('workspace', { step: 'remote', skipped: true });
  });

  it('续读旧版进度，也持久保存可恢复的步骤', () => {
    localStorage.setItem('muster.firstRun.v1', 'session');
    expect(readSetupProgress()).toEqual({ step: 'session', deferred: [] });
    const state: SetupState = { step: 'session', deferred: ['model', 'remote'] };
    expect(writeSetupProgress(state)).toBe(true);
    expect(readSetupProgress()).toEqual(state);
    localStorage.removeItem('muster.firstRun.v1');
  });

  it.each([
    { step: 'session', title: '打开第一条会话', viaEscape: false },
    { step: 'done', title: '继续设置', viaEscape: true }
  ] as const)('$title 可退出引导，焦点交回工作台', ({ step, title, viaEscape }) => {
    const onDismiss = vi.fn();
    render(<main tabIndex={-1}>
      <WorkbenchSetupGuide setup={{ step, deferred: ['remote'], onDismiss,
        onBack: vi.fn(), onSkipSession: vi.fn(), onShowSession: vi.fn() }} onOpenSettings={vi.fn()}
        presence={visibleGuide} />
    </main>);
    const guide = screen.getByRole('region', { name: title });
    const close = within(guide).getByRole('button', { name: '关闭设置引导' });
    close.focus();
    if (viaEscape) fireEvent.keyDown(close, { key: 'Escape' });
    else fireEvent.click(close);
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });

  it('关闭续办卡片记住关闭状态和原有跳过位置', () => {
    const state = { step: 'done', deferred: ['remote', 'session'], dismissed: true } as const;
    try {
      expect(writeSetupProgress({ ...state, deferred: [...state.deferred] })).toBe(true);
      expect(readSetupProgress()).toEqual(state);
    } finally {
      localStorage.removeItem('muster.firstRun.v1');
    }
  });
});
