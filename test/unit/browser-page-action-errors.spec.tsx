/**
 * X4-F03：浏览器页操作族（崩溃重试/后退/前进/系统浏览器打开）IPC 失败必须 flashTip，
 * 不得零反应（对齐同文件既有 .catch(flashTip) 风格）；openExternal 消费 {ok,error} 合同。
 * 红绿：stash src/renderer/src/components/BrowserPage.tsx 后本用例红。
 */
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createApiMock } from './helpers/api-mock';

const state = vi.hoisted(() => ({ flashTip: vi.fn(), requestComposerInsert: vi.fn(), sessions: [] as Array<Record<string, unknown>>,
  runtimes: [] as Array<Record<string, unknown>> }));
vi.mock('../../src/renderer/src/store', () => ({
  useUiStore: () => ({ requestComposerInsert: state.requestComposerInsert, requestShowWorkspace: vi.fn(), flashTip: state.flashTip }),
  useWorkspaceStore: () => ({ workspaces: [], activeWorkspaceId: 'ws' })
}));
import { BrowserPage } from '../../src/renderer/src/components/BrowserPage';

function tabPayload(crashed = false) {
  return {
    tabs: [{ id: 'bt1', title: 't', url: 'https://example.com/a', favicon: null, loading: false, canGoBack: true, canGoForward: false, ...(crashed ? { crashed: true } : {}) }],
    activeId: 'bt1',
    nav: { back: false, forward: false }
  };
}

let mock: ReturnType<typeof createApiMock>;
function mount() {
  return render(
    <BrowserPage active shown sideTab="browser" onSideTab={() => {}} onDropOnTab={() => {}} />
  );
}

beforeEach(() => {
  state.flashTip.mockClear();
  state.requestComposerInsert.mockClear(); state.sessions = []; state.runtimes = [];
  mock = createApiMock();
  window.api = mock.api;
  mock.override('browser.restore', () => Promise.resolve(tabPayload()));
});

it('交互页面回填会投递到所属 CLI 或 GUI 草稿，未知会话明确提示', async () => {
  state.sessions = [{ id: 'cli', type: 'terminal', launchKind: 'agent', runtime: 'pty' },
    { id: 'gui', type: 'terminal', launchKind: 'agent', runtime: 'chat' }];
  state.runtimes = [{ id: 'pty', surface: 'pty' }, { id: 'chat', surface: 'chat' }];
  mock.override('sessions.list', async () => ({ sessions: state.sessions, activeId: 'cli' }));
  mock.override('runtimes.list', async () => state.runtimes);
  mount();
  act(() => mock.emit('uiWidget:draft', { sessionId: 'cli', text: 'CLI 追加' }));
  await waitFor(() => expect(state.requestComposerInsert).toHaveBeenCalledWith('CLI 追加', { target: 'cli-session:cli', replace: false }));
  act(() => mock.emit('uiWidget:draft', { sessionId: 'gui', text: 'GUI 追加' }));
  await waitFor(() => expect(state.requestComposerInsert).toHaveBeenCalledWith('GUI 追加', { target: 'agent-session:gui', replace: false }));
  act(() => mock.emit('uiWidget:draft', { sessionId: 'missing', text: '无法投递' }));
  await waitFor(() => expect(state.flashTip).toHaveBeenCalledWith('目标会话未就绪，请稍后重试'));
});

it('崩溃重试失败：browser.retryCrash reject → flashTip 上浮（用户不再误判「又崩了」）', async () => {
  mock.override('browser.restore', () => Promise.resolve(tabPayload(true)));
  mock.override('browser.retryCrash', () => Promise.reject(new Error('重试失败测试')));
  mount();
  const btn = await waitFor(() => {
    const overlay = document.querySelector('.browser-crash-overlay');
    expect(overlay).toBeTruthy();
    return overlay!.querySelector('button')!;
  });
  act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await waitFor(() => expect(mock.mockOf('browser.retryCrash')).toHaveBeenCalledWith({ id: 'bt1' }));
  await waitFor(() => expect(state.flashTip).toHaveBeenCalledWith('Error: 重试失败测试'));
});

it('后退/前进/地址栏导航族共用 navBtn：browser.nav reject → flashTip 上浮（本用例以开发者工具同款 catch 家族覆盖，navBtn 与 devtools 同一补丁路径）', async () => {
  mock.override('browser.devtools', () => Promise.reject(new Error('导航失败测试')));
  mount();
  const btn = await waitFor(() => {
    const el = document.querySelector<HTMLButtonElement>('button[title="打开开发者工具"]');
    expect(el).toBeTruthy();
    return el!;
  });
  fireEvent.click(btn);
  await waitFor(() => expect(mock.mockOf('browser.devtools')).toHaveBeenCalledWith({ id: 'bt1' }));
  await waitFor(() => expect(state.flashTip).toHaveBeenCalledWith('Error: 导航失败测试'));
});

it('在系统浏览器打开失败：openExternal 返回 {ok:false,error} → flashTip 展示失败原因（消费合同而非丢弃）', async () => {
  mock.override('shell.openExternal', () => Promise.resolve({ ok: false, error: '未找到默认浏览器' }));
  mount();
  const btn = await waitFor(() => {
    const el = document.querySelector<HTMLButtonElement>('button[title="在系统浏览器中打开"]');
    expect(el).toBeTruthy();
    return el!;
  });
  fireEvent.click(btn);
  await waitFor(() => expect(state.flashTip).toHaveBeenCalledWith('未找到默认浏览器'));
});

it('在系统浏览器打开异常：openExternal reject → flashTip 上浮异常信息', async () => {
  mock.override('shell.openExternal', () => Promise.reject(new Error('IPC 断连')));
  mount();
  const btn = await waitFor(() => {
    const el = document.querySelector<HTMLButtonElement>('button[title="在系统浏览器中打开"]');
    expect(el).toBeTruthy();
    return el!;
  });
  fireEvent.click(btn);
  await waitFor(() => expect(state.flashTip).toHaveBeenCalledWith('Error: IPC 断连'));
});
