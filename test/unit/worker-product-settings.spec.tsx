import { renderWithAppTips as render, findAppTip } from './helpers/app-tips';
import React, { useState } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerPane } from '../../src/renderer/src/components/settings/WorkerPane';
import { SettingsSectionJumpProvider } from '../../src/renderer/src/components/settings/SettingsSectionJump';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { currentApiMock } from './helpers/api-mock';
import type { AgentRuntimeEntry, AppConfig } from '../../src/shared/types';
import { HARNESS_CATALOG } from '../../src/shared/harnessCatalog';
import { applyLocaleSetting } from '../../src/shared/i18n';
import { cliInstallHint } from '../../src/shared/runtimePreflight';

const rt = (id: string, surface: 'chat' | 'pty', enabled = true): AgentRuntimeEntry => ({ id, label: id, surface, enabled, builtin: true, script: '', updatedAt: 1 });
const probe = (id: string) => ({ id, status: 'available' as const, ok: true, checkedAt: 1, surface: 'chat' as const, problems: [] });
let entries: AgentRuntimeEntry[], width: number;
const cfg = (): AppConfig => ({ defaultRuntime: 'claude', workspace: '/fixture', activeWorkspaceId: 'w',
  workspaces: [{ id: 'w', name: 'Fixture', path: '/fixture' }] } as AppConfig);
const choose = (name: string) => userEvent.click(screen.getByRole('button', { name: `配置 ${name}` }));
const wrapper = (initial = cfg()) => {
  function Holder() { const [value, setValue] = useState(initial); return <KeybindingProvider><WorkerPane cfg={value} set={patch => setValue(previous => ({ ...previous, ...patch }))}/></KeybindingProvider>; }
  return render(<Holder/>);
};
beforeEach(() => {
  width = 900;
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    return this.classList.contains('worker-pane') ? { x: 0, y: 0, width, height: 700, top: 0, bottom: 700, left: 0, right: width, toJSON() {} } : original.call(this);
  });
  entries = [rt('pi', 'chat'), rt('claude', 'chat'), rt('claude-code', 'pty', false), rt('acp', 'chat'), rt('opencode', 'pty', false),
    { ...rt('local', 'pty'), builtin: false, label: 'Local Tool' }];
  const api = currentApiMock();
  api.override('runtimes.list', async () => [...entries]);
  api.override('runtimes.availability', async () => ({ runtimes: entries.filter(e => e.enabled), checkedAt: 1,
    runtimePreflights: { pi: probe('pi'), claude: probe('claude') }, acpAgents: [{ id: 'opencode', name: 'OpenCode' }, { id: 'kimi', name: 'Kimi Code' }],
    acpPreflights: { opencode: probe('acp'), kimi: probe('acp') }, cliPrograms: { 'claude-code': { status: 'found', command: 'claude' } } }));
  api.override('agentSession.getHarnessModelSelections', async () => ({}));
  api.override('agentSession.listLocalHarnessModels', async () => ({ ok: true, items: [] }));
  api.override('agentSession.listAcpModels', async () => ({ ok: true, items: [] }));
  api.override('agentSession.describeModelParameters', async () => ({ runtimeId: 'claude', parameters: [] }));
  api.override('runtimes.update', async (patch: any) => {
    entries = entries.map(e => e.id === patch.id ? { ...e, ...patch } : e);
    return { ok: true };
  });
  api.override('config.update', async (patch: any) => ({ ...cfg(), ...patch }));
  api.override('shell.getInfo', async () => ({ platform: 'linux', profiles: [], bgShellMode: 'auto', manualGitBashPath: '', manualGitBashPathExists: false }));
});
afterEach(() => vi.restoreAllMocks());

describe('product-based Agent settings', () => {
  it('uses the toolbar Refresh for the full catalog batch and displays scoped progress and failures', async () => {
    const api = currentApiMock();
    let finish!: (value: unknown) => void;
    api.override('agentSession.refreshHarnessModelCatalogs', () => new Promise(resolve => { finish = resolve; }));
    wrapper();
    const refresh = await screen.findByRole('button', { name: /^刷新$/ });
    await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
    expect(api.mockOf('agentSession.refreshHarnessModelCatalogs')).not.toHaveBeenCalled();
    await userEvent.click(refresh);
    const progress = await screen.findByRole('dialog', { name: '模型目录刷新' });
    expect(within(progress).getByText('正在检测本机引擎…')).toBeTruthy();
    const requestId = api.mockOf('agentSession.refreshHarnessModelCatalogs').mock.calls[0][0];
    const codex = { id: '0', name: 'Codex', source: 'Repo A', state: 'queued' as const };
    const acp = { id: '1', name: 'OpenCode', source: 'Repo B', state: 'queued' as const };
    act(() => api.emit('agentSession:harnessCatalogRefreshProgress', { requestId, kind: 'catalogs', workspace: 'Fixture', rows: [codex, acp] }));
    act(() => api.emit('agentSession:harnessCatalogRefreshProgress', { requestId, kind: 'progress', row: {
      ...acp, state: 'reading', progress: { completed: 2, total: 4, model: 'Current model' }
    } }));
    expect(within(progress).getByText(/思考档 2\/4.*Current model/)).toBeTruthy();
    await userEvent.click(within(progress).getByRole('button', { name: '关闭' }));
    await userEvent.click(screen.getByRole('button', { name: '查看刷新进度' }));
    expect(api.mockOf('agentSession.refreshHarnessModelCatalogs')).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true, workspace: 'Fixture', rows: [
      { ...codex, state: 'done', models: 2 }, { ...acp, state: 'failed', error: 'Fixture catalog unavailable' }
    ] }));
    const result = screen.getByRole('dialog', { name: '模型目录刷新' });
    expect(within(result).getByText('已处理 2/2 项')).toBeTruthy();
    expect(within(result).getByText('已读取 2 个模型')).toBeTruthy();
    expect((await findAppTip()).textContent).toContain('Fixture catalog unavailable');
    expect(within(result).getByText('Repo A')).toBeTruthy();
    expect(within(result).getByText('Repo B')).toBeTruthy();
  });

  it('shows the workspace name once when the batch has a single source', async () => {
    currentApiMock().override('agentSession.refreshHarnessModelCatalogs', async () => ({
      ok: true, workspace: 'Fixture', rows: [{ id: '0', name: 'Qwen Code', state: 'done', models: 13 }]
    }));
    wrapper();
    await userEvent.click(await screen.findByRole('button', { name: /^刷新$/ }));
    const progress = await screen.findByRole('dialog', { name: '模型目录刷新' });
    await within(progress).findByText('已读取 13 个模型');
    expect([...progress.querySelectorAll('.worker-refresh-detail')].map(item => item.textContent)).toEqual([
      'Fixture', '已读取 13 个模型'
    ]);
  });

  it('submits a manifest through registration and displays its two endpoints as one product', async () => {
    const api = currentApiMock();
    const manifest = { id: 'custom-agent', label: 'Custom Agent', terminal: { command: 'custom-agent', args: [] },
      chat: { transport: 'acp' as const, command: 'custom-agent', args: ['--acp'] } };
    api.override('runtimes.register', async () => {
      entries.push({ ...rt(manifest.id, 'pty'), builtin: false, label: manifest.label, manifest });
      return { ok: true };
    });
    wrapper();
    await screen.findByRole('heading', { name: 'Claude Code' });
    await userEvent.click(screen.getByRole('button', { name: '默认与通用' }));
    const input = screen.getByRole('textbox', { name: '运行时 JSON 声明' });
    expect((screen.getByRole('button', { name: '注册' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: JSON.stringify(manifest) } });
    await userEvent.click(screen.getByRole('button', { name: '注册' }));
    await waitFor(() => expect(api.mockOf('runtimes.register')).toHaveBeenCalledWith(manifest));
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''));
    await choose('Custom Agent');
    expect(screen.getByRole('tab', { name: '工作台聊天' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '原生终端' })).toBeTruthy();
  });

  it('switches known ACP installation instructions without changing the preflight snapshot', async () => {
    const fix = cliInstallHint('acp').installCmd;
    const checked = { ...probe('acp'), status: 'not_installed' as const, ok: false, problems: [{ code: 'cli_missing', message: '原始检测', fix }] };
    currentApiMock().override('runtimes.availability', async () => ({ runtimes: entries.filter(e => e.enabled), checkedAt: 1,
      runtimePreflights: { pi: probe('pi'), claude: probe('claude') }, acpAgents: [{ id: 'opencode', name: 'OpenCode' }], acpPreflights: { opencode: checked }, cliPrograms: {} }));
    const view = wrapper();
    await screen.findByRole('heading', { name: 'Claude Code' });
    await userEvent.click(screen.getByRole('button', { name: '全部支持' }));
    await choose('OpenCode');
    await userEvent.click(screen.getByRole('tab', { name: '工作台聊天' }));
    expect((await screen.findAllByText(fix)).length).toBeGreaterThan(0);
    try {
      await act(async () => { applyLocaleSetting('en'); await Promise.resolve(); });
      expect(screen.getAllByText('npm install -g opencode-ai (or npm install -g @google/gemini-cli)').length).toBeGreaterThan(0);
      expect(checked.problems[0].fix).toBe(fix);
    } finally { view.unmount(); act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('opens the native MiMo ACP settings and its installation guide', async () => {
    wrapper();
    await screen.findByRole('heading', { name: 'Claude Code' });
    await userEvent.click(screen.getByRole('button', { name: '全部支持' }));
    await choose('MiMo Code');
    expect(screen.getByRole('heading', { name: 'MiMo Code' })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: '工作台聊天' }));
    expect(screen.getByRole('link', { name: '安装指南' }).getAttribute('href')).toBe('https://github.com/XiaomiMiMo/MiMo-Code');
    expect(screen.queryByText('GLM Coding Plan')).toBeNull();
    expect(screen.queryByText('MiMo Token Plan')).toBeNull();
    expect(screen.queryByText('需要 Claude Code 和对应服务配置')).toBeNull();
    expect(screen.getByRole('tab', { name: '工作台聊天', selected: true })).toBeTruthy();
  });

  it('shows Qwen Code as a managed ACP chat and terminal product', async () => {
    entries = [...entries, rt('qwen-cli', 'pty')];
    wrapper();
    await screen.findByRole('heading', { name: 'Claude Code' });
    await userEvent.click(screen.getByRole('button', { name: '全部支持' }));
    await choose('Qwen Code');
    expect(screen.getByRole('heading', { name: 'Qwen Code' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '工作台聊天' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '原生终端' })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: '工作台聊天' }));
    expect(screen.getByRole('link', { name: '安装指南' }).getAttribute('href')).toBe('https://github.com/QwenLM/qwen-code');
  });

  it('shows DeepSeek ACP chat without a native terminal tab', async () => {
    expect(HARNESS_CATALOG.find(entry => entry.id === 'deepseek')?.cliRuntimeId).toBeUndefined();
    wrapper();
    await screen.findByRole('heading', { name: 'Claude Code' });
    await userEvent.click(screen.getByRole('button', { name: '全部支持' }));
    await choose('DeepSeek');
    expect(screen.getByRole('tab', { name: '工作台聊天' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: '原生终端' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: '启用 DeepSeek 原生终端' })).toBeNull();
  });

  it('lists each product once and independently updates its real chat and terminal endpoints', async () => {
    wrapper();
    await screen.findByRole('heading', { name: 'Claude Code' });
    const nav = screen.getByRole('navigation', { name: 'Worker 列表' });
    expect(within(nav).getAllByRole('button', { name: '配置 Claude Code' })).toHaveLength(1);
    expect(within(nav).queryByText('其他配置与终端')).toBeNull();
    expect(screen.queryByText('支持的 Harness')).toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: '启用 Claude Code 原生终端' }));
    await waitFor(() => expect(currentApiMock().mockOf('runtimes.update')).toHaveBeenCalledWith({ id: 'claude-code', enabled: true }));
    expect((screen.getByRole('checkbox', { name: '启用 Claude Code 工作台聊天' }) as HTMLInputElement).checked).toBe(true);
  });

  it('separates chat models from terminal arguments and retains drafts through keyboard scope navigation', async () => {
    const api = currentApiMock();
    api.override('agentSession.listLocalHarnessModels', async () => ({ ok: true, items: [{ id: 'sonnet', name: 'Sonnet' }, { id: 'opus', name: 'Opus' }] }));
    api.override('agentSession.setHarnessModelSelection', async ({ key, modelIds }: any) => ({ [key]: modelIds }));
    wrapper();
    await screen.findByRole('heading', { name: 'Claude Code' });
    await userEvent.click(screen.getByRole('tab', { name: '工作台聊天' }));
    const model = await screen.findByRole('checkbox', { name: /Sonnet/ });
    expect(screen.queryByRole('textbox', { name: 'Worker 显示名' })).toBeNull();
    expect(screen.queryByRole('button', { name: '运行时' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: '服务商 ID（可选）' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
    await userEvent.click(model);
    await waitFor(() => expect(api.mockOf('agentSession.setHarnessModelSelection')).toHaveBeenCalledWith({ key: 'runtime:claude', modelIds: ['opus'] }));
    screen.getByRole('tab', { name: '工作台聊天' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '原生终端', selected: true }));
    expect(screen.queryByRole('checkbox', { name: /Sonnet/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '读取可用参数' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /使用独立配置目录/ })).toBeNull();
    const draft = screen.getByRole('textbox', { name: '额外启动参数（空格分词）' });
    fireEvent.change(draft, { target: { value: '--test-draft' } });
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('tabpanel', { name: '通用' })).toBeTruthy();
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('textbox', { name: '额外启动参数（空格分词）' })).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe('--test-draft');
    await userEvent.click(screen.getByRole('button', { name: '保存此项' }));
    await waitFor(() => expect(api.mockOf('runtimes.update')).toHaveBeenCalledWith({ id: 'claude-code', extraArgs: ['--test-draft'] }));
    expect(api.mockOf('agentSession.listLocalHarnessModels').mock.calls.every(([args]) => args.refresh === false)).toBe(true);
  });

  it('opens the connection view when navigating to the existing Claude settings anchor', async () => {
    const { rerender } = render(<KeybindingProvider><WorkerPane cfg={cfg()} set={() => {}}/></KeybindingProvider>);
    await screen.findByRole('heading', { name: 'Claude Code' });
    expect(screen.queryByRole('button', { name: '重新读取配置' })).toBeNull();
    rerender(<KeybindingProvider><WorkerPane cfg={cfg()} set={() => {}} focusItem="worker-claude-gui"/></KeybindingProvider>);
    expect(await screen.findByRole('tab', { name: '工作台聊天', selected: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新读取配置' })).toBeTruthy();
  });

  it('keeps Core a single settings page without the related resources block', async () => {
    const navigate = vi.fn();
    render(<KeybindingProvider><SettingsSectionJumpProvider activeTab="worker"><WorkerPane cfg={cfg()} set={() => {}} onNavigate={navigate}/></SettingsSectionJumpProvider></KeybindingProvider>);
    await screen.findByRole('heading', { name: 'Claude Code' });
    await choose('Muster Core');
    expect(screen.queryByRole('tablist', { name: 'Agent 配置内容' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
    expect(screen.queryByRole('button', { name: '编辑脚本' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Worker 显示名' })).toBeNull();
    expect(screen.queryByText('MCP 注册方式')).toBeNull();
    expect(screen.queryByText('启动配置')).toBeNull();
    expect(screen.queryByRole('region', { name: '关联资源' })).toBeNull();
    expect(screen.queryByRole('button', { name: '管理模型服务商' })).toBeNull();
    expect(screen.queryByRole('button', { name: '管理能力' })).toBeNull();
    for (const name of ['基本信息', '可用模型', '模型参数']) {
      expect(within(screen.getByRole('heading', { name })).queryByRole('button')).toBeNull();
    }
    expect(screen.getByRole('checkbox', { name: '启用 Muster Core 工作台聊天' })).toBeTruthy();
    await choose('Claude Code');
    await userEvent.click(screen.getByRole('button', { name: '管理能力' }));
    expect(navigate).toHaveBeenLastCalledWith('capabilityManagement');
  });

  it('reads and saves ACP parameters for the selected preset while retaining other presets', async () => {
    const api = currentApiMock();
    const existing = { runtimeId: 'acp', providerId: 'acp:opencode', parameters: { effort: { defaultValue: 'low' } } };
    api.override('agentSession.describeModelParameters', async () => ({ runtimeId: 'acp', providerId: 'acp:kimi', modelId: 'native', parameters: [
      { id: 'effort', label: 'Effort', apply: 'reconnect', supportsDefault: true, options: [{ value: 'low', label: 'Low' }] }
    ] }));
    api.override('agentSession.saveParameterProfiles', async profiles => ({ ok: true, profiles }));
    wrapper({ ...cfg(), modelParameterProfiles: [existing] });
    await screen.findByRole('heading', { name: 'Claude Code' });
    await choose('Kimi Code');
    await userEvent.click(screen.getByRole('tab', { name: '工作台聊天' }));
    await userEvent.click(screen.getByRole('button', { name: '读取可用参数' }));
    expect(api.mockOf('agentSession.describeModelParameters')).toHaveBeenCalledWith({ runtimeId: 'acp', providerId: 'acp:kimi', piModeId: 'kimi', refresh: true });
    await userEvent.click(await screen.findByRole('button', { name: 'effort 默认值' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Low' }));
    await userEvent.click(screen.getByRole('button', { name: '保存参数配置' }));
    await waitFor(() => expect(api.mockOf('agentSession.saveParameterProfiles')).toHaveBeenCalledWith([
      existing, expect.objectContaining({ runtimeId: 'acp', providerId: 'acp:kimi', parameters: expect.objectContaining({ effort: expect.objectContaining({ defaultValue: 'low' }) }) })
    ]));
  });

  it('preserves provider identity when Core has the same model ID from two providers', async () => {
    const api = currentApiMock();
    const initial = { ...cfg(), llm: { providers: [{ id: 'p1', name: 'One', models: [{ id: 'same', name: 'Model' }] }, { id: 'p2', name: 'Two', models: [{ id: 'same', name: 'Model' }] }] } } as unknown as AppConfig;
    wrapper(initial);
    await screen.findByRole('heading', { name: 'Claude Code' });
    await choose('Muster Core');
    await userEvent.click(screen.getByRole('button', { name: '参数应用范围' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Two · Model' }));
    await userEvent.click(screen.getByRole('button', { name: '读取可用参数' }));
    expect(api.mockOf('agentSession.describeModelParameters')).toHaveBeenCalledWith({ runtimeId: 'pi', providerId: 'p2', modelId: 'same', refresh: true });
  });

  it('uses Cursor ACP for chat models and CLI sign-in', async () => {
    const api = currentApiMock();
    entries.push(rt('cursor-cli', 'pty'));
    api.override('agentSession.listAcpModels', async () => ({ ok: true, items: [{ id: 'composer', name: 'Composer' }] }));
    wrapper();
    await screen.findByRole('heading', { name: 'Claude Code' });
    await userEvent.click(screen.getByRole('button', { name: '全部支持' }));
    await choose('Cursor');
    expect(screen.getByText('聊天通过 Cursor CLI 的 ACP 接入，使用 CLI 登录或 CURSOR_API_KEY 环境变量。')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '启用 Cursor 工作台聊天' })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: '工作台聊天' }));
    expect(await screen.findByRole('checkbox', { name: /Composer/ })).toBeTruthy();
    expect(screen.queryByLabelText('Cursor API Key')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '刷新模型目录' }));
    await waitFor(() => expect(api.mockOf('agentSession.listAcpModels')).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'cursor', refresh: true })));
  });

  it('keeps unsupported and uninstalled entries in the full catalog and preserves the detail while searching', async () => {
    wrapper();
    await screen.findByRole('heading', { name: 'Claude Code' });
    expect(screen.queryByRole('button', { name: '配置 Pi' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '全部支持' }));
    expect(screen.getByRole('button', { name: '配置 Pi' })).toBeTruthy();
    await userEvent.type(screen.getByRole('searchbox', { name: '搜索 Agent' }), 'Pi');
    expect(screen.queryByRole('button', { name: '配置 Claude Code' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Claude Code' })).toBeTruthy();
    await choose('Pi');
    expect(screen.getByRole('link', { name: '安装指南' }).getAttribute('href')).toBe('https://github.com/earendil-works/pi');
  });

  it('shows only built-in Agents', async () => {
    wrapper();
    await screen.findByRole('heading', { name: 'Claude Code' });
    expect(screen.queryByRole('button', { name: '配置 Local Tool' })).toBeNull();
  });

  it('disables one ACP product without changing the shared runtime or another ACP product', async () => {
    wrapper();
    await screen.findByRole('heading', { name: 'Claude Code' });
    await choose('OpenCode');
    await userEvent.click(screen.getByRole('checkbox', { name: '启用 OpenCode 工作台聊天' }));
    await waitFor(() => expect(currentApiMock().mockOf('config.update')).toHaveBeenCalledWith({ disabledAcpAgents: ['opencode'] }));
    expect(currentApiMock().mockOf('runtimes.update')).not.toHaveBeenCalled();
    await choose('Kimi Code');
    expect((screen.getByRole('checkbox', { name: '启用 Kimi Code 工作台聊天' }) as HTMLInputElement).checked).toBe(true);
    await choose('OpenCode');
    expect((screen.getByRole('checkbox', { name: '启用 OpenCode 工作台聊天' }) as HTMLInputElement).checked).toBe(false);
  });

  it('enables just the selected product when restoring a legacy-disabled ACP transport', async () => {
    entries = entries.map(entry => entry.id === 'acp' ? { ...entry, enabled: false } : entry);
    wrapper();
    await screen.findByRole('heading', { name: 'Claude Code' });
    await choose('OpenCode');
    await userEvent.click(screen.getByRole('checkbox', { name: '启用 OpenCode 工作台聊天' }));
    await waitFor(() => expect(currentApiMock().mockOf('runtimes.update')).toHaveBeenCalledWith({ id: 'acp', enabled: true }));
    expect(currentApiMock().mockOf('config.update')).toHaveBeenCalledWith({ disabledAcpAgents: expect.arrayContaining(['kimi']) });
    expect((currentApiMock().mockOf('config.update').mock.calls[0][0] as { disabledAcpAgents: string[] }).disabledAcpAgents).not.toContain('opencode');
    await choose('Kimi Code');
    expect((screen.getByRole('checkbox', { name: '启用 Kimi Code 工作台聊天' }) as HTMLInputElement).checked).toBe(false);
  });

  it('does not report success when an ACP switch cannot be saved', async () => {
    currentApiMock().override('config.update', async () => { throw new Error('disk unavailable'); });
    currentApiMock().override('workerRouting.read', async ({ layer }: { layer: string }) => ({
      layer, origin: layer, version: '0', config: { revision: 0, tiers: [] }, members: []
    }));
    wrapper();
    await screen.findByRole('heading', { name: 'Claude Code' });
    await choose('OpenCode');
    await userEvent.click(screen.getByRole('checkbox', { name: '启用 OpenCode 工作台聊天' }));
    expect((await findAppTip()).textContent).toContain('disk unavailable');
    expect((screen.getByRole('checkbox', { name: '启用 OpenCode 工作台聊天' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText('使用方式已保存')).toBeNull();
  });

  it('preserves independent column positions and restores list focus across narrow detail navigation', async () => {
    width = 390;
    wrapper();
    await screen.findByRole('button', { name: '配置 Claude Code' });
    const target = screen.getByRole('button', { name: '配置 Claude Code' });
    const list = document.querySelector<HTMLElement>('.worker-list-scroll')!;
    const detail = document.querySelector<HTMLElement>('.worker-detail')!;
    list.scrollTop = 140;
    await userEvent.click(target);
    expect(screen.getByRole('heading', { name: 'Claude Code' })).toBeTruthy();
    expect(list.scrollTop).toBe(140);
    detail.scrollTop = 240;
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(target));
    expect(screen.getByRole('navigation', { name: 'Worker 列表' }).inert).toBe(false);
    expect(list.scrollTop).toBe(140);
    expect(detail.scrollTop).toBe(240);
    await userEvent.click(target);
    expect(document.querySelector('.worker-list-scroll')).toBe(list);
    expect(document.querySelector('.worker-detail')).toBe(detail);
    expect(list.scrollTop).toBe(140);
    expect(detail.scrollTop).toBe(240);
  });
});
