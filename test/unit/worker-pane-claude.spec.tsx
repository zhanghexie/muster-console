import { renderWithAppTips as render } from './helpers/app-tips';
/** Claude chat configuration: explicit read-only fields, source-first ordering and real save behavior. */
import React, { useState } from 'react';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClaudeAccountSettings } from '../../src/renderer/src/components/settings/ClaudeAccountSettings';
import { WorkerPane } from '../../src/renderer/src/components/settings/WorkerPane';
import { currentApiMock } from './helpers/api-mock';
import type { AppConfig, AgentRuntimeEntry } from '../../src/shared/types';
import type { ClaudeGuiStatus } from '../../src/shared/claudeGui';

const CLAUDE_RT: AgentRuntimeEntry = {
  id: 'claude',
  label: 'Claude',
  script: '',
  builtin: true,
  enabled: true,
  surface: 'chat',
  updatedAt: 1
};

const STATUS: ClaudeGuiStatus = {
  packaged: false,
  executable: 'C:\\Users\\me\\.local\\bin\\claude.exe',
  canLaunch: true,
  isolateConfig: false,
  configDir: 'C:\\Users\\me\\.claude',
  auth: 'relay',
  model: 'deepseek-v4-flash[1m]'
};

function makeCfg(claude?: AppConfig['claude']): AppConfig {
  return {
    defaultRuntime: 'claude',
    workspace: 'E:/ws',
    workspaces: [],
    claude
  } as unknown as AppConfig;
}

function renderPane(initial?: AppConfig['claude']) {
  const Holder = (): React.JSX.Element => {
    const [cfg, setCfg] = useState(makeCfg(initial));
    const set = (patch: Partial<AppConfig>): void => {
      setCfg((prev) => ({ ...prev, ...patch }));
    };
    return <WorkerPane cfg={cfg} set={set} />;
  };
  render(<Holder />);
}

describe('Claude 工作台聊天配置', () => {
  beforeEach(() => {
    const api = currentApiMock();
    api.override('runtimes.availability', async () => ({ checkedAt: 1, runtimes: [CLAUDE_RT], acpAgents: [], runtimePreflights: { claude: { id: 'claude', status: 'available', ok: true, problems: [], checkedAt: 1 } } }));
    api.override('agentSession.getHarnessModelSelections', async () => ({}));
    api.override('runtimes.list', () => Promise.resolve([CLAUDE_RT]));
    api.override('agentSession.claudeStatus', () => Promise.resolve(STATUS));
  });

  async function expandClaude(): Promise<void> {
    await userEvent.click(await screen.findByRole('button', { name: '配置 Claude Code' }));
    await userEvent.click(screen.getByRole('tab', { name: '工作台聊天' }));
    await userEvent.click(await screen.findByRole('button', { name: '重新读取配置' }));
    await screen.findByDisplayValue('deepseek-v4-flash[1m]');
  }

  it('配置来源在结果之前，模型和目录明确只读，不显示没有操作出口的鉴权提示', async () => {
    renderPane();
    await expandClaude();
    expect(screen.queryByText(/鉴权未验证/)).toBeNull();
    const path = screen.getByRole('textbox', { name: '配置目录' }) as HTMLInputElement;
    const model = screen.getByRole('textbox', { name: '配置中的默认模型' }) as HTMLInputElement;
    expect(path.readOnly).toBe(true); expect(model.readOnly).toBe(true);
    expect(path.value).toBe(STATUS.configDir); expect(model.value).toBe(STATUS.model);
    const source = screen.getByRole('checkbox', { name: /使用独立配置目录/ });
    expect(source.compareDocumentPosition(path) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    currentApiMock().override('shell.revealPath', async () => ({ ok: true }));
    await userEvent.click(screen.getByRole('button', { name: '打开配置目录的位置' }));
    expect(currentApiMock().mockOf('shell.revealPath')).toHaveBeenCalledWith(STATUS.configDir);
    expect(screen.queryByRole('link', { name: '安装指南' })).toBeNull();
  });

  it('重新读取配置再次调用本机读取 IPC', async () => {
    renderPane();
    await expandClaude();
    const mock = currentApiMock().mockOf('agentSession.claudeStatus');
    const before = mock.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: '重新读取配置' }));
    await waitFor(() => expect(mock.mock.calls.length).toBeGreaterThan(before));
  });

  it('勾选独立配置目录即时写 config.claude.isolateConfig', async () => {
    renderPane();
    await expandClaude();
    const cb = screen.getByRole('checkbox', {
      name: '使用独立配置目录（不复用 ~/.claude；需在该目录重新登录或配中转）'
    }) as HTMLInputElement;
    expect(cb.checked).toBe(false);
    await userEvent.click(cb);
    await waitFor(() => {
      const calls = currentApiMock().mockOf('config.update').mock.calls;
      expect(calls.some((c) => c[0]?.claude?.isolateConfig === true)).toBe(true);
    });
  });
  it('保存独立目录失败时保持原设置并显示错误', async () => {
    currentApiMock().override('config.update', async () => { throw new Error('config write failed'); });
    renderPane();
    await expandClaude();
    const checkbox = screen.getByRole('checkbox', { name: /使用独立配置目录/ }) as HTMLInputElement;
    await userEvent.click(checkbox);
    await screen.findByText('config write failed');
    expect(checkbox.checked).toBe(false);
    expect(screen.queryByText('聊天配置已保存')).toBeNull();
  });

  it('切换目录后只展示新来源的配置，并从新路径打开文件管理器', async () => {
    let isolated = false;
    const api = currentApiMock();
    api.override('config.update', async patch => { isolated = !!patch.claude?.isolateConfig; return makeCfg(patch.claude); });
    api.override('agentSession.claudeStatus', async () => ({ ...STATUS, isolateConfig: isolated, configDir: isolated ? '/app/agents/claude-gui' : STATUS.configDir, model: isolated ? 'isolated-model' : STATUS.model }));
    api.override('shell.revealPath', async () => ({ ok: true }));
    renderPane(); await expandClaude();
    await userEvent.click(screen.getByRole('checkbox', { name: /使用独立配置目录/ }));
    await screen.findByDisplayValue('/app/agents/claude-gui');
    expect(screen.queryByDisplayValue(STATUS.configDir)).toBeNull();
    expect(screen.getByDisplayValue('isolated-model')).toBeTruthy();
    expect(screen.getByText('当前使用独立配置')).toBeTruthy();
    const saved = await screen.findByText('聊天配置已保存');
    expect(document.querySelector('[data-settings-item="worker-claude-gui"]')?.contains(saved)).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '打开配置目录的位置' }));
    expect(api.mockOf('shell.revealPath')).toHaveBeenCalledWith('/app/agents/claude-gui');
  });

  it('旧来源的迟到读取不能覆盖新目录', async () => {
    let finish!: (value: ClaudeGuiStatus) => void;
    const api = currentApiMock();
    api.override('agentSession.claudeStatus', () => new Promise(resolve => { finish = resolve; }));
    const view = render(<ClaudeAccountSettings isolated={false} busy={false} onChange={async () => {}}/>);
    api.override('agentSession.claudeStatus', async () => ({ ...STATUS, isolateConfig: true, configDir: '/new/config' }));
    view.rerender(<ClaudeAccountSettings isolated busy={false} onChange={async () => {}}/>);
    await screen.findByDisplayValue('/new/config');
    await act(async () => finish(STATUS));
    expect(screen.getByDisplayValue('/new/config')).toBeTruthy();
    expect(screen.queryByDisplayValue(STATUS.configDir)).toBeNull();
  });

});
