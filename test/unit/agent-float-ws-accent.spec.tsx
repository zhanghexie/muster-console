/**
 * 工作区强调色（框与页重设计）：
 * - 栈里每行带该工作区自己的 --ws-accent（主题色来源）；
 * - 跨工作区打开调度对话时，发送/停止取目标项目的配对色，阅读面和头像保持当前材质。
 * window.api 走 helpers/api-mock（AGENTS.md 测试规约）。
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { AgentFloat } from '../../src/renderer/src/panels/AgentFloat';
import { NEUTRAL_ACCENT, WORKSPACE_ACCENTS, workspaceAccent } from '../../src/shared/workspaceAccent';
import { currentApiMock } from './helpers/api-mock';
import type { WorkspaceInfo } from '../../src/shared/types';
import { builtinTheme } from '../../src/shared/theme';
import { resolveAppearance } from '../../src/shared/resolvedAppearance';
import { applyTheme, getTheme } from '../../src/renderer/src/theme';

vi.mock('../../src/renderer/src/avatarAccent', () => ({
  extractAvatarAccent: () => Promise.resolve('#7a6cff')
}));

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

function ws(id: string, name: string): WorkspaceInfo {
  return { id, path: `E:/demo/${id}`, name, openedAt: 1 };
}

const TWO = [ws('ws-a', 'Alpha'), ws('ws-b', 'Beta')];

function seedWorkspaces(): void {
  const mock = currentApiMock();
  mock.override('workspaces.list', () =>
    Promise.resolve({ workspaces: TWO, activeWorkspaceId: 'ws-a' })
  );
  mock.override('config.get', () =>
    Promise.resolve({ workspaces: TWO, activeWorkspaceId: 'ws-a', locale: 'zh-CN' })
  );
}

function realStack(): HTMLElement {
  return document.querySelector('.agent-ws-stack:not(.agent-ws-stack-ghost)') as HTMLElement;
}

describe('AgentFloat 工作区强调色', () => {
  it('栈行各自携带本工作区的 --ws-accent', async () => {
    seedWorkspaces();
    render(
      <StoreProvider>
        <AgentFloat stackInline />
      </StoreProvider>
    );
    await screen.findByTitle(/Beta/);
    const items = Array.from(realStack().querySelectorAll<HTMLElement>('.agent-ws-stack-item'));
    const accents = items.map((el) => el.style.getPropertyValue('--ws-accent'));
    expect(accents).toContain(workspaceAccent('ws-a'));
    expect(accents).toContain(workspaceAccent('ws-b'));
  });

  it('在 Alpha 里打开 Beta 的调度对话：动作色跟随 Beta', async () => {
    seedWorkspaces();
    render(
      <StoreProvider>
        <AgentFloat stackInline />
      </StoreProvider>
    );
    await screen.findByTitle(/Beta/);
    const betaItem = Array.from(realStack().querySelectorAll<HTMLElement>('.agent-ws-stack-item')).find(
      (el) => el.style.getPropertyValue('--ws-accent') === workspaceAccent('ws-b') && el.textContent?.includes('Beta')
    );
    expect(betaItem).toBeTruthy();
    fireEvent.click(betaItem!.querySelector('.agent-notify-chat') as HTMLElement);
    await waitFor(() => {
      expect(document.querySelector('.agent-float-panel')).toBeTruthy();
    });
    const panel = document.querySelector('.agent-float-panel') as HTMLElement;
    expect(panel.style.getPropertyValue('--ws-accent')).toBe(workspaceAccent('ws-b'));
    expect(panel.style.getPropertyValue('--action-bg')).toBe(workspaceAccent('ws-b'));
  });

  it('非活跃区动作使用目标项目的配对色，切明暗主题后更新；不改阅读面或头像', async () => {
    const custom = [
      { ...ws('ws-a', 'Alpha'), accent: '#628ac9' },
      { ...ws('ws-b', 'Beta'), accent: '#bc6b7f' }
    ];
    const mock = currentApiMock();
    mock.override('workspaces.list', () => Promise.resolve({ workspaces: custom, activeWorkspaceId: 'ws-a' }));
    mock.override('config.get', () => Promise.resolve({ workspaces: custom, activeWorkspaceId: 'ws-a', locale: 'zh-CN' }));
    const originalTheme = getTheme();
    const view = render(<StoreProvider><AgentFloat stackInline /></StoreProvider>);
    try {
      await screen.findByTitle(/Beta/);
      const beta = Array.from(realStack().querySelectorAll<HTMLElement>('.agent-ws-stack-item')).find(row => row.textContent?.includes('Beta'))!;
      fireEvent.click(beta.querySelector('.agent-notify-chat')!);
      await waitFor(() => expect(document.querySelector('.agent-float-panel')).toBeTruthy());
      const panel = document.querySelector('.agent-float-panel') as HTMLElement;
      for (const mode of ['dark', 'light'] as const) {
        act(() => applyTheme(builtinTheme(mode)!, { persist: false }));
        const expected = resolveAppearance(getTheme(), { workspaceId: 'ws-b', accent: '#bc6b7f', enabled: true });
        for (const role of ['bg', 'fg', 'hover', 'hover-fg', 'pressed', 'pressed-fg']) {
          expect(panel.style.getPropertyValue(`--action-${role}`)).toBe(expected.cssVars[`--action-${role}`]);
        }
        expect(panel.style.getPropertyValue('--action-bg')).not.toBe('#628ac9');
        expect(panel.style.getPropertyValue('--surface-canvas')).toBe('');
        expect(panel.style.getPropertyValue('--identity-surface')).toBe('');
      }
    } finally {
      view.unmount();
      act(() => applyTheme(originalTheme, { persist: false }));
    }
  });

  it('设置页改色后的推送实时更新栈与已打开的对话；跟随全局禁用变为中性灰', async () => {
    seedWorkspaces();
    render(
      <StoreProvider>
        <AgentFloat stackInline />
      </StoreProvider>
    );
    await screen.findByTitle(/Beta/);
    const betaRow = (): HTMLElement =>
      Array.from(realStack().querySelectorAll<HTMLElement>('.agent-ws-stack-item')).find((el) =>
        el.querySelector('.agent-float-avatar')?.getAttribute('title')?.startsWith('Beta')
      )!;
    const saved = workspaceAccent('ws-b');
    const pick = WORKSPACE_ACCENTS.find((c) => c !== saved)!;

    fireEvent.click(betaRow().querySelector('.agent-notify-chat') as HTMLElement);
    await waitFor(() => expect(document.querySelector('.agent-float-panel')).toBeTruthy());
    const panel = (): HTMLElement => document.querySelector('.agent-float-panel') as HTMLElement;
    const mock = currentApiMock();
    act(() => mock.emit('workspaces:changed', {
      workspaces: TWO.map(w => w.id === 'ws-b' ? { ...w, accent: pick } : w),
      activeWorkspaceId: 'ws-a'
    }));
    await waitFor(() => {
      expect(betaRow().style.getPropertyValue('--ws-accent')).toBe(pick);
      expect(panel().style.getPropertyValue('--ws-accent')).toBe(pick);
      const expected = resolveAppearance(getTheme(), { workspaceId: 'ws-b', accent: pick, enabled: true });
      for (const role of ['bg', 'fg', 'hover', 'hover-fg', 'pressed', 'pressed-fg']) {
        expect(panel().style.getPropertyValue(`--action-${role}`)).toBe(expected.cssVars[`--action-${role}`]);
      }
    });
    // 移除单区覆盖并关闭全局默认，已打开的 Beta 对话也应同步。
    act(() => mock.emit('workspaces:changed', {
      workspaces: TWO,
      activeWorkspaceId: 'ws-a',
      workspaceAccentDefault: { accent: pick, enabled: false }
    }));
    await waitFor(() => {
      expect(betaRow().style.getPropertyValue('--ws-accent')).toBe(NEUTRAL_ACCENT);
      expect(panel().style.getPropertyValue('--ws-accent')).toBe(NEUTRAL_ACCENT);
      const expected = resolveAppearance(getTheme(), { workspaceId: 'ws-b', accent: NEUTRAL_ACCENT, enabled: false });
      for (const role of ['bg', 'fg', 'hover', 'hover-fg', 'pressed', 'pressed-fg']) {
        expect(panel().style.getPropertyValue(`--action-${role}`)).toBe(expected.cssVars[`--action-${role}`]);
      }
    });
    expect(mock.mockOf('workspaces.update')).not.toHaveBeenCalled();
  });

  it('工作区设置里的主题色经 store 登记生效：手选色 / 关闭 → 中性灰', async () => {
    const custom = [
      { ...ws('ws-a', 'Alpha'), accent: '#123456' },
      { ...ws('ws-b', 'Beta'), accent: 'avatar', avatarAccent: '#abcdef', accentOff: true }
    ];
    const mock = currentApiMock();
    mock.override('workspaces.list', () => Promise.resolve({ workspaces: custom, activeWorkspaceId: 'ws-a' }));
    mock.override('config.get', () =>
      Promise.resolve({ workspaces: custom, activeWorkspaceId: 'ws-a', locale: 'zh-CN' })
    );
    render(
      <StoreProvider>
        <AgentFloat stackInline />
      </StoreProvider>
    );
    await screen.findByTitle(/Beta/);
    await waitFor(() => {
      const accents = Array.from(realStack().querySelectorAll<HTMLElement>('.agent-ws-stack-item')).map((el) =>
        el.style.getPropertyValue('--ws-accent')
      );
      expect(accents).toContain('#123456');
      expect(accents).toContain(NEUTRAL_ACCENT);
    });
  });
});
