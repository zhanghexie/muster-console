/**
 * 设置 → Worker 终端：工作区管理区块已移除（2026-09-27 用户裁决——与顶栏
 * 「工作区」菜单 / 左下角头像重复，不该再占设置页）。
 * 契约：WorkerPane 不得再渲染「工作区管理」；命令面板不得再有 worker-workspaces 项。
 * 还原（把 details 区块加回）本用例应转红。
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { WorkerPane } from '../../src/renderer/src/components/settings/WorkerPane';
import { SETTINGS_ITEMS } from '../../src/shared/commandPalette';
import { currentApiMock } from './helpers/api-mock';
import type { AppConfig } from '../../src/shared/types';

const RT = {
  id: 'cursor',
  label: 'Cursor',
  script: '',
  builtin: true,
  enabled: true,
  surface: 'chat',
  updatedAt: 1
};

function makeCfg(): AppConfig {
  return {
    defaultRuntime: 'cursor',
    workspace: 'E:/ws',
    workspaces: [{ id: 'w1', name: 'WS', path: 'E:/ws' }]
  } as AppConfig;
}

describe('WorkerPane 不含工作区管理（与顶栏重复）', () => {
  beforeEach(() => {
    currentApiMock().override('runtimes.availability', async () => ({ checkedAt: 1, runtimes: [RT], acpAgents: [], runtimePreflights: { cursor: { status: 'available', ok: true, problems: [] } } }));
    currentApiMock().override('agentSession.getHarnessModelSelections', async () => ({}));
    currentApiMock().override('runtimes.list', () => Promise.resolve([RT]));
    currentApiMock().override('runtimes.preflight', () =>
      Promise.resolve({ ok: true, results: [] })
    );
    currentApiMock().override('shell.getInfo', () =>
      Promise.resolve({
        platform: 'win32',
        profiles: [],
        gitBashPath: null,
        manualGitBashPath: '',
        manualGitBashPathExists: false,
        bgShellMode: 'auto'
      })
    );
  });

  it('不渲染「工作区管理」小节', async () => {
    render(<WorkerPane cfg={makeCfg()} set={() => {}} />);
    expect(await screen.findByRole('heading', { name: 'Cursor' })).toBeTruthy();
    expect(screen.queryByText('工作区管理')).toBeNull();
    expect(screen.queryByText('打开工作区…')).toBeNull();
    expect(document.querySelector('[data-settings-item="worker-workspaces"]')).toBeNull();
  });

  it('命令面板设置项不再含 worker-workspaces', () => {
    expect(SETTINGS_ITEMS.some((i) => i.id === 'worker-workspaces')).toBe(false);
  });
});
