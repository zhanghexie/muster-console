import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FirstRun, WorkspaceRecovery } from '../../src/renderer/src/onboarding/FirstRun';
import { getSetupModelIssue, readSetupProgress, reconcileSetupStep, writeSetupProgress } from '../../src/renderer/src/onboarding/setupProgress';
import type { LlmConfig } from '../../src/shared/types';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';

const dialogPrototype = HTMLDialogElement.prototype;
const showModalDescriptor = Object.getOwnPropertyDescriptor(dialogPrototype, 'showModal');
const closeDescriptor = Object.getOwnPropertyDescriptor(dialogPrototype, 'close');
beforeAll(() => Object.defineProperties(dialogPrototype, {
  showModal: { configurable: true, writable: true, value(this: HTMLDialogElement) { this.open = true; } },
  close: { configurable: true, writable: true, value(this: HTMLDialogElement) { this.open = false; } }
}));
afterAll(() => {
  if (showModalDescriptor) Object.defineProperty(dialogPrototype, 'showModal', showModalDescriptor);
  else Reflect.deleteProperty(dialogPrototype, 'showModal');
  if (closeDescriptor) Object.defineProperty(dialogPrototype, 'close', closeDescriptor);
  else Reflect.deleteProperty(dialogPrototype, 'close');
});
beforeEach(() => {
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) { this.open = true; });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) { this.open = false; });
});
afterEach(() => vi.restoreAllMocks());

function start(step: 'tools' | 'model' = 'tools') {
  const props = { step, onAdvanceTools: vi.fn(), onBack: vi.fn(), onSkipModel: vi.fn(), onOpenModelSettings: vi.fn(), onDismiss: vi.fn() };
  const view = render(<FirstRun {...props} />);
  return { ...view, props };
}

describe('首次设置弹窗', () => {
  it('使用原生模态打开，主动检测合并工具并保留结果跨步回退', async () => {
    const api = currentApiMock();
    api.override('agentSession.listHarnessPickerChoices', async () => ({ checkedAt: 1, choices: [
      { harnessId: 'codex', runtimeId: 'codex-gui', label: 'Codex', surface: 'gui', available: true, status: 'available' },
      { harnessId: 'codex', runtimeId: 'codex', label: 'Codex', surface: 'cli', available: false, status: 'disabled' }
    ] }));
    const { props, rerender } = start();
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled();
    expect(api.mockOf('runtimes.availability')).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '检测本机工具' }));
    await screen.findByText('发现 1 个本机工具，登录状态由工具管理。');
    expect(api.mockOf('runtimes.availability')).toHaveBeenCalledWith(true);
    expect(screen.getAllByText('Codex', { exact: true })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(props.onAdvanceTools).toHaveBeenCalledWith(false);
    rerender(<FirstRun {...props} step="model" />);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '让 Muster Core 使用你的模型' }));
    expect(screen.queryByRole('button', { name: '重新检测' })).toBeNull();
    rerender(<FirstRun {...props} step="tools" />);
    expect(screen.getByRole('button', { name: '重新检测' })).toBeTruthy();
  });
  it('跳过工具由宿主推进；模型页直接交接实际设置，不提供重复表单', async () => {
    const { props, rerender } = start();
    fireEvent.click(screen.getByRole('button', { name: '跳过检测' }));
    expect(props.onAdvanceTools).toHaveBeenCalledWith(true);
    rerender(<FirstRun {...props} step="model" />);
    expect(screen.queryByLabelText('API Key')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '上一步' }));
    expect(props.onBack).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '稍后配置' }));
    expect(props.onSkipModel).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '去模型设置' }));
    await waitFor(() => expect(props.onOpenModelSettings).toHaveBeenCalledOnce());
    expect(HTMLDialogElement.prototype.close).toHaveBeenCalled();
  });
  it('原生取消与显式关闭都在退场后通知宿主', async () => {
    const { props } = start('model');
    expect(screen.getByRole('button', { name: '稍后继续' })).toBeTruthy();
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: false, cancelable: true }));
    await waitFor(() => expect(props.onDismiss).toHaveBeenCalledOnce());
  });
  it('完成后的空工作区恢复仍使用真实目录表单', async () => {
    currentApiMock().override('workspaces.list', async () => ({ workspaces: [], activeWorkspaceId: '', recommendedRoot: '/home/test/Muster' }));
    render(<StoreProvider><WorkspaceRecovery /></StoreProvider>);
    expect(await screen.findByRole('button', { name: /使用推荐文件夹/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建工作区' })).toBeTruthy();
  });
});

describe('首装进度', () => {
  const storageKey = 'muster.firstRun.v1';
  afterEach(() => localStorage.removeItem(storageKey));

  it('恢复暂停的导览，也兼容已经完成或停在旧远程访问步骤的配置', () => {
    const paused = { step: 'virtual', deferred: ['model'], paused: true } as const;
    expect(writeSetupProgress({ ...paused, deferred: [...paused.deferred] })).toBe(true);
    expect(readSetupProgress()).toEqual(paused);
    localStorage.setItem(storageKey, '{"step":"done","deferred":["model"],"dismissed":true}');
    expect(readSetupProgress()).toEqual({ step: 'done', deferred: ['model'] });
    localStorage.setItem(storageKey, 'remote');
    expect(readSetupProgress()).toEqual({ step: 'workspace', deferred: [] });
  });

  it('创建会话后进入工作台导览，完成需由用户明确确认', () => {
    expect(reconcileSetupStep('workspace', false, false)).toBe('workspace');
    expect(reconcileSetupStep('workspace', true, false)).toBe('session');
    expect(reconcileSetupStep('session', true, true)).toBe('left');
    expect(reconcileSetupStep('finish', true, false)).toBe('finish');
  });

  it('已保存的默认模型缺少连接信息时返回具体修正位置', () => {
    const provider = { id: 'custom', name: 'Fixture', baseUrl: 'https://example.invalid', apiKey: 'fixture', models: [{ id: 'model', name: 'Model' }] };
    const issue = (patch: Partial<typeof provider> & { enabled?: boolean }, modelId = 'model') => {
      const llm: LlmConfig = { providers: [{ ...provider, ...patch }], activeProviderId: 'custom', activeModelId: modelId };
      return getSetupModelIssue(llm);
    };
    expect(getSetupModelIssue(undefined)?.settingsItem).toBe('agent-provider');
    expect(issue({ enabled: false })?.settingsItem).toBe('agent-provider-enabled');
    expect(issue({ baseUrl: '' })?.settingsItem).toBe('agent-base-url');
    expect(issue({ apiKey: ' ' })?.settingsItem).toBe('agent-api-key');
    expect(issue({}, 'missing')?.settingsItem).toBe('agent-model-actions');
    expect(issue({})).toBeUndefined();
  });
});
