import React, { forwardRef, useImperativeHandle } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceInfo } from '../../src/shared/types';

const state = vi.hoisted(() => ({ activeWorkspaceId: 'a', workspaces: [] as WorkspaceInfo[],
  request: null as null | { path: string; nonce: number }, openPath: vi.fn(), clear: vi.fn(), tip: vi.fn(), patch: vi.fn(async (partial: unknown) => partial) }));
vi.mock('../../src/renderer/src/store', () => ({
  useSessionStore: () => ({ activeId: 'session-a' }),
  useRuntimesStore: () => ({ runtimes: [] }),
  useWorkspaceStore: () => ({ activeWorkspaceId: state.activeWorkspaceId, workspaces: state.workspaces }),
  useUiStore: () => ({ openWorkspaceFile: state.request, clearOpenWorkspaceFile: state.clear,
    // 与生产 useCallback 一致保持引用稳定，否则保存失败的 setState 会让依赖 flashTip 的保存 effect 无限重跑
    flashTip: state.tip, requestOpenWorkspaceFile: vi.fn() })
}));
vi.mock('../../src/renderer/src/hooks/useWorkspaceFile', () => ({ useWorkspaceFile: () => ({ cfg: {}, ready: true, workspaceId: state.activeWorkspaceId, patch: state.patch }) }));
vi.mock('../../src/renderer/src/keybindings/KeybindingHost', () => ({ useKeybinding: () => {}, useChordLabel: () => '', useOverlayDismiss: () => {} }));
vi.mock('../../src/renderer/src/panelHistory', () => ({ useHistoryWsId: () => state.activeWorkspaceId, usePanelHistory: () => ({
  pushRight: vi.fn(), backRight: vi.fn(), forwardRight: vi.fn(), rightBackDepth: () => 0, rightForwardDepth: () => 0
}) }));
vi.mock('../../src/renderer/src/panels/FilesPanel', () => ({ FilesPanel: forwardRef((_props, ref) => {
  useImperativeHandle(ref, () => ({ openPath: state.openPath })); return <div>文件内容</div>;
}) }));
vi.mock('../../src/renderer/src/panels/GitPanel', () => ({ GitPanel: forwardRef(() => <div />) }));
vi.mock('../../src/renderer/src/components/BrowserPage', () => ({ BrowserPage: () => <div data-testid="browser-owner"><webview data-tab-id="global" /></div> }));
import { SideToolsPanel } from '../../src/renderer/src/panels/SideToolsPanel';

describe('跨面板打开的工作区来源', () => {
  it('浏览器冷启动常驻，切工作区保留 DOM guest；文件草稿和浏览器 DOM 均保活', async () => {
    state.workspaces = ['a', 'b'].map(id => ({ id, name: id, path: `E:/${id}`, openedAt: 0 }));
    state.activeWorkspaceId = 'a'; state.request = null;
    const view = render(<SideToolsPanel active={false} gitEverActive={false} pageVisible={false} />);
    await waitFor(() => expect(view.container.querySelector('webview')).toBeTruthy());
    const guest = view.container.querySelector('webview');
    view.rerender(<SideToolsPanel active gitEverActive pageVisible />);
    await waitFor(() => expect(view.container.textContent).toContain('文件内容'));
    const file = [...view.container.querySelectorAll('div')].find(el => el.textContent === '文件内容' && !el.firstElementChild);
    state.activeWorkspaceId = 'b';
    view.rerender(<SideToolsPanel active gitEverActive pageVisible={false} />);
    await waitFor(() => expect(file?.isConnected).toBe(true));
    expect(view.container.querySelector('webview')).toBe(guest);
    state.activeWorkspaceId = 'a';
    view.rerender(<SideToolsPanel active gitEverActive pageVisible />);
    expect(view.container.querySelector('webview')).toBe(guest);
  });
  it('懒挂载等待期间切区，旧相对路径不交给新工作区', async () => {
    state.workspaces = ['a', 'b'].map(id => ({ id, name: id, path: `E:/${id}`, openedAt: 0 }));
    state.activeWorkspaceId = 'a'; state.request = { path: 'src/index.ts', nonce: 1 };
    state.openPath.mockClear(); state.clear.mockClear();
    const view = render(<SideToolsPanel active gitEverActive={false} pageVisible />);
    expect(state.clear).toHaveBeenCalled();
    state.activeWorkspaceId = 'b'; state.request = null;
    // Hook mock 不具备真实 Context 的订阅，变更 prop 让 memo 宿主也渲染切区。
    view.rerender(<SideToolsPanel active gitEverActive={false} pageVisible={false} />);
    state.activeWorkspaceId = 'a';
    view.rerender(<SideToolsPanel active gitEverActive pageVisible />);
    await waitFor(() => expect(view.container.textContent).toContain('文件内容'));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
    expect(state.openPath).not.toHaveBeenCalled();
  });
});
