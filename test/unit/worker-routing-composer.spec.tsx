import { renderWithAppTips as render, findAppTip } from './helpers/app-tips';
import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentComposer } from '../../src/renderer/src/components/AgentComposer';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import { WorkerRoutingPane } from '../../src/renderer/src/components/settings/WorkerRoutingPane';
import { SettingsModal } from '../../src/renderer/src/components/settings/SettingsModal';
import { StoreProvider } from '../../src/renderer/src/store';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import type { WorkerRoutingConfig, WorkerRoutingLayer, WorkerRoutingSettings, WorkerTargetConfig } from '../../src/shared/workerRouting';
import type { NativeConfigSnapshot } from '../../src/shared/nativeSessionConfig';
import { encodeWorkerModelMention, workerModelMentions } from '../../src/shared/workerModelMention';
import { currentApiMock } from './helpers/api-mock';
import { pickerCatalog } from './helpers/picker-catalog';
import { resolveModelParameters } from '../../src/shared/modelParameters';

const scope = { workspaceId: 'ws-routing', rootId: 'root-routing', rootsRevision: 4 };
const workspace = { id: scope.workspaceId, name: 'Routing workspace', path: '/fixture/routing', openedAt: 1, rootsRevision: scope.rootsRevision,
  defaultRootId: scope.rootId, roots: [{ id: scope.rootId, path: '/fixture/routing' }] };
const runtime = { id: 'pi', label: 'Muster Core', enabled: true, builtin: true, kind: 'gui', surface: 'chat' };
const config: WorkerTargetConfig = { harnessId: 'muster-core', runtimeId: 'pi', surface: 'gui',
  model: { providerId: 'provider-a', modelId: 'same-model' }, modelParameters: { reasoning: 'high' } };
const ref = 'wr1.' + 'a'.repeat(32);
const label = 'Muster Core · GUI · Account A · Same model · High';
const reasoning = { id: 'reasoning', semantic: 'reasoning', label: 'Reasoning', apply: 'next-turn', supportsDefault: true,
  options: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] };

function typeInto(editor: HTMLElement, text: string) {
  editor.focus();
  editor.textContent = text;
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.input(editor);
}

function mockCatalog() {
  const api = currentApiMock();
  api.override('runtimes.list', async () => [runtime]);
  api.override('runtimes.availability', async () => ({ checkedAt: 1, runtimes: [runtime], acpAgents: [] }));
  api.override('workspaces.list', async () => ({ workspaces: [workspace], activeWorkspaceId: workspace.id }));
  api.override('workspaces.listFiles', async () => ({ files: [{ path: 'model.md', displayPath: 'model.md' }] }));
  api.override('agent.listSkills', async () => ({ skills: [{ name: 'review', description: 'Review' }] }));
  api.override('config.get', async () => ({ workspaces: [workspace], activeWorkspaceId: workspace.id, locale: 'zh-CN',
    llm: { providers: ['a', 'b'].map(id => ({ id: `provider-${id}`, name: `Account ${id.toUpperCase()}`, models: [{ id: 'same-model', name: 'Same model' }] })) } }));
  api.override('agentSession.describeModelParameters', async ({ providerId, modelId }) =>
    ({ runtimeId: 'pi', providerId, modelId, parameters: [reasoning] }));
  api.override('agentSession.listHarnessPickerChoices', async () => ({ checkedAt: 1, choices: [
    { harnessId: 'muster-core', runtimeId: 'pi', surface: 'gui', label: 'Muster Core', available: true, status: 'available' },
    { harnessId: 'codex', runtimeId: 'codex-gui', surface: 'gui', label: 'Codex', available: true, status: 'available' }
  ] }));
  api.override('agentSession.readHarnessPickerCatalog', async request => pickerCatalog(request, {
    models: 'harness' in request && request.harness.runtimeId === 'codex-gui'
      ? [{ providerId: 'codex-gui', modelId: 'codex-model', label: 'codex-model' }]
      : ['a', 'b'].map(id => ({ providerId: `provider-${id}`, modelId: 'same-model', label: `Account ${id.toUpperCase()} · Same model` })),
    controls: resolveModelParameters({ runtimeId: 'pi', providerId: 'provider-a', modelId: 'same-model',
      parameters: [{ ...reasoning, semantic: 'reasoning', apply: 'next-turn' }] }, []).controls
  }));
  api.override('workerRouting.reference', async ({ config }) => ({ targetRef: ref, config }));
  api.override('workerRouting.validate', async () => ({ targetRef: ref, config }));
  return api;
}

function composer(onSend = vi.fn(async (_text: string) => true), surfaceKind: 'dispatch' | 'gui-session' = 'dispatch') {
  const view = render(<KeybindingProvider><StoreProvider><AgentComposer workspaceId={workspace.id} workerRoutingScope={scope}
    busy={false} surfaceKind={surfaceKind} engineSlashCommands={[{ name: 'Harness', description: 'Engine harness' }]}
    onSend={onSend} onClear={async () => {}} /></StoreProvider></KeybindingProvider>);
  return { ...view, onSend, editor: view.container.querySelector<HTMLElement>('.composer-editable')! };
}

beforeEach(() => {
  localStorage.clear();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (typeof document.execCommand !== 'function') document.execCommand = () => false;
});

describe('Worker model reference', () => {
  it('moves from Harness to model to parameters and confirms a single reference by keyboard', async () => {
    const api = mockCatalog();
    const { editor, onSend } = composer();
    typeInto(editor, 'Use /harness');
    fireEvent.keyDown(editor, { key: 'Enter' });
    const picker = await screen.findByRole('dialog', { name: '插入模型引用' });
    const harness = await within(picker).findByRole('tab', { name: 'Muster Core' });
    fireEvent.click(harness);
    harness.focus();
    await within(picker).findByRole('option', { name: 'Account A · Same model' });
    fireEvent.keyDown(harness, { key: 'ArrowRight' });
    expect(document.activeElement?.getAttribute('role')).toBe('option');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await within(picker).findByRole('radio', { name: 'High' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement?.getAttribute('role')).toBe('radio');
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(api.mockOf('workerRouting.reference')).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    await within(editor).findByRole('button', { name: label });
    expect(api.mockOf('workerRouting.reference')).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows human model names in the transcript and reveals the invocation on demand', () => {
    const text = `Before ${encodeWorkerModelMention({ targetRef: ref, label })} after`;
    const { container } = render(<ChatMessageView message={{ id: 'mention', role: 'user', content: text, createdAt: 1,
      parts: [{ kind: 'text', text }] }} />);
    const summary = screen.getByText('模型引用的派活调用');
    expect(container.textContent).toContain(label);
    expect(container.textContent).not.toContain(ref);
    fireEvent.click(summary);
    expect(container.querySelector('code')?.textContent).toContain(`host.sessions.create({task, isolation, target: {targetRef: "${ref}"}})`);
  });
  it('opens the shared picker, preserves exact provider and parameters, and revalidates a stale editable chip', async () => {
    const api = mockCatalog();
    const { editor, onSend } = composer();
    typeInto(editor, '请用 /harness');
    expect(screen.getByRole('option', { name: /\/harness/ })).toBeTruthy();
    fireEvent.keyDown(editor, { key: 'Enter' });
    const dialog = await screen.findByRole('dialog', { name: '插入模型引用' });
    fireEvent.click(await within(dialog).findByRole('tab', { name: 'Muster Core' }));
    fireEvent.click(await within(dialog).findByRole('option', { name: 'Account A · Same model' }));
    fireEvent.click(await within(dialog).findByRole('radio', { name: 'High' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '插入引用' }));
    const chip = await within(editor).findByRole('button', { name: label });
    expect(api.mockOf('workerRouting.reference')).toHaveBeenLastCalledWith({ scope, config });
    expect(editor.querySelector('.is-model')?.getAttribute('contenteditable')).toBe('false');
    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
    expect(editor.textContent).toBe('请用 /harness');
    expect(screen.queryByRole('dialog', { name: '插入模型引用' })).toBeNull();
    fireEvent.keyDown(editor, { key: 'y', ctrlKey: true });
    const restored = within(editor).getByRole('button', { name: label });
    expect(restored).not.toBe(chip);

    api.override('workerRouting.validate', async () => { throw new Error('stale'); });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect((await findAppTip()).textContent).toContain('已失效');
    expect(onSend).not.toHaveBeenCalled();
    expect(editor.textContent).toContain(label);
    fireEvent.keyDown(restored, { key: 'Enter' });
    const edit = await screen.findByRole('dialog', { name: '编辑模型引用' });
    expect(await screen.findByText('此模型引用已失效，请重新选择。')).toBeTruthy();
    fireEvent.keyDown(within(edit).getByRole('searchbox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '编辑模型引用' })).toBeNull();
    expect(editor.textContent).toContain(label);

    api.override('workerRouting.validate', async () => ({ targetRef: ref, config }));
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const sent = onSend.mock.calls[0][0];
    expect(workerModelMentions(sent).map(item => item.mention)).toEqual([{ targetRef: ref, label }]);
    expect(sent).toContain('请用 ');
  });

  it('reserves the GUI slash command, returns focus on cancel, and opens from the send button', async () => {
    mockCatalog();
    const { editor, onSend } = composer(undefined, 'gui-session');
    typeInto(editor, '  /harness');
    const item = screen.getByRole('option', { name: /\/harness/ });
    expect(item.textContent).toContain('为委派任务选择');
    expect(screen.queryByText('Engine harness')).toBeNull();
    fireEvent.mouseDown(item);
    const dialog = await screen.findByRole('dialog', { name: '插入模型引用' });
    fireEvent.keyDown(within(dialog).getByRole('searchbox'), { key: 'Escape' });
    expect(editor.textContent).toBe('  /harness');
    expect(document.activeElement).toBe(editor);
    expect(screen.queryByRole('option', { name: /\/harness/ })).toBeNull();
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    const reopened = await screen.findByRole('dialog', { name: '插入模型引用' });
    fireEvent.click(await within(reopened).findByRole('tab', { name: 'Muster Core' }));
    fireEvent.click(await within(reopened).findByRole('option', { name: 'Account A · Same model' }));
    const insert = within(reopened).getByRole<HTMLButtonElement>('button', { name: '插入引用' });
    await waitFor(() => expect(insert.disabled).toBe(false));
    fireEvent.click(insert);
    await within(editor).findByRole('button', { name: /Muster Core · GUI · Account A · Same model/ });
    expect(editor.textContent).not.toContain('/harness');
    expect(editor.textContent?.startsWith('  ')).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('preserves the atomic token across manual queue reload and retrieval, with keyboard deletion and undo', async () => {
    mockCatalog();
    const text = `Before ${encodeWorkerModelMention({ targetRef: ref, label })} after`;
    const first = composer();
    typeInto(first.editor, text);
    expect(within(first.editor).getByRole('button', { name: label })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /留待确认/ }));
    expect(first.editor.textContent).toBe('');
    first.unmount();

    const second = composer();
    const takeBack = await screen.findByRole('button', { name: '取回输入框编辑' });
    expect(takeBack.textContent).toContain(label);
    expect(takeBack.textContent).not.toContain(ref);
    fireEvent.click(takeBack);
    const chip = await within(second.editor).findByRole('button', { name: label });
    fireEvent.keyDown(chip, { key: 'Delete' });
    expect(second.editor.textContent).toBe('Before  after');
    fireEvent.keyDown(second.editor, { key: 'z', ctrlKey: true });
    expect(within(second.editor).getByRole('button', { name: label })).toBeTruthy();
  });

  it('keeps IME composition, @file completion, and skill selection distinct', async () => {
    const api = mockCatalog();
    const { editor } = composer();
    fireEvent.compositionStart(editor);
    typeInto(editor, '/harness');
    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true });
    expect(screen.queryByRole('option', { name: /\/harness/ })).toBeNull();
    expect(screen.queryByRole('dialog', { name: '插入模型引用' })).toBeNull();
    fireEvent.compositionEnd(editor);
    expect(await screen.findByRole('option', { name: /\/harness/ })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '插入模型引用' })).toBeNull();
    fireEvent.keyDown(editor, { key: 'Tab' });
    expect(await screen.findByRole('dialog', { name: '插入模型引用' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    expect(api.mockOf('workspaces.listFiles')).not.toHaveBeenCalled();
    typeInto(editor, '@model');
    const file = await screen.findByRole('option', { name: '@model.md' });
    expect(screen.queryByRole('dialog', { name: '插入模型引用' })).toBeNull();
    fireEvent.mouseDown(file);
    expect(editor.querySelector('.composer-token.is-file')).toBeTruthy();
    typeInto(editor, '/skill:review');
    await screen.findByRole('option', { name: /skill:review/ });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(editor.querySelector('.composer-token.is-skill')).toBeTruthy();
  });
});

function routingResult(config: WorkerRoutingConfig, layer: WorkerRoutingLayer = 'global', options: Partial<WorkerRoutingSettings> = {}): WorkerRoutingSettings {
  return { layer, origin: layer, version: `${layer}:${config.revision}`, config, members: [], ...options };
}

describe('Worker routing settings', () => {
  const codex: WorkerTargetConfig = { harnessId: 'codex', runtimeId: 'codex-gui', surface: 'gui',
    model: { providerId: 'codex-gui', modelId: 'codex-model' } };
  const nativePermissions: NativeConfigSnapshot = {
    identity: { runtimeId: 'codex-gui', sourceKey: 'fixture-source', version: 'fixture-native-config' }, revision: 1,
    source: 'catalog', status: 'ready',
    options: [
      { id: 'permissions', name: 'Permission Profile', category: 'permissions', type: 'select', changePolicy: 'idle',
        choices: [{ value: ':workspace', name: 'Workspace' }, { value: 'custom-profile', name: 'Mutable custom profile' }] },
      { id: 'approvalPolicy', name: 'Approval Policy', category: 'permissions', type: 'select', changePolicy: 'idle',
        choices: [{ value: 'on-request', name: 'On request' }] },
      { id: 'approvalsReviewer', name: 'Approvals Reviewer', category: 'permissions', type: 'select', changePolicy: 'idle',
        choices: [{ value: 'user', name: 'User' }] },
      { id: 'sandboxPolicy', name: 'Sandbox Policy', category: 'permissions', type: 'select', changePolicy: 'read-only' },
      { id: 'collaborationMode', name: 'Collaboration Mode', category: 'mode', type: 'select', changePolicy: 'idle' }
    ]
  };
  const nativeConfig = { identity: nativePermissions.identity,
    selections: [{ id: 'permissions', value: ':workspace' }, { id: 'approvalPolicy', value: 'on-request' }, { id: 'approvalsReviewer', value: 'user' }] };
  const consentLabel = '允许运行中跨 Harness，使用此候选选定的原生权限';

  it('keeps both drafts and rebuilds an override from the saved global configuration after following', async () => {
    const api = mockCatalog();
    let global: WorkerRoutingConfig = { revision: 5, tiers: [{ id: 'light', kind: 'low', name: '轻量', description: '',
      members: [{ id: 'core', enabled: true, config }, { id: 'codex', enabled: true, config: codex }], fallbackTierIds: [] }] };
    let local: WorkerRoutingConfig | undefined;
    let generation = 0;
    const read = (layer: WorkerRoutingLayer) => layer === 'global' ? routingResult(global)
      : routingResult(local ?? global, 'workspace', local ? { version: `override:${generation}` }
        : { origin: 'global', version: `inherit:${generation}:${global.revision}` });
    api.override('workerRouting.read', async ({ layer }) => read(layer));
    api.override('workerRouting.save', async ({ layer, expectedVersion, config: next }) => {
      if (expectedVersion !== read(layer).version) throw new Error('CAS conflict');
      if (layer === 'global') global = { ...next, revision: global.revision + 1 };
      else local = { ...next, revision: ++generation };
      return read(layer);
    });
    api.override('workerRouting.followGlobal', async ({ expectedVersion }) => {
      if (expectedVersion !== read('workspace').version) throw new Error('CAS conflict');
      local = undefined;
      generation++;
      return read('workspace');
    });
    render(<WorkerRoutingPane workspace={workspace} active />);
    const scopeControl = screen.getByRole('group', { name: '自动派活应用范围' });
    const select = (name: string) => fireEvent.click(within(scopeControl).getByRole('button', { name }));
    const coreSwitch = () => screen.getByRole<HTMLInputElement>('checkbox', { name: /启用 Muster Core/ });
    const codexSwitch = () => screen.getByRole<HTMLInputElement>('checkbox', { name: /启用 Codex/ });
    const saveButton = () => screen.getByRole<HTMLButtonElement>('button', { name: '保存派活配置' });
    const clickWhenReady = async (button: () => HTMLButtonElement | HTMLInputElement) => {
      await waitFor(() => expect(button().matches(':disabled')).toBe(false));
      fireEvent.click(button());
    };

    await clickWhenReady(coreSwitch);
    expect(coreSwitch().checked).toBe(false);
    expect(screen.queryByText('跨 Harness 权限')).toBeNull();
    select('仅当前工作区');
    await screen.findByText('当前工作区跟随全局默认');
    expect(coreSwitch().checked).toBe(true);
    expect(screen.queryByText('跨 Harness 权限')).toBeNull();
    await clickWhenReady(codexSwitch);
    expect(screen.getByText('待保存为工作区配置')).toBeTruthy();
    expect(screen.getByText('跨 Harness 权限')).toBeTruthy();
    select('全局默认');
    expect(coreSwitch().checked).toBe(false);
    expect(codexSwitch().checked).toBe(true);
    expect(api.mockOf('workerRouting.save')).not.toHaveBeenCalled();
    await clickWhenReady(saveButton);
    await screen.findByText('派活配置已保存');
    expect(api.mockOf('workerRouting.save').mock.calls.map(([request]) => [request.layer, request.expectedVersion]))
      .toEqual([['workspace', 'inherit:0:5'], ['global', 'global:5']]);
    expect(global.tiers[0].members.map(member => member.enabled)).toEqual([false, true]);
    expect(local?.tiers[0].members.map(member => member.enabled)).toEqual([true, false]);

    select('仅当前工作区');
    await screen.findByText('当前工作区有独立派活配置');
    expect(coreSwitch().checked).toBe(true);
    const follow = () => screen.getByRole<HTMLButtonElement>('button', { name: '恢复跟随全局' });
    await clickWhenReady(follow);
    expect(screen.getByText('保存后恢复跟随全局')).toBeTruthy();
    const preview = await screen.findByText(/Codex · GUI · codex-model/);
    expect(preview.closest('.worker-routing-follow-preview')).toBeTruthy();
    expect(preview.textContent).not.toContain('Muster Core');
    expect(api.mockOf('workerRouting.followGlobal')).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消恢复' }));
    expect(codexSwitch().checked).toBe(false);
    await clickWhenReady(follow);
    await clickWhenReady(saveButton);
    await screen.findByText('当前工作区跟随全局默认');
    expect(api.mockOf('workerRouting.followGlobal')).toHaveBeenCalledWith({ scope, expectedVersion: 'override:1' });
    expect(coreSwitch().checked).toBe(false);
    expect(codexSwitch().checked).toBe(true);
    await clickWhenReady(coreSwitch);
    await clickWhenReady(saveButton);
    await screen.findByText('当前工作区有独立派活配置');
    expect(api.mockOf('workerRouting.save').mock.lastCall?.[0]).toMatchObject({
      layer: 'workspace', expectedVersion: 'inherit:2:6',
      config: { tiers: [{ members: [{ id: 'core', enabled: true }, { id: 'codex', enabled: true }] }] }
    });
  });

  it('saves an explicit empty workspace override and preserves a failed global draft independently', async () => {
    const api = mockCatalog();
    const global: WorkerRoutingConfig = { revision: 2, tiers: [{ id: 'light', kind: 'low', name: '轻量', description: '',
      members: [{ id: 'core', enabled: true, config }], fallbackTierIds: [] }] };
    let local: WorkerRoutingConfig | undefined;
    api.override('workerRouting.read', async ({ layer }) => layer === 'global' ? routingResult(global)
      : routingResult(local ?? global, 'workspace', local ? {} : { origin: 'global', version: 'inherited:0:2' }));
    api.override('workerRouting.save', async ({ layer, expectedVersion, config: next }) => {
      if (layer === 'global') throw new Error('global changed elsewhere');
      expect(expectedVersion).toBe('inherited:0:2');
      local = { ...next, revision: 1 };
      return routingResult(local!, 'workspace');
    });
    render(<WorkerRoutingPane workspace={workspace} active />);
    const scopes = screen.getByRole('group', { name: '自动派活应用范围' });
    fireEvent.click(await screen.findByRole('checkbox', { name: /启用 Muster Core/ }));
    fireEvent.click(within(scopes).getByRole('button', { name: '仅当前工作区' }));
    await screen.findByText('当前工作区跟随全局默认');
    fireEvent.click(screen.getByRole('button', { name: '仅此工作区留空' }));
    expect(screen.queryByRole('checkbox', { name: /启用 Muster Core/ })).toBeNull();
    expect(api.mockOf('workerRouting.save')).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存派活配置' }));
    expect(await screen.findByText('global changed elsewhere')).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /启用 Muster Core/ }).checked).toBe(false);
    expect(local).toEqual({ revision: 1, tiers: [] });
    expect(api.mockOf('workerRouting.followGlobal')).not.toHaveBeenCalled();
    fireEvent.click(within(scopes).getByRole('button', { name: '仅当前工作区' }));
    await screen.findByText('当前工作区有独立派活配置');
    expect(screen.queryByRole('checkbox', { name: /启用 Muster Core/ })).toBeNull();
  });

  it('requires explicit native permissions before opting in, restores saved consent, and revokes it independently', async () => {
    const api = mockCatalog();
    let current: WorkerRoutingConfig = { revision: 5, tiers: [
      { id: 'light', kind: 'low', name: '轻量', description: '', fallbackTierIds: [], members: [
        { id: 'codex', enabled: true, config: codex }, { id: 'pi', enabled: true, config }
      ] }
    ] };
    api.override('workerRouting.read', async () => routingResult(current, 'workspace'));
    api.override('workerRouting.save', async ({ config }: { config: WorkerRoutingConfig }) => {
      const tiers = config.tiers.map(tier => ({ ...tier, members: tier.members.map(member => member.crossHarness
        ? { ...member, crossHarness: { ...member.crossHarness, binding: 'server-binding' } } : member) }));
      current = { revision: config.revision + 1, tiers };
      return routingResult(current, 'workspace');
    });
    api.override('agentSession.describeNativeConfig', async () => nativePermissions);
    const scopedWorkspace = { ...workspace, roots: [...workspace.roots, { id: 'other', path: '/fixture/other' }] };
    const view = render(<WorkerRoutingPane workspace={scopedWorkspace} active initialLayer="workspace" />);
    expect(await screen.findAllByText('跨 Harness 权限')).toHaveLength(1);
    expect(api.mockOf('agentSession.describeNativeConfig')).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('跨 Harness 权限'));
    const checkbox = () => screen.getByRole<HTMLInputElement>('checkbox', { name: consentLabel });
    expect(checkbox().checked).toBe(false);
    expect(checkbox().disabled).toBe(true);
    expect(screen.getByText(/审批方式和文件访问范围可能/)).toBeTruthy();
    expect(screen.queryByText('Sandbox Policy')).toBeNull();
    expect(screen.queryByText('Collaboration Mode')).toBeNull();
    const profile = await screen.findByRole('button', { name: '权限配置' });
    expect(api.mockOf('agentSession.describeNativeConfig')).toHaveBeenCalledWith({ runtimeId: 'codex-gui', presetId: undefined, source: scope, refresh: false });
    profile.focus();
    fireEvent.click(profile);
    const list = await screen.findByRole('listbox', { name: '权限配置' });
    expect(within(list).queryByRole('option', { name: 'Mutable custom profile' })).toBeNull();
    expect(within(list).queryByRole('option', { name: '跟随引擎默认' })).toBeNull();
    fireEvent.keyDown(list, { key: 'Escape' });
    expect(document.activeElement).toBe(profile);
    fireEvent.click(profile);
    await screen.findByRole('listbox', { name: '权限配置' });
    fireEvent.click(screen.getByText('跨 Harness 权限'));
    expect(screen.queryByRole('listbox', { name: '权限配置' })).toBeNull();
    expect(profile.closest<HTMLElement>('.worker-routing-cross-harness-body')?.inert).toBe(true);
    fireEvent.click(screen.getByText('跨 Harness 权限'));

    for (const [field, option] of [['权限配置', 'Workspace'], ['审批策略', 'On request'], ['审批者', 'User']]) {
      expect(checkbox().disabled).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: field }));
      fireEvent.click(await screen.findByRole('option', { name: option }));
    }
    await waitFor(() => expect(checkbox().disabled).toBe(false));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存派活配置' }).disabled).toBe(true);
    fireEvent.click(checkbox());
    const source = screen.getByRole<HTMLButtonElement>('button', { name: '用于校验的源文件夹' });
    expect(source.disabled).toBe(true);
    expect(screen.getByText('请先保存或撤销跨 Harness 授权，再切换源文件夹。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存派活配置' }));
    await screen.findByText('派活配置已保存');
    expect(source.disabled).toBe(false);
    expect(api.mockOf('workerRouting.save').mock.calls[0][0].scope).toEqual(scope);
    const submitted = api.mockOf('workerRouting.save').mock.calls[0][0].config.tiers[0].members[0];
    expect(submitted.crossHarness).toEqual({ nativeConfig });
    expect(current.tiers[0].members[0].crossHarness?.binding).toBe('server-binding');
    view.unmount();

    render(<WorkerRoutingPane workspace={workspace} active initialLayer="workspace" />);
    fireEvent.click(await screen.findByText('跨 Harness 权限'));
    await screen.findByRole('button', { name: '权限配置' });
    expect(checkbox().checked).toBe(true);
    fireEvent.click(checkbox());
    fireEvent.click(screen.getByRole('button', { name: '保存派活配置' }));
    await screen.findByText('派活配置已保存');
    expect(current.tiers[0].members[0].crossHarness).toBeUndefined();
  });

  it('clears existing cross-Harness consent when the candidate target changes', async () => {
    const api = mockCatalog();
    const initial: WorkerRoutingConfig = { revision: 5, tiers: [
      { id: 'light', kind: 'low', name: '轻量', description: '', fallbackTierIds: [], members: [
        { id: 'member', enabled: true, config: codex, crossHarness: { nativeConfig, binding: 'old-binding' } }
      ] }
    ] };
    api.override('workerRouting.read', async () => routingResult(initial, 'workspace'));
    api.override('workerRouting.save', async ({ config }) => routingResult({ ...config, revision: 6 }, 'workspace'));
    render(<WorkerRoutingPane workspace={workspace} active initialLayer="workspace" />);
    fireEvent.click(await screen.findByRole('button', { name: /Codex · GUI · codex-model/ }));
    const dialog = await screen.findByRole('dialog', { name: '编辑候选配置' });
    fireEvent.click(await within(dialog).findByRole('tab', { name: 'Muster Core' }));
    fireEvent.click(await within(dialog).findByRole('option', { name: 'Account A · Same model' }));
    await within(dialog).findByRole('radio', { name: 'High' });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认配置' }));
    await waitFor(() => expect(screen.queryByText('跨 Harness 权限')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '保存派活配置' }));
    await screen.findByText('派活配置已保存');
    const submitted = api.mockOf('workerRouting.save').mock.calls[0][0].config.tiers[0].members[0];
    expect(submitted.id).toBe('member');
    expect(submitted.config.runtimeId).toBe('pi');
    expect(submitted.crossHarness).toBeUndefined();
  });

  it('keeps the scoped Ctrl+S result after leaving the Harness tab during the write', async () => {
    const api = mockCatalog();
    const onClose = vi.fn();
    let current: WorkerRoutingConfig = { revision: 3, tiers: [
      { id: 'light', kind: 'low', name: '轻量', description: '', members: [{ id: 'existing', enabled: true, config }], fallbackTierIds: [] }
    ] };
    api.override('workerRouting.read', async () => routingResult(current));
    let completeSave!: () => void;
    api.override('workerRouting.save', ({ config }) => new Promise(resolve => {
      completeSave = () => {
        current = { ...config, revision: config.revision + 1 };
        resolve(routingResult(current));
      };
    }));
    const view = render(<KeybindingProvider><SettingsModal initialTab="worker" onClose={onClose} /></KeybindingProvider>);
    const candidate = await screen.findByRole<HTMLInputElement>('checkbox', { name: /启用 Muster Core · GUI/ });
    fireEvent.click(candidate);
    expect(screen.getByText('有 1 项更改未保存')).toBeTruthy();
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(completeSave).toBeTypeOf('function'));
    expect(api.mockOf('workerRouting.save')).toHaveBeenCalledWith({ scope, layer: 'global', expectedVersion: 'global:3', config: { revision: 3,
      tiers: [{ id: 'light', kind: 'low', name: '轻量', description: '', members: [{ id: 'existing', enabled: false, config }], fallbackTierIds: [] }] } });
    fireEvent.click(screen.getByRole('button', { name: '通用' }));
    expect(view.container.querySelector<HTMLElement>('.worker-layout')?.inert).toBe(true);
    await act(async () => completeSave());
    expect(await screen.findByText('已保存 ✓')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Harness 接入' }));
    const currentCandidate = await screen.findByRole<HTMLInputElement>('checkbox', { name: /启用 Muster Core · GUI/ });
    expect(currentCandidate.checked).toBe(false);
    expect(screen.queryByText(/其他位置更新/)).toBeNull();
    expect(api.mockOf('config.update')).not.toHaveBeenCalled();
    await waitFor(() => expect(currentCandidate.matches(':disabled')).toBe(false));
    fireEvent.click(currentCandidate);
    fireEvent.click(view.container.querySelector('.settings-back')!);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '放弃并离开' })).toBeTruthy();
  });

  it('supports stable candidate ordering, enablement, explicit successor and CAS conflict recovery', async () => {
    const api = mockCatalog();
    const first = { id: 'member-first', enabled: true, config };
    const second = { id: 'member-second', enabled: true,
      config: { ...config, model: { providerId: 'provider-b', modelId: 'same-model' } } };
    let current: WorkerRoutingConfig = { revision: 5, tiers: [
      { id: 'light', kind: 'low', name: '轻量', description: '', members: [first, second], fallbackTierIds: [] },
      { id: 'heavy', kind: 'high', name: '攻坚', description: '复杂任务', members: [], fallbackTierIds: [] },
      { id: 'same-name', kind: 'special', name: '极高', description: '历史用途', members: [], fallbackTierIds: ['heavy'] }
    ] };
    api.override('workerRouting.read', async () => routingResult(current, 'global', { members: [{ id: first.id, state: 'cooldown', retryAt: 1000 }] }));
    api.override('workerRouting.save', async ({ config, expectedVersion }) => {
      if (expectedVersion !== routingResult(current).version) throw new Error('revision conflict');
      current = { ...config, revision: config.revision + 1 };
      return routingResult(current);
    });
    api.override('workerRouting.resetCooldown', async () => routingResult(current));
    render(<WorkerRoutingPane workspace={workspace} active />);
    const light = await screen.findByRole('group', { name: '低' });
    fireEvent.click(await within(light).findByRole('button', { name: '清除冷却' }));
    await waitFor(() => expect(within(light).queryByText(/冷却中/)).toBeNull());
    expect(api.mockOf('workerRouting.resetCooldown')).toHaveBeenCalledWith({ scope, layer: 'global', expectedVersion: 'global:5', memberId: first.id });
    fireEvent.click(within(light).getAllByRole('button', { name: '下移' })[0]);
    fireEvent.click(within(light).getByRole('checkbox', { name: /provider-b/ }));
    fireEvent.click(within(light).getByText('故障替换', { exact: true }));
    fireEvent.click(within(light).getByRole('button', { name: '添加跨档后继' }));
    fireEvent.click(await screen.findByRole('option', { name: '高' }));
    fireEvent.click(screen.getByRole('button', { name: '保存派活配置' }));
    expect(await screen.findByText('派活配置已保存')).toBeTruthy();
    expect(current.tiers[0]).toMatchObject({ id: 'light', name: '轻量', fallbackTierIds: ['heavy'], members: [{ ...second, enabled: false }, first] });

    const removed = within(light).getAllByRole('button', { name: '移除候选' })[0];
    fireEvent.click(removed);
    current = { ...current, revision: 7 };
    fireEvent.click(screen.getByRole('button', { name: '保存派活配置' }));
    expect(await screen.findByText('revision conflict')).toBeTruthy();
    expect(within(light).getAllByRole('button', { name: '移除候选' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '放弃更改并重新载入' }));
    await waitFor(() => expect(within(light).getAllByRole('button', { name: '移除候选' })).toHaveLength(2));
    await act(async () => api.emit('workerRouting:changed', { kind: 'global' }));
    await waitFor(() => expect(api.mockOf('workerRouting.read')).toHaveBeenCalledTimes(3));
    const specials = screen.getByRole('region', { name: '特殊功能' });
    const sameName = within(specials).getByRole('group', { name: '极高' });
    const xhigh = screen.getAllByRole('group', { name: '极高' }).find(group => group !== sameName)!;
    expect(within(xhigh).getByText('暂无候选')).toBeTruthy();
    fireEvent.click(within(sameName).getByText('编辑功能'));
    const assign = within(sameName).getByRole<HTMLButtonElement>('button', { name: '分配到标准档' });
    await waitFor(() => expect(assign.matches(':disabled')).toBe(false));
    fireEvent.click(assign);
    fireEvent.click(await screen.findByRole('option', { name: '极高' }));
    expect(within(specials).queryByRole('group', { name: '极高' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '保存派活配置' }));
    await screen.findByText('派活配置已保存');
    expect(current.tiers[2]).toEqual({ id: 'same-name', kind: 'xhigh', name: '极高', description: '历史用途', members: [], fallbackTierIds: ['heavy'] });
  });

  it('materializes only the configured extra-high tier with ordered candidates and independent reasoning', async () => {
    const api = mockCatalog();
    const empty: WorkerRoutingConfig = { revision: 0, tiers: [] };
    api.override('workerRouting.read', async () => routingResult(empty));
    api.override('workerRouting.save', async ({ config }) => routingResult({ ...config, revision: 1 }));
    render(<WorkerRoutingPane workspace={workspace} active />);
    const standard = ['低', '中', '高', '极高'];
    expect(screen.getAllByRole('group').filter(group => group.tagName === 'FIELDSET').map(group => group.getAttribute('aria-label'))).toEqual(standard);
    for (const name of standard) expect(within(screen.getByRole('group', { name })).getByText('暂无候选')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '功能名称' })).toBeNull();
    expect(api.mockOf('workerRouting.save')).not.toHaveBeenCalled();
    const add = screen.getByRole<HTMLButtonElement>('button', { name: '为极高添加候选' });
    await waitFor(() => expect(add.matches(':disabled')).toBe(false));
    for (const [account, effort] of [['A', 'Low'], ['B', 'High']]) {
      fireEvent.click(add);
      const dialog = await screen.findByRole('dialog', { name: '添加候选配置' });
      fireEvent.click(await within(dialog).findByRole('option', { name: `Account ${account} · Same model` }));
      const reasoningOption = await within(dialog).findByRole<HTMLButtonElement>('radio', { name: effort });
      await waitFor(() => expect(reasoningOption.disabled).toBe(false));
      fireEvent.click(reasoningOption);
      fireEvent.click(within(dialog).getByRole('button', { name: '确认配置' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '添加候选配置' })).toBeNull());
    }
    expect(document.activeElement).toBe(add);
    const extraHigh = screen.getByRole('group', { name: '极高' });
    const moveSecond = within(extraHigh).getAllByRole('button', { name: '上移' })[1];
    fireEvent.click(moveSecond);
    fireEvent.click(screen.getByRole('button', { name: '添加特殊功能' }));
    fireEvent.change(screen.getByRole('textbox', { name: '功能名称' }), { target: { value: 'Review' } });
    fireEvent.change(screen.getByRole('textbox', { name: '适用说明' }), { target: { value: 'Review changes' } });
    fireEvent.click(screen.getByRole('button', { name: '添加功能' }));
    const special = screen.getByRole('group', { name: 'Review' });
    fireEvent.click(within(special).getByText('编辑功能'));
    fireEvent.change(within(special).getByRole('textbox', { name: '功能名称' }), { target: { value: ' ' } });
    expect(within(special).getByRole<HTMLButtonElement>('button', { name: '分配到标准档' }).disabled).toBe(true);
    fireEvent.change(within(special).getByRole('textbox', { name: '功能名称' }), { target: { value: 'Code review' } });
    fireEvent.click(screen.getByRole('button', { name: '保存派活配置' }));
    await screen.findByText('派活配置已保存');
    const submitted = api.mockOf('workerRouting.save').mock.calls[0][0].config;
    expect(submitted.tiers).toEqual([
      expect.objectContaining({ kind: 'xhigh', name: '极高', members: [
        expect.objectContaining({ config: { ...config, model: { providerId: 'provider-b', modelId: 'same-model' } } }),
        expect.objectContaining({ config: { ...config, modelParameters: { reasoning: 'low' } } })
      ] }),
      expect.objectContaining({ kind: 'special', name: 'Code review', description: 'Review changes' })
    ]);
  });

  it('keeps an open candidate editor on its original revision when a concurrent update arrives', async () => {
    const api = mockCatalog();
    const initial: WorkerRoutingConfig = { revision: 5, tiers: [{ id: 'old', kind: 'low', name: '轻量', description: '',
      members: [{ id: 'member', config, enabled: true }], fallbackTierIds: [] }] };
    let current = initial;
    api.override('workerRouting.read', async () => routingResult(current));
    api.override('workerRouting.save', async ({ config, expectedVersion }) => {
      if (expectedVersion !== routingResult(current).version) throw new Error('revision conflict');
      return routingResult(config);
    });
    render(<WorkerRoutingPane workspace={workspace} active />);
    fireEvent.click(await screen.findByRole('button', { name: /Muster Core · GUI · provider-a/ }));
    const dialog = screen.getByRole('dialog', { name: '编辑候选配置' });
    current = { revision: 6, tiers: [{ ...initial.tiers[0], members: [] }] };
    await act(async () => api.emit('workerRouting:changed', { kind: 'global' }));
    await screen.findByText(/其他位置更新/);
    fireEvent.click(await within(dialog).findByRole('option', { name: 'Account B · Same model' }));
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: '确认配置' });
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑候选配置' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '保存派活配置' }));
    expect(await screen.findByText('revision conflict')).toBeTruthy();
    expect(api.mockOf('workerRouting.save').mock.calls[0][0].config.revision).toBe(5);
  });
});
