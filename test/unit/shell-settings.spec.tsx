import { renderWithAppTips as render } from './helpers/app-tips';
/**
 * 设置 → 通用 → Shell 区块（shell-env 三件套 C）：
 * - 挂载即拉 shell:getInfo，展示当前生效 Git Bash 路径；
 * - 未检测到时给「建议安装 Git for Windows」可见提示（B 的设置页面）；
 * - 手工路径保存即时写 AppConfig.shell.manualGitBashPath（config.update）；
 * - 手工路径不存在时提示回落；「清除手工路径」写空对象恢复自动探测。
 */
import React from 'react';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkerPane } from '../../src/renderer/src/components/settings/WorkerPane';
import { GeneralPane } from '../../src/renderer/src/components/settings/GeneralPane';
import { ShellSettings } from '../../src/renderer/src/components/settings/ShellSettings';
import { collectSettingsHits } from '../../src/shared/commandPalette';
import { currentApiMock } from './helpers/api-mock';
import type { AppConfig, ShellEnvInfo } from '../../src/shared/types';

const RT = {
  id: 'cursor',
  label: 'Cursor',
  script: '',
  builtin: true,
  enabled: true,
  surface: 'chat',
  updatedAt: 1
};

function makeInfo(patch: Partial<ShellEnvInfo> = {}): ShellEnvInfo {
  const profiles: ShellEnvInfo['profiles'] = patch.profiles ?? [
    { id: 'powershell', label: 'Windows PowerShell', command: 'C:\\Windows\\...\\powershell.exe', args: [] },
    { id: 'git-bash', label: 'Git Bash', command: 'D:\\Git\\bin\\bash.exe', args: [] }
  ];
  const preferredId = patch.bgShellMode === 'powershell' ? 'powershell' : 'git-bash';
  return {
    platform: 'win32',
    profiles,
    gitBashPath: 'D:\\Git\\bin\\bash.exe',
    manualGitBashPath: '',
    manualGitBashPathExists: false,
    bgShellMode: 'auto',
    bgShellProfile: profiles.find(profile => profile.id === preferredId) ?? profiles[0] ?? null,
    ...patch
  };
}

function makeCfg(): AppConfig {
  return {
    defaultRuntime: 'cursor',
    workspace: 'E:/ws',
    workspaces: []
  } as unknown as AppConfig;
}

function renderShellSettings() {
  render(<ShellSettings />);
}

describe('ShellSettings（通用 → Shell 区块）', () => {
  beforeEach(() => {
    currentApiMock().override('runtimes.list', () => Promise.resolve([RT]));
  });

  it.each([
    ['darwin', 'zsh', '/bin/zsh'],
    ['linux', 'bash', '/usr/bin/bash']
  ] as const)('在 %s 显示后台 Shell，隐藏 Windows 专用选项和旧配置', async (platform, id, command) => {
    const profile = { id, label: id, command, args: ['-l'] };
    const api = currentApiMock();
    api.override('shell.getInfo', async () => ({
      ...makeInfo({
        platform,
        profiles: [profile],
        gitBashPath: null,
        manualGitBashPath: 'D:\\Git\\bin\\bash.exe',
        bgShellMode: 'powershell'
      }),
      bgShellProfile: profile
    }));
    renderShellSettings();
    expect((await screen.findByRole('textbox', { name: '后台命令 Shell' }) as HTMLInputElement).value).toBe(command);
    expect(screen.getByText(id)).toBeTruthy();
    expect(screen.queryByText(/Git Bash|PowerShell/)).toBeNull();
    expect(screen.queryByRole('button', { name: '后台命令 Shell' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '打开后台命令 Shell的位置' }));
    expect(api.mockOf('shell.revealPath')).toHaveBeenCalledWith(command);
    expect(api.mockOf('config.update')).not.toHaveBeenCalled();
  });

  it('Linux 缺少可用 Shell 时提示安装 bash 或 zsh', async () => {
    currentApiMock().override('shell.getInfo', async () => ({
      ...makeInfo({ platform: 'linux', profiles: [], gitBashPath: null }),
      bgShellProfile: null
    }));
    renderShellSettings();
    expect(await screen.findByText(/安装 bash 或 zsh/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Git for Windows' })).toBeNull();
  });

  it('探测异常时显示错误并可重试', async () => {
    const api = currentApiMock();
    api.override('shell.getInfo', async () => makeInfo());
    api.mockOf('shell.getInfo').mockRejectedValueOnce(new Error('Shell IPC unavailable'));
    renderShellSettings();
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Shell IPC unavailable');
    expect(screen.queryByText('正在探测本机 Shell…')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByDisplayValue('D:\\Git\\bin\\bash.exe')).toBeTruthy();
  });

  it('挂载即拉 getInfo 并展示当前生效的 Git Bash 路径', async () => {
    currentApiMock().override('shell.getInfo', () =>
      Promise.resolve(makeInfo())
    );
    renderShellSettings();
    expect(await screen.findByDisplayValue('D:\\Git\\bin\\bash.exe')).toBeTruthy();
    expect(screen.queryByText(/未检测到 Git Bash/)).toBeNull();
  });

  it('打开已发现的 Git Bash，并保留手工路径的编辑与保存', async () => {
    const api = currentApiMock();
    api.override('shell.getInfo', () => Promise.resolve(makeInfo()));
    api.override('shell.revealPath', async () => ({ ok: true }));
    renderShellSettings();
    await userEvent.click(await screen.findByRole('button', { name: '打开Git Bash（当前生效）的位置' }));
    expect(api.mockOf('shell.revealPath')).toHaveBeenCalledWith('D:\\Git\\bin\\bash.exe');
    const input = screen.getByPlaceholderText('D:\\Git\\bin\\bash.exe');
    await userEvent.type(input, 'E:\\tools\\bash.exe');
    await userEvent.click(screen.getByRole('button', { name: '打开手工指定 Git Bash 路径（留空恢复自动探测）的位置' }));
    expect(api.mockOf('shell.revealPath')).toHaveBeenLastCalledWith('E:\\tools\\bash.exe');
  });

  it('未检测到 Git Bash 时给出安装建议与链接（无 bash 可见提示）', async () => {
    currentApiMock().override('shell.getInfo', () =>
      Promise.resolve(makeInfo({ gitBashPath: null, profiles: makeInfo().profiles.slice(0, 1) }))
    );
    renderShellSettings();
    expect(await screen.findByText('Windows PowerShell')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '后台命令 Shell' })).toHaveProperty('value', 'C:\\Windows\\...\\powershell.exe');
    expect(screen.getByText(/未检测到 Git Bash/)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Git for Windows' }) as HTMLAnchorElement;
    expect(link.href).toBe('https://git-scm.com/download/win');
  });

  it('保存手工路径即时写 config.update({ shell })', async () => {
    currentApiMock().override('shell.getInfo', () =>
      Promise.resolve(makeInfo({ manualGitBashPath: '' }))
    );
    renderShellSettings();
    const input = await screen.findByPlaceholderText('D:\\Git\\bin\\bash.exe');
    await userEvent.type(input, 'D:\\Git\\bin\\bash.exe');
    await userEvent.click(screen.getByRole('button', { name: '保存 Shell 设置' }));
    await waitFor(() => {
      const calls = currentApiMock().mockOf('config.update').mock.calls;
      expect(
        calls.some((c) => c[0]?.shell?.manualGitBashPath === 'D:\\Git\\bin\\bash.exe')
      ).toBe(true);
    });
  });

  it('清除手工路径只写档位不写路径（恢复自动探测，档位保留）', async () => {
    currentApiMock().override('shell.getInfo', () =>
      Promise.resolve(
        makeInfo({ manualGitBashPath: 'D:\\Git\\bin\\bash.exe', manualGitBashPathExists: true })
      )
    );
    renderShellSettings();
    const btn = await screen.findByRole('button', { name: '清除手工路径' });
    await userEvent.click(btn);
    await waitFor(() => {
      const calls = currentApiMock().mockOf('config.update').mock.calls;
      expect(
        calls.some(
          (c) => c[0]?.shell && !('manualGitBashPath' in c[0].shell) && c[0].shell.bgShellMode === 'auto'
        )
      ).toBe(true);
    });
  });

  it('Windows 切换到 PowerShell 时即时保存并刷新实际后台 Shell', async () => {
    // 模拟宿主：update 后 getInfo 回读新档位（验证保存后下拉不被重置）
    let mode: 'auto' | 'powershell' = 'auto';
    currentApiMock().override('shell.getInfo', () => Promise.resolve(makeInfo({ bgShellMode: mode })));
    currentApiMock().override('config.update', (patch) => {
      mode = (patch as { shell?: { bgShellMode?: 'auto' | 'powershell' } })?.shell?.bgShellMode ?? mode;
      return Promise.resolve({});
    });
    renderShellSettings();
    const trigger = await screen.findByRole('button', { name: '后台命令 Shell' });
    expect(trigger.textContent).toContain('自动（Git Bash 优先）');
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('option', { name: '强制 PowerShell' }));
    await waitFor(() => {
      const calls = currentApiMock().mockOf('config.update').mock.calls;
      expect(
        calls.some((c) => c[0]?.shell?.bgShellMode === 'powershell')
      ).toBe(true);
    });
    // 保存后 getInfo 回读新档位，下拉保持选中
    const kept = await screen.findByRole('button', { name: '后台命令 Shell' });
    expect(kept.textContent).toContain('强制 PowerShell');
    expect(await screen.findByRole('textbox', { name: '后台命令 Shell' })).toHaveProperty('value', 'C:\\Windows\\...\\powershell.exe');
    expect(screen.getByRole('textbox', { name: 'Git Bash（当前生效）' })).toHaveProperty('value', 'D:\\Git\\bin\\bash.exe');
  });

  it('保存手工路径时整对象写 shell，当前档位不被互踩', async () => {
    currentApiMock().override('shell.getInfo', () =>
      Promise.resolve(makeInfo({ bgShellMode: 'powershell' }))
    );
    renderShellSettings();
    const input = await screen.findByPlaceholderText('D:\\Git\\bin\\bash.exe');
    await userEvent.type(input, 'D:\\Git\\bin\\bash.exe');
    await userEvent.click(screen.getByRole('button', { name: '保存 Shell 设置' }));
    await waitFor(() => {
      const calls = currentApiMock().mockOf('config.update').mock.calls;
      expect(
        calls.some(
          (c) =>
            c[0]?.shell?.manualGitBashPath === 'D:\\Git\\bin\\bash.exe' &&
            c[0]?.shell?.bgShellMode === 'powershell'
        )
      ).toBe(true);
    });
  });

  it('手工路径不存在时展示回落提示', async () => {
    currentApiMock().override('shell.getInfo', () =>
      Promise.resolve(
        makeInfo({ manualGitBashPath: 'E:\\gone\\bash.exe', manualGitBashPathExists: false })
      )
    );
    renderShellSettings();
    expect(
      await screen.findByText(/手工路径不存在（已卸载或改名？）/)
    ).toBeTruthy();
  });
});

describe('Shell 设置入口', () => {
  it('设置搜索把命令行环境和 Git Bash 路径导向通用', () => {
    expect(collectSettingsHits('命令行环境').find(hit => hit.id === 'general-shell')?.tab).toBe('general');
    expect(collectSettingsHits('手动指定 Git Bash').find(hit => hit.id === 'general-shell')?.tab).toBe('general');
  });

  it('只在通用页展示并保留本机探测，Agent 页不提供终端环境入口', async () => {
    currentApiMock().override('shell.getInfo', () => Promise.resolve(makeInfo()));
    const view = render(<GeneralPane cfg={makeCfg()} set={() => {}} />);
    const section = await screen.findByRole('heading', { name: '命令行环境' });
    expect(section.closest('[data-settings-item]')?.getAttribute('data-settings-item')).toBe('general-shell');
    expect((await screen.findByRole('textbox', { name: 'Git Bash（当前生效）' }) as HTMLInputElement).value).toBe('D:\\Git\\bin\\bash.exe');
    view.unmount();
    render(<WorkerPane cfg={makeCfg()} set={() => {}} />);
    expect(screen.queryByRole('button', { name: '终端环境' })).toBeNull();
    expect(screen.queryByRole('heading', { name: '命令行环境' })).toBeNull();
    await act(async () => {});
  });
});
