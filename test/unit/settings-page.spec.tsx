/**
 * 整窗设置页（SettingsModal）交互契约：
 * - 左导航按分组列出全部页签，点击切页（xfade is-shown）；
 * - 搜索框回车跳到命中项所在页并闪烁高亮该项；
 * - 表单改动 → 底部浮动保存条「N 项更改未保存」；撤销还原、保存写 config.update 且不关页；
 * - 有未保存更改时 Esc 先问一次，再按 Esc 才放弃并离开；
 * - countFormChanges 不把即时生效键（主题/语言/快捷键…）计入未保存。
 */
import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsModal, countFormChanges, type SettingsTab } from '../../src/renderer/src/components/settings/SettingsModal';
import { SettingsSurfacePortal } from '../../src/renderer/src/components/settings/SettingsSurfacePortal';
import { SETTINGS_TABS } from '../../src/shared/commandPalette';
import { closeTopOverlay } from '../../src/renderer/src/keybindings/overlayStack';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { currentApiMock } from './helpers/api-mock';
import type { AppConfig } from '../../src/shared/types';
import type { ManagedMcpEntry, McpManagementInventory, McpSaveInput } from '../../src/shared/mcpManagement';
import type { CapabilityScope } from '../../src/shared/capabilityManagement';

function makeCfg(): AppConfig {
  return {
    defaultRuntime: 'cursor',
    workspace: 'E:/ws',
    workspaces: [{ id: 'w1', name: 'WS', path: 'E:/ws' }],
    activeWorkspaceId: 'w1',
    locale: 'zh-CN',
    mcp: { enabled: false, servers: [] },
    openai: { baseUrl: '', apiKey: '', model: '' },
    tasksKeepAwake: true
  } as unknown as AppConfig;
}

function renderPage(props: Partial<React.ComponentProps<typeof SettingsModal>> = {}) {
  const onClose = vi.fn();
  render(
    <KeybindingProvider>
      <SettingsModal onClose={onClose} {...props} />
    </KeybindingProvider>
  );
  return { onClose };
}

const pane = (id: string): HTMLElement =>
  document.querySelector(`.settings-tabpane[data-settings-item="${id}"]`) as HTMLElement;

describe('整窗设置页', () => {
  it('设置实例移动到另一工作面后保留未保存草稿与表单 DOM', async () => {
    const user = userEvent.setup();
    const first = document.createElement('div'), second = document.createElement('div');
    document.body.append(first, second);
    const view = (target: HTMLElement) => <KeybindingProvider><SettingsSurfacePortal target={target}>
      <SettingsModal presentation="embedded" onClose={() => {}} />
    </SettingsSurfacePortal></KeybindingProvider>;
    const rendered = render(view(first));
    try {
      const sw = await within(first).findByRole('checkbox', { name: '任务运行时阻止休眠' }) as HTMLInputElement;
      await user.click(sw);
      expect(await within(first).findByText('有 1 项更改未保存')).toBeTruthy();
      rendered.rerender(view(second));
      expect(within(second).getByRole('checkbox', { name: '任务运行时阻止休眠' })).toBe(sw);
      expect(sw.checked).toBe(false);
      expect(within(second).getByText('有 1 项更改未保存')).toBeTruthy();
      expect(first.querySelector('.settings-page')).toBeNull();
    } finally { rendered.unmount(); first.remove(); second.remove(); }
  });
  it('后台嵌入设置不夺焦或拦截快捷键，切换呈现方式保留同一份草稿', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const view = (active: boolean, presentation: 'modal' | 'embedded', searchFocusRequest = 0) => (
      <KeybindingProvider><button type="button">外部输入</button><SettingsModal onClose={onClose}
        active={active} presentation={presentation} searchFocusRequest={searchFocusRequest} /></KeybindingProvider>
    );
    const { rerender } = render(view(false, 'embedded'));
    const outside = screen.getByRole('button', { name: '外部输入' });
    outside.focus();
    rerender(view(true, 'embedded'));
    expect(document.activeElement).toBe(outside);
    await user.keyboard('{Control>}k{/Control}');
    expect(document.activeElement).toBe(outside);
    expect(screen.getByRole('region', { name: '设置' }).getAttribute('aria-modal')).toBeNull();
    rerender(view(true, 'embedded', 1));
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: '搜索设置' }));
    await user.click(await screen.findByRole('checkbox', { name: '任务运行时阻止休眠' }));
    expect(await screen.findByText('有 1 项更改未保存')).toBeTruthy();
    rerender(view(true, 'modal', 1));
    expect(screen.getByRole('dialog', { name: '设置' }).getAttribute('aria-modal')).toBe('true');
    rerender(view(false, 'embedded', 1));
    outside.focus();
    rerender(view(true, 'embedded', 1));
    expect(document.activeElement).toBe(outside);
    expect(screen.getByText('有 1 项更改未保存')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: '任务运行时阻止休眠' }) as HTMLInputElement).checked).toBe(false);
  });
  it('保活设置页明确放弃并离开时丢弃草稿，重新显示不会恢复已放弃改动', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<KeybindingProvider><SettingsModal presentation="embedded" onClose={onClose} /></KeybindingProvider>);
    const sw = await screen.findByRole('checkbox', { name: '任务运行时阻止休眠' }) as HTMLInputElement;
    await user.click(sw);
    await screen.findByText('有 1 项更改未保存');
    const back = screen.getByRole('button', { name: /返回工作台/ });
    await user.click(back);
    expect(await screen.findByText('还有 1 项更改没保存，离开前要保存吗？')).toBeTruthy();
    await user.click(back);
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('有 1 项更改未保存')).toBeNull());
    expect((screen.getByRole('checkbox', { name: '任务运行时阻止休眠' }) as HTMLInputElement).checked).toBe(true);
  });
  it('模型与输入集中展示全局处理设置，通用页不再包含，保存仍使用全局字段', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('语言与文字');
    expect(within(pane('general')).queryByLabelText('每条消息自动预览页数')).toBeNull();
    const nav = screen.getByRole('navigation', { name: '设置分组' });
    await user.click(within(nav).getByRole('button', { name: /模型与输入/ }));
    expect(await within(pane('agent')).findByRole('heading', { name: '文件与输入', level: 2 })).toBeTruthy();
    const pages = await within(pane('agent')).findByLabelText('每条消息自动预览页数');
    expect(within(pane('agent')).getByLabelText('FFmpeg 路径')).toBeTruthy();
    await user.click(pages);
    await user.keyboard('{Control>}a{/Control}2');
    const savebar = document.querySelector('.settings-savebar') as HTMLElement;
    await user.click(within(savebar).getByRole('button', { name: /^保存/ }));
    await waitFor(() => expect(currentApiMock().mockOf('config.update')).toHaveBeenCalledWith(expect.objectContaining({ attachmentProcessing: { autoPages: 2 } })));
  });
  beforeEach(() => {
    const m = currentApiMock();
    m.override('config.get', () => Promise.resolve(makeCfg()));
    m.override('config.update', () => Promise.resolve(undefined));
    // 调度 Agent / 外观页停在加载态即可（本文件不测这两页）
    m.override('capabilities.get', () => new Promise(() => {}));
    m.override('themes.list', () => new Promise(() => {}));
    // jsdom 无布局：跳转高亮调用的 scrollIntoView 需要桩
    Element.prototype.scrollIntoView = vi.fn();
    m.override('runtimes.list', () => Promise.resolve([]));
  });

  it('本机存储只在用户点击扫描时读取，切换设置页不触发扫描', async () => {
    const user = userEvent.setup(), api = currentApiMock();
    api.override('localStorage.scan', async () => ({ id: 'settings-scan', items: [], workspaces: [] }));
    renderPage({ initialTab: 'localStorage' });
    await screen.findByText('尚未扫描');
    expect(api.mockOf('localStorage.scan')).not.toHaveBeenCalled();
    const nav = screen.getByRole('navigation', { name: '设置分组' });
    await user.click(within(nav).getByRole('button', { name: '通用' }));
    await user.click(within(nav).getByRole('button', { name: '本机存储' }));
    expect(api.mockOf('localStorage.scan')).not.toHaveBeenCalled();
    await user.click(within(pane('localStorage')).getByRole('button', { name: '开始扫描' }));
    await within(pane('localStorage')).findByRole('navigation', { name: '存储类别' });
    expect(api.mockOf('localStorage.scan')).toHaveBeenCalledTimes(1);
    await user.click(within(nav).getByRole('button', { name: '通用' }));
    await user.click(within(nav).getByRole('button', { name: '本机存储' }));
    expect(api.mockOf('localStorage.scan')).toHaveBeenCalledTimes(1);
  });

  it('左导航按分组列出全部页签，点击切页', async () => {
    const user = userEvent.setup();
    renderPage();
    const nav = screen.getByRole('navigation', { name: '设置分组' });
    for (const g of ['常用', 'AI', '连接', '其他']) expect(within(nav).getByText(g)).toBeTruthy();
    expect(nav.querySelectorAll('.settings-nav-item')).toHaveLength(SETTINGS_TABS.length);
    const aiGroup = Array.from(nav.querySelectorAll('.settings-nav-group')).find(group => group.querySelector('.settings-nav-group-title')?.textContent === 'AI')!;
    expect(within(aiGroup as HTMLElement).getAllByRole('button')[0].textContent).toBe('Harness 接入');
    expect(within(aiGroup as HTMLElement).getByRole('button', { name: '调度 Agent' })).toBeTruthy();

    await screen.findByText('语言与文字');
    expect(pane('general').classList.contains('is-shown')).toBe(true);

    await user.click(within(nav).getByRole('button', { name: /外观/ }));
    expect(pane('appearance').classList.contains('is-shown')).toBe(true);
    expect(pane('general').classList.contains('is-shown')).toBe(false);
    expect(within(nav).getByRole('button', { name: /外观/ }).getAttribute('aria-current')).toBe('page');
  });

  it('从关于页面打开反馈审核', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPage();
    await screen.findByText('语言与文字');
    const nav = screen.getByRole('navigation', { name: '设置分组' });
    expect(within(nav).queryByRole('button', { name: '反馈' })).toBeNull();
    await user.click(within(nav).getByRole('button', { name: '关于' }));
    expect(pane('about').classList.contains('is-shown')).toBe(true);
    expect(within(pane('about')).queryByLabelText('反馈令牌')).toBeNull();
    expect(await within(pane('about')).findByRole('button', { name: '打开反馈项目' })).toBeTruthy();
    await user.click(within(pane('about')).getByRole('button', { name: '反馈审核' }));
    const feedback = await screen.findByRole('dialog', { name: '反馈审核' });
    expect(within(feedback).getByRole('button', { name: '手动添加反馈' })).toBeTruthy();
    act(() => { closeTopOverlay(); });
    expect(onClose).not.toHaveBeenCalled();
    expect(feedback.closest('.modal-mask')?.getAttribute('data-mp-stage')).toBe('out');
    expect(pane('about').classList.contains('is-shown')).toBe(true);
  });

  it('搜索回车跳到命中项所在页并闪烁高亮', async () => {
    const user = userEvent.setup();
    renderPage({ initialTab: 'about' });
    await waitFor(() => expect(pane('about')?.classList.contains('is-shown')).toBe(true));
    expect(screen.queryByText('语言与文字')).toBeNull(); // 未访问的通用页尚未挂内容
    await user.type(screen.getByRole('combobox', { name: '搜索设置' }), '休眠');
    expect(await screen.findByRole('option', { name: /阻止系统休眠/ })).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(pane('general').classList.contains('is-shown')).toBe(true);
    await waitFor(() =>
      expect(
        document.querySelector('[data-settings-item="worker-keep-awake"]')?.classList.contains('is-settings-flash')
      ).toBe(true)
    );
  });

  it('搜索文件转换工具时定位到模型与输入的对应分区', async () => {
    const user = userEvent.setup();
    renderPage({ initialTab: 'about' });
    await user.type(screen.getByRole('combobox', { name: '搜索设置' }), 'FFmpeg');
    expect(await screen.findByRole('option', { name: /本机文件转换工具/ })).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(await within(pane('agent')).findByLabelText('FFmpeg 路径')).toBeTruthy();
    await waitFor(() => expect(document.querySelector('[data-settings-item="agent-input-tools"]')?.classList.contains('is-settings-flash')).toBe(true));
  });

  it('改动出现保存条；撤销还原，保存写 config.update 且不关页', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPage();
    const sw = (await screen.findByRole('checkbox', { name: '任务运行时阻止休眠' })) as HTMLInputElement;
    expect(sw.checked).toBe(true);

    await user.click(sw);
    expect(await screen.findByText('有 1 项更改未保存')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(screen.queryByText('有 1 项更改未保存')).toBeNull());
    expect((screen.getByRole('checkbox', { name: '任务运行时阻止休眠' }) as HTMLInputElement).checked).toBe(true);

    await user.click(screen.getByRole('checkbox', { name: '任务运行时阻止休眠' }));
    await user.click(await screen.findByRole('button', { name: /保存/ }));
    const update = currentApiMock().mockOf('config.update');
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][0]).toMatchObject({ tasksKeepAwake: false });
    expect(update.mock.calls[0][0]).not.toHaveProperty('workspaces');
    expect(update.mock.calls[0][0]).not.toHaveProperty('activeWorkspaceId');
    expect(update.mock.calls[0][0]).not.toHaveProperty('workspace');
    expect(update.mock.calls[0][0]).not.toHaveProperty('workspaceAccentDefault');
    expect(update.mock.calls[0][0]).not.toHaveProperty('mcp');
    expect(update.mock.calls[0][0]).not.toHaveProperty('mcpByWorkspace');
    expect(await screen.findByText('已保存 ✓')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('通用页即时保存的 Shell 路径不会被随后保存的旧表单覆盖', async () => {
    const user = userEvent.setup();
    const api = currentApiMock();
    const loaded = { ...makeCfg(), shell: { bgShellMode: 'auto' as const } };
    let live: AppConfig = { ...loaded };
    api.override('config.get', () => Promise.resolve(loaded));
    api.override('config.update', (patch: Partial<AppConfig>) => { live = { ...live, ...patch }; return Promise.resolve(undefined); });
    api.override('shell.getInfo', () => Promise.resolve({ platform: 'win32', profiles: [], bgShellMode: 'auto', manualGitBashPath: '', manualGitBashPathExists: false, gitBashPath: 'C:/Git/bin/bash.exe' }));
    renderPage();
    await user.type(await screen.findByRole('textbox', { name: '手工指定 Git Bash 路径（留空恢复自动探测）' }), 'D:/Git/bin/bash.exe');
    await user.click(screen.getByRole('button', { name: '保存 Shell 设置' }));
    await waitFor(() => expect(live.shell?.manualGitBashPath).toBe('D:/Git/bin/bash.exe'));
    await user.click(screen.getByRole('checkbox', { name: '任务运行时阻止休眠' }));
    await user.click(within(document.querySelector('.settings-savebar') as HTMLElement).getByRole('button', { name: /^保存/ }));
    await screen.findByText('已保存 ✓');
    const ordinaryPatch = api.mockOf('config.update').mock.lastCall?.[0];
    expect(ordinaryPatch).not.toHaveProperty('shell');
    expect(live.shell?.manualGitBashPath).toBe('D:/Git/bin/bash.exe');
  });

  it('首次打开不初始化未访问的重页，访问后跨页保留真实输入 DOM、草稿与滚动位置', async () => {
    const user = userEvent.setup();
    renderPage();
    const input = await screen.findByRole('textbox', { name: 'worktree 存储目录' }) as HTMLInputElement;
    const api = currentApiMock();
    expect(api.mockOf('runtimes.preflight')).not.toHaveBeenCalled();
    expect(api.mockOf('agentSession.claudeStatus')).not.toHaveBeenCalled();
    expect(api.mockOf('themes.list')).not.toHaveBeenCalled();
    await user.type(input, 'E:/DraftTrees');
    input.setSelectionRange(3, 7);
    const general = pane('general');
    general.scrollTop = 246;
    const nav = screen.getByRole('navigation', { name: '设置分组' });
    await user.click(within(nav).getByRole('button', { name: /^Harness 接入/ }));
    await waitFor(() => expect(api.mockOf('runtimes.list')).toHaveBeenCalledTimes(1));
    expect(pane('worker').classList.contains('is-shown')).toBe(true);
    await user.click(within(nav).getByRole('button', { name: /^通用/ }));
    expect(screen.getByRole('textbox', { name: 'worktree 存储目录' })).toBe(input);
    expect(input.value).toBe('E:/DraftTrees');
    expect(input.selectionStart).toBe(3);
    expect(input.selectionEnd).toBe(7);
    expect(pane('general')).toBe(general);
    expect(general.scrollTop).toBe(246);
    input.focus();
    expect(document.activeElement).toBe(input);
    await user.click(within(nav).getByRole('button', { name: /^Harness 接入/ }));
    expect(api.mockOf('runtimes.list')).toHaveBeenCalledTimes(1); // 已访问内容不重挂
    expect(api.mockOf('themes.list')).not.toHaveBeenCalled();
  });

  it('外部 initialTab 更新与旧 integrations 别名都挂载目标页，已访问页继续保活', async () => {
    const api = currentApiMock();
    api.override('capabilityManagement.skillsList', (scope: CapabilityScope) => ({
      scope, revision: 1, skills: [], directories: [],  conflicts: [], errors: []
    }));
    api.override('capabilityManagement.mcpList', () => ({ enabled: false, servers: [], targets: [], deployments: [] }));
    const onClose = vi.fn();
    const page = (initialTab: SettingsTab) => <KeybindingProvider><SettingsModal initialTab={initialTab} onClose={onClose} /></KeybindingProvider>;
    const view = render(page('about'));
    await waitFor(() => expect(pane('about')?.classList.contains('is-shown')).toBe(true));
    expect(screen.queryByRole('textbox', { name: 'worktree 存储目录' })).toBeNull();
    view.rerender(page('general'));
    const input = await screen.findByRole('textbox', { name: 'worktree 存储目录' });
    view.rerender(page('integrations' as SettingsTab));
    expect(await screen.findByRole('region', { name: '能力管理' })).toBeTruthy();
    expect(pane('capabilityManagement').classList.contains('is-shown')).toBe(true);
    const managerPane = within(pane('capabilityManagement'));
    expect(managerPane.getAllByRole('heading', { name: '能力管理' })).toHaveLength(1);
    expect(managerPane.getByRole('heading', { name: '能力管理', level: 1 }).closest('header')?.className).toBe('settings-pane-title');
    view.rerender(page('general'));
    expect(screen.getByRole('textbox', { name: 'worktree 存储目录' })).toBe(input);
    expect(pane('general').classList.contains('is-shown')).toBe(true);
  });

  it('未保存改动跨页后仍走离开确认和保存并离开，不因惰性内容丢草稿', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPage();
    await user.type(await screen.findByRole('textbox', { name: 'worktree 存储目录' }), 'E:/LeaveDraft');
    await user.click(within(screen.getByRole('navigation', { name: '设置分组' })).getByRole('button', { name: /^外观/ }));
    await user.click(screen.getByRole('button', { name: /返回工作台/ }));
    expect(await screen.findByText('还有 1 项更改没保存，离开前要保存吗？')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '保存并离开' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(currentApiMock().mockOf('config.update')).toHaveBeenCalledWith(expect.objectContaining({ worktreeStorageRoot: 'E:/LeaveDraft' }));
  });

  it('能力管理即时保存后，普通表单的旧配置草稿不能回写全局或项目 MCP', async () => {
    const user = userEvent.setup();
    const api = currentApiMock();
    const oldServer = { name: 'workspace-old', enabled: true, transport: 'stdio' as const, command: 'node', args: ['server.mjs'] };
    const loaded: AppConfig = { ...makeCfg(), mcp: { enabled: false, servers: [{ ...oldServer, name: 'global-old' }] }, mcpByWorkspace: { w1: [oldServer] } };
    let live: AppConfig = JSON.parse(JSON.stringify(loaded));
    let revision = 'mcp-before';
    const entry = (): ManagedMcpEntry => ({ id: 'p:workspace-old', scope: 'project', workspaceId: 'w1', revision, server: live.mcpByWorkspace!.w1[0] });
    const inventory = (): McpManagementInventory => ({ enabled: live.mcp.enabled, workspaceId: 'w1', servers: [entry()] });
    api.override('config.get', () => Promise.resolve(loaded));
    api.override('config.update', (patch: Partial<AppConfig>) => { live = { ...live, ...patch }; return Promise.resolve(undefined); });
    api.override('capabilityManagement.skillsList', (scope: CapabilityScope) => ({ scope, revision: 1, skills: [], directories: [],  conflicts: [], errors: [] }));
    api.override('capabilityManagement.mcpList', () => inventory());
    api.override('capabilityManagement.setMcpEnabled', (enabled: boolean) => { live = { ...live, mcp: { ...live.mcp, enabled } }; return inventory(); });
    api.override('capabilityManagement.saveMcp', (input: McpSaveInput) => { live = { ...live, mcpByWorkspace: { w1: [input.server] } }; revision = 'mcp-after'; return entry(); });
    renderPage({ initialTab: 'capabilityManagement' });
    const manager = await screen.findByRole('region', { name: '能力管理' });
    await user.click(within(manager).getByRole('button', { name: /^MCP(?:\s|\d|$)/ }));
    await user.click(await within(manager).findByRole('checkbox', { name: '启用 MCP' }));
    await waitFor(() => expect(live.mcp.enabled).toBe(true));
    await waitFor(() => expect((within(manager).getByRole('button', { name: '查看 workspace-old' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(within(manager).getByRole('button', { name: '查看 workspace-old' }));
    await user.click(within(manager).getByRole('button', { name: '编辑配置' }));
    const editor = await screen.findByRole('dialog', { name: '编辑 MCP 服务器' });
    await user.clear(within(editor).getByRole('textbox', { name: '服务器名称' }));
    await user.type(within(editor).getByRole('textbox', { name: '服务器名称' }), 'workspace-current');
    await user.click(within(editor).getByRole('button', { name: '保存服务器' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑 MCP 服务器' })).toBeNull());
    await user.click(within(screen.getByRole('navigation', { name: '设置分组' })).getByRole('button', { name: /^通用/ }));
    await user.click(screen.getByRole('checkbox', { name: '任务运行时阻止休眠' }));
    await user.click(await screen.findByRole('button', { name: /^保存/ }));
    await screen.findByText('已保存 ✓');
    const patch = api.mockOf('config.update').mock.calls[0][0];
    expect(patch).toMatchObject({ tasksKeepAwake: false });
    expect(patch).not.toHaveProperty('mcp');
    expect(patch).not.toHaveProperty('mcpByWorkspace');
    expect(live.mcp.enabled).toBe(true);
    expect(live.mcpByWorkspace!.w1[0].name).toBe('workspace-current');
  });

  it('worktree 目录编辑、撤销与保存只影响新任务的配置', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByRole('textbox', { name: 'worktree 存储目录' }), 'D:/AgentTrees');
    expect(await screen.findByText('有 1 项更改未保存')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '撤销' }));
    expect((screen.getByRole('textbox', { name: 'worktree 存储目录' }) as HTMLInputElement).value).toBe('');
    await user.type(screen.getByRole('textbox', { name: 'worktree 存储目录' }), 'E:/AgentTrees');
    await user.click(await screen.findByRole('button', { name: /保存/ }));
    await waitFor(() => expect(currentApiMock().mockOf('config.update')).toHaveBeenCalledWith(expect.objectContaining({ worktreeStorageRoot: 'E:/AgentTrees' })));
  });

  it('有未保存更改时 Esc 先问一次，再按才离开', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPage();
    await user.click(await screen.findByRole('checkbox', { name: '任务运行时阻止休眠' }));
    await screen.findByText('有 1 项更改未保存');

    act(() => {
      closeTopOverlay();
    });
    expect(await screen.findByText('还有 1 项更改没保存，离开前要保存吗？')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      closeTopOverlay();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(currentApiMock().mockOf('config.update')).not.toHaveBeenCalled();
  });

  it('无改动时 Esc 直接离开', async () => {
    const { onClose } = renderPage();
    await screen.findByText('语言与文字');
    act(() => {
      closeTopOverlay();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('countFormChanges', () => {
  it('按顶层键计数，忽略即时生效键', () => {
    const base = makeCfg();
    expect(countFormChanges(base, base)).toBe(0);
    expect(countFormChanges({ ...base, themeId: 'light', locale: 'en' } as AppConfig, base)).toBe(0);
    expect(countFormChanges({ ...base, workspaceAccentDefault: { accent: '#abcdef', enabled: false }, workspaces: [] }, base)).toBe(0);
    expect(countFormChanges({ ...base, workspace: 'E:/other', activeWorkspaceId: 'other' }, base)).toBe(0);
    expect(countFormChanges({ ...base, mcp: { enabled: true, servers: [] }, mcpByWorkspace: { w1: [] } }, base)).toBe(0);
    expect(countFormChanges({ ...base, disabledAcpAgents: ['opencode'] }, base)).toBe(0);
    expect(countFormChanges({ ...base, claude: { isolateConfig: true }, cursor: { apiKey: 'already-saved' } }, base)).toBe(0);
    expect(countFormChanges({ ...base, shell: { manualGitBashPath: 'D:/Git/bin/bash.exe', bgShellMode: 'powershell' } }, base)).toBe(0);
    expect(countFormChanges({ ...base, tasksKeepAwake: false } as AppConfig, base)).toBe(1);
    expect(
      countFormChanges({ ...base, tasksKeepAwake: false, defaultRuntime: 'claude-code' } as AppConfig, base)
    ).toBe(2);
  });
});
