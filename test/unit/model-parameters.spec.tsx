import { renderTask } from './helpers/task-editor';
import {overrideGuiHistory} from './helpers/gui-history-range';
import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentComposer } from '../../src/renderer/src/components/AgentComposer';
import { ModelParametersPanel } from '../../src/renderer/src/components/settings/ModelParametersPanel';
import { TaskModelParameterFields } from '../../src/renderer/src/components/TaskSessionFields';
import { NewTaskDialog } from '../../src/renderer/src/components/NewTaskDialog';
import { ChatSurfaceView } from '../../src/renderer/src/chatSurface/ChatSurfaceView';
import { useAgentSessionSurface } from '../../src/renderer/src/chatSurface/agentSessionSurface';
import { StoreProvider } from '../../src/renderer/src/store';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { currentApiMock } from './helpers/api-mock';
import { resolveModelParameters, type ModelParameterContext } from '../../src/shared/modelParameters';
import { pickerCatalog } from './helpers/picker-catalog';
import type { AgentRuntimeEntry, AppConfig } from '../../src/shared/types';

const context: ModelParameterContext = {
  runtimeId: 'budget-cli', providerId: 'provider', modelId: 'model',
  parameters: [{ id: 'budget', semantic: 'reasoning', label: '推理预算', apply: 'next-turn', supportsDefault: true,
    options: ['off', '512', '8192'].map(value => ({ value, label: value === 'off' ? '关闭' : value })) },
  { id: 'strategy', label: '搜索策略', apply: 'reconnect', supportsDefault: true,
    options: Array.from({ length: 7 }, (_, i) => ({ value: String(i), label: `策略 ${i}` })) }]
};
const runtime = { id: 'budget-cli', label: '预算引擎', surface: 'chat', enabled: true } as AgentRuntimeEntry;
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
beforeEach(() => {
  Element.prototype.scrollIntoView ??= () => {};
  currentApiMock().override('agentSession.describeModelParameters', async () => context);
  currentApiMock().override('config.get', async () => ({ modelParameterProfiles: [], workspaces: [] }));
  currentApiMock().override('agentSession.listHarnessPickerChoices', async () => ({ checkedAt: 1, choices: [
    { harnessId: 'budget-cli', runtimeId: 'budget-cli', surface: 'gui', label: '预算引擎', available: true, status: 'available' }
  ] }));
  currentApiMock().override('agentSession.readHarnessPickerCatalog', async request => pickerCatalog(request, {
    harness: { harnessId: 'budget-cli', runtimeId: 'budget-cli', surface: 'gui' }, controls: resolveModelParameters(context, []).controls,
    canSetModel: false, state: 'unsupported'
  }));
});

describe('通用参数交互', () => {
  it('虚拟屏滑走时模型面板随条带退场，切回来后可重新打开', async () => {
    const change = vi.fn(async () => ({ ok: true as const, applied: 'next-turn' as const }));
    const layout = (peek: boolean) => <StoreProvider><KeybindingProvider>
      <div className="h-strip vs-axis" data-testid="virtual-strip">
        <div data-h-page="terminal" data-h-peek={peek ? '' : undefined}>
          <AgentComposer workspaceId="parameter-test" surfaceKind="gui-session" busy={false} onClear={async () => {}} onSend={async () => true}
            chatStatus={{ modelLabel: 'Example model', modelPickerTarget: { sessionId: 'parameter-test' }, onModelConfiguration: change }} />
        </div>
        <div data-h-page="git" data-h-peek={peek ? undefined : ''} />
      </div>
    </KeybindingProvider></StoreProvider>;
    const view = render(layout(false));
    vi.spyOn(screen.getByTestId('virtual-strip'), 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 1200, 800));
    const trigger = screen.getByRole('button', { name: '模型与参数' });
    await userEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: '模型与参数' });
    await screen.findByRole('radiogroup', { name: '推理预算' });
    await userEvent.click(screen.getByRole('radio', { name: '关闭' }));

    view.rerender(layout(true));
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'));
    expect(dialog.parentElement).toBe(screen.getByTestId('virtual-strip'));
    expect(dialog.inert).toBe(true);
    view.rerender(layout(false));
    await userEvent.click(trigger);
    const group = await screen.findByRole('radiogroup', { name: '推理预算' });
    expect(within(group).getByRole('radio', { name: '跟随默认' }).getAttribute('aria-checked')).toBe('true');
    expect(change).not.toHaveBeenCalled();
  });

  it('三档预算和七档策略共用模型菜单，不增加胶囊；跟随默认与关闭分开', async () => {
    const change = vi.fn(async () => ({ ok: true as const, applied: 'next-turn' as const }));
    const snapshot = resolveModelParameters(context, []);
    render(<StoreProvider><KeybindingProvider><AgentComposer workspaceId="parameter-test" surfaceKind="gui-session" busy={false} onClear={async () => {}} onSend={async () => true}
      chatStatus={{ modelLabel: 'Example model', providerId: 'provider', modelId: 'model', modelParameters: snapshot.controls,
        modelPickerTarget: { sessionId: 'parameter-test' }, onModelConfiguration: change }} /></KeybindingProvider></StoreProvider>);
    const trigger = screen.getByRole('button', { name: '模型与参数' });
    expect(document.querySelectorAll('.agent-composer-model-trigger')).toHaveLength(1);
    expect(document.querySelector('.agent-thinking-chip')).toBeNull();
    expect(screen.queryByRole('group', { name: '模型参数' })).toBeNull();
    await userEvent.click(trigger);
    await screen.findByRole('radiogroup', { name: '推理预算' });
    expect(within(screen.getByRole('radiogroup', { name: '推理预算' })).getAllByRole('radio')).toHaveLength(4);
    expect(within(screen.getByRole('radiogroup', { name: '搜索策略' })).getAllByRole('radio')).toHaveLength(8);
    await userEvent.click(screen.getByRole('radio', { name: '关闭' }));
    expect(change).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '确认配置' }));
    expect(change).toHaveBeenLastCalledWith(expect.objectContaining({ parameters: { budget: 'off' } }));
    await userEvent.click(trigger);
    await userEvent.click(within(await screen.findByRole('radiogroup', { name: '推理预算' })).getByRole('radio', { name: /跟随默认/ }));
    await userEvent.click(screen.getByRole('button', { name: '确认配置' }));
    expect(change).toHaveBeenLastCalledWith(expect.objectContaining({ parameters: {} }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '模型与参数' })).toBeNull());
    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '模型与参数' })).toBeNull());
  });

  it('运行时未提供模型标识时仍能在同一入口调整参数，不显示虚构模型列表', async () => {
    const change = vi.fn(async () => ({ ok: true as const, applied: 'next-turn' as const }));
    render(<StoreProvider><KeybindingProvider><AgentComposer workspaceId="parameter-test" surfaceKind="gui-session" busy={false} onClear={async () => {}} onSend={async () => true}
      chatStatus={{ modelParameters: resolveModelParameters(context, []).controls, modelPickerTarget: { sessionId: 'parameter-test' },
        onModelConfiguration: change }} /></KeybindingProvider></StoreProvider>);
    await userEvent.click(screen.getByRole('button', { name: '模型与参数' }));
    expect(await screen.findAllByRole('radio')).toHaveLength(12);
    expect(within(screen.getByRole('dialog', { name: '模型与参数' })).queryByRole('button', { name: 'default' })).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: '8192' }));
    await userEvent.click(screen.getByRole('button', { name: '确认配置' }));
    expect(change).toHaveBeenCalledWith(expect.objectContaining({ model: null, parameters: { budget: '8192' } }));
  });

  it('设置可编辑名称、映射、默认档与顺序，失败保存不修改配置', async () => {
    const set = vi.fn();
    const cfg = { modelParameterProfiles: [] } as unknown as AppConfig;
    currentApiMock().override('agentSession.saveParameterProfiles', async profiles => ({ ok: true, profiles }));
    render(<ModelParametersPanel cfg={cfg} set={set} runtimes={[runtime]} />);
    await userEvent.click(screen.getByRole('button', { name: '读取可用参数' }));
    const label = await screen.findByRole('textbox', { name: 'budget 显示名称' });
    await userEvent.clear(label); await userEvent.type(label, '思考深度');
    const optionId = screen.getByRole('textbox', { name: 'budget 2 选项标识' });
    await userEvent.clear(optionId); await userEvent.type(optionId, 'quick');
    await userEvent.click(screen.getByRole('button', { name: 'budget 2 映射目标' }));
    await userEvent.click(await screen.findByRole('option', { name: '8192' }));
    await userEvent.click(screen.getByRole('button', { name: 'budget 默认值' }));
    await userEvent.click(await screen.findByRole('option', { name: '512' }));
    await userEvent.click(screen.getByRole('button', { name: 'budget 2 上移' }));
    await userEvent.click(screen.getByRole('button', { name: '保存参数配置' }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    const saved = set.mock.calls[0][0].modelParameterProfiles[0];
    expect(saved.runtimeId).toBe('budget-cli');
    expect(saved.parameters.budget).toMatchObject({ label: '思考深度', defaultValue: 'quick' });
    expect(saved.parameters.budget.options[0]).toMatchObject({ value: 'quick', mappedValue: '8192' });
    currentApiMock().override('agentSession.saveParameterProfiles', async () => ({ ok: false, error: '不支持该映射' }));
    await userEvent.click(screen.getByRole('button', { name: '保存参数配置' }));
    await screen.findByText('不支持该映射');
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('新建字段保留独立模型参数，目录临时失败不删除已选值', async () => {
    const changed = vi.fn();
    const view = render(<TaskModelParameterFields runtime="budget-cli" modelKey="" disabled={false} values={{ budget: '8192' }} onChange={changed} />);
    await screen.findByRole('button', { name: '推理预算' });
    expect(changed).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '推理预算' }));
    await userEvent.click(screen.getByRole('option', { name: '512' }));
    expect(changed).toHaveBeenLastCalledWith({ budget: '512' });
    currentApiMock().override('agentSession.describeModelParameters', async () => ({ ...context, parameters: [], unavailable: true, warning: '目录暂不可用' }));
    view.rerender(<TaskModelParameterFields runtime="budget-cli" modelKey="budget-cli|next" disabled={false} values={{ budget: '8192' }} onChange={changed} />);
    await screen.findByText('目录暂不可用');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('ACP 切到尚未读取的模型只读快照，手动刷新后的通知再读取新快照', async () => {
    const api = currentApiMock();
    let refreshed = false;
    api.override('agentSession.describeModelParameters', async ({ modelId, refresh }: { modelId: string; refresh?: boolean }) => {
      expect(refresh).toBeUndefined();
      return refreshed ? { ...context, runtimeId: 'acp', modelId } : {
        ...context, runtimeId: 'acp', modelId, parameters: [], unavailable: true, warning: '等待手动刷新'
      };
    });
    const fields = (catalogRevision: number) => <TaskModelParameterFields runtime="acp" piMode="kimi" modelKey="acp|model"
      source={{ workspaceId: 'ws', rootId: 'root', rootsRevision: 0 }} disabled={false} onChange={vi.fn()} catalogRevision={catalogRevision} />;
    const view = render(fields(0));
    await screen.findByText('等待手动刷新');
    expect(api.mockOf('agentSession.describeModelParameters')).toHaveBeenCalledTimes(1);
    refreshed = true;
    view.rerender(fields(1));
    await screen.findByRole('button', { name: '推理预算' });
    expect(api.mockOf('agentSession.describeModelParameters')).toHaveBeenCalledTimes(2);
  });

  it('真实 GUI surface 将未知运行时控件接到 IPC，推送同步选中态', async () => {
    const api = currentApiMock();
    const initial = resolveModelParameters(context, []);
    api.override('agentSession.getModelParameters', async () => initial);
    overrideGuiHistory(api, async () => ({ messages: [], busy: false, mode: 'auto' }));
    api.override('agentSession.setModelConfiguration', async () => {
      api.override('agentSession.getModelParameters', async () => resolveModelParameters(context, [], { budget: '8192' }));
      return { ok: true, applied: 'next-turn' };
    });
    function Session() { const surface = useAgentSessionSurface({ sessionId: 'generic-parameters', visible: true, runtimeId: 'budget-cli' }); return <ChatSurfaceView surface={surface} />; }
    render(<StoreProvider><Session /></StoreProvider>);
    const chip = await screen.findByRole('button', { name: '模型与参数' });
    await userEvent.click(chip);
    await userEvent.click(await screen.findByRole('radio', { name: '8192' }));
    await userEvent.click(screen.getByRole('button', { name: '确认配置' }));
    await waitFor(() => expect(api.mockOf('agentSession.setModelConfiguration')).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'generic-parameters', parameters: { budget: '8192' } })));
    await waitFor(() => expect(chip.title).toContain('8192'));
    act(() => api.emit('agentSession:event', { kind: 'parameters', sessionId: 'generic-parameters', controls: initial.controls }));
    await waitFor(() => expect(chip.title).toContain('默认'));
  });

  it('新建空会话提交独立参数，未指定模型仍保留选择', async () => {
    const blank = vi.fn(async (..._args: unknown[]) => {});
    currentApiMock().override('sessions.precheck', async () => ({ isolate: false, dirty: false }));
    currentApiMock().override('runtimes.list', async () => [runtime]);
    currentApiMock().override('runtimes.availability', async () => ({ runtimes: [runtime], acpAgents: [], checkedAt: 1 }));
    renderTask(<NewTaskDialog open runtimes={[runtime]} workspace={{ id: 'ws', name: 'workspace', path: 'E:/workspace', openedAt: 0 }}
      onClose={() => {}} onDelegate={vi.fn()} onBlankSession={blank} />);
    await userEvent.click(await screen.findByRole('button', { name: '选择 Harness 和模型' }));
    await userEvent.click(await screen.findByRole('radio', { name: '8192' }));
    await userEvent.click(screen.getByRole('button', { name: '确认配置' }));
    await userEvent.click(screen.getByRole('button', { name: '新建空白' }));
    await waitFor(() => expect(blank).toHaveBeenCalled());
    expect(blank.mock.calls[0][2]).toMatchObject({ modelParameters: { budget: '8192' } });
    expect(blank.mock.calls[0][2]).not.toHaveProperty('model');
  });
});
