/**
 * 中栏层级路径面包屑（子代理通用化 D2）。
 *
 * 子代理会话在中栏标题处显示「会话 父 › 子代理 子」——让用户一眼看出当前看的是
 * 谁的子会话，并能点回祖先。顶层会话不显示面包屑（保持既有单标题形态）。
 */
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { CenterPanel } from '../../src/renderer/src/panels/CenterPanel';
import {
  __resetCenterSplitForTest, attachCenterSplitBridge
} from '../../src/renderer/src/centerSplitStore';
import type { SessionMeta } from '../../src/shared/types';
import { currentApiMock } from './helpers/api-mock';
import { applyLocaleSetting } from '../../src/shared/i18n';

function Content({ sessionId }: { sessionId: string }): React.JSX.Element {
  return <div data-testid={`content-${sessionId}`}>正文 {sessionId}</div>;
}
vi.mock('../../src/renderer/src/components/TerminalView', () => ({
  TerminalView: (props: { sessionId: string }) => <Content sessionId={props.sessionId} />
}));
vi.mock('../../src/renderer/src/agentChat/AgentChatView', () => ({
  AgentChatView: (props: { sessionId: string; runtimeLabel?: string }) => <><Content sessionId={props.sessionId} /><span data-testid={`runtime-${props.sessionId}`}>{props.runtimeLabel}</span></>
}));

const WS = { id: 'ws-a', path: 'E:/demo', name: '演示', openedAt: 1 };

function sess(id: string, name: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    type: 'terminal',
    name,
    createdAt: 1,
    lastUsedAt: 1,
    launchKind: 'agent',
    runtime: 'pi',
    workspaceId: WS.id,
    status: 'running',
    lifecycle: 'idle',
    ...extra
  } as SessionMeta;
}

/** 顶层 A（带子 A1）、顶层 B */
const ROWS: SessionMeta[] = [
  sess('a', '顶层 A'),
  sess('a1', '子代理 A1', { parentSessionId: 'a' }),
  sess('b', '顶层 B')
];

let selectedId: string | null = null;
/** 主选中会话（各用例按需设置；sessions.list 的 mock 读它） */
let activeId = 'a';

function Harness(): React.JSX.Element {
  return (
    <StoreProvider>
      <CenterPanel utilityPanel={null} onCloseUtilityPanel={() => {}} onSelectUtilityPanel={() => {}} />
    </StoreProvider>
  );
}

beforeEach(() => {
  __resetCenterSplitForTest();
  selectedId = null;
  activeId = 'a';
  vi.stubGlobal('ResizeObserver', class {
    observe() {} unobserve() {} disconnect() {}
  });
  const api = currentApiMock();
  api.override('workspaces.list', () => Promise.resolve({ workspaces: [WS], activeWorkspaceId: WS.id }));
  api.override('config.get', () => Promise.resolve({ workspaces: [WS], activeWorkspaceId: WS.id, locale: 'zh-CN' }));
  api.override('sessions.list', () => Promise.resolve({ sessions: ROWS, activeId }));
  api.override('sessions.select', (id: string) => {
    selectedId = id;
    return Promise.resolve({ ok: true });
  });
  attachCenterSplitBridge({
    getPrimary: () => ({ kind: 'session', sessionId: 'a1' }),
    getUnderlyingPrimary: () => ({ kind: 'session', sessionId: 'a1' }),
    selectRef: () => {},
    getPrefs: () => ({ dir: 'row', ratio: 0.5 }),
    savePrefs: () => {}
  } as never);
});

function renderPanel(): void {
  render(<Harness />);
}

describe('中栏层级路径面包屑', () => {
  it('localizes the fallback historical Cursor label without changing the saved session', async () => {
    const saved = { ...ROWS[0], runtime: 'cursor' };
    currentApiMock().override('sessions.list', () => Promise.resolve({ sessions: [saved], activeId: saved.id }));
    renderPanel();
    expect((await screen.findByTestId('runtime-a')).textContent).toBe('Cursor（旧会话）');
    try {
      act(() => { applyLocaleSetting('en'); });
      expect(screen.getByTestId('runtime-a').textContent).toBe('Cursor (legacy session)');
      expect(saved.runtime).toBe('cursor');
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('retains a registered Cursor label even when it equals the historical fallback', async () => {
    const saved = { ...ROWS[0], runtime: 'cursor' };
    currentApiMock().override('sessions.list', () => Promise.resolve({ sessions: [saved], activeId: saved.id }));
    currentApiMock().override('runtimes.list', () => Promise.resolve([{ id: 'cursor', label: 'Cursor（旧会话）', surface: 'chat', enabled: true, script: '', updatedAt: 0 }]));
    renderPanel();
    await screen.findByTestId('runtime-a');
    await waitFor(() => expect(currentApiMock().mockOf('runtimes.list')).toHaveBeenCalled());
    try {
      act(() => { applyLocaleSetting('en'); });
      expect(screen.getByTestId('runtime-a').textContent).toBe('Cursor（旧会话）');
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it.each(['pi', 'codex'] as const)('%s 前台会话共用信封覆盖层，其他会话的邮件不展示', async runtime => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    currentApiMock().override('sessions.list', () => Promise.resolve({
      sessions: ROWS.map(row => ({ ...row, runtime })), activeId: 'a'
    }));
    renderPanel(); await screen.findByTestId('content-a');
    const mail = { id: 'foreground-letter', mailboxWorkspaceId: WS.id, from: 'b', to: 'a1',
      fromName: '乙', toName: '子代理', text: '协作进度', totalChars: 4, ts: 1 };
    act(() => currentApiMock().emit('messages:activity', mail));
    expect(document.querySelector('.mail-envelope-scene')).toBeNull();
    act(() => currentApiMock().emit('messages:activity', { ...mail, to: 'a' }));
    expect(document.querySelector('.mail-envelope-viewport')?.getAttribute('data-mailbox-id')).toBe('a');
    expect(document.querySelector('.mail-envelope-scene')?.getAttribute('data-direction')).toBe('receive');
  });
  it('历史未答邮件不再生成常驻卡片或用户答复输入框', async () => {
    currentApiMock().override('sessions.openAsks', () => Promise.resolve({ a1: [{
      id: 'old-ask', question: '测试指令，无需回信', from: 'a1', to: 'a', tag: 'question'
    }] }));
    activeId = 'a1'; renderPanel();
    await screen.findByTestId('content-a1');
    expect(currentApiMock().mockOf('sessions.openAsks')).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: '待答问题' })).toBeNull();
    expect(screen.queryByPlaceholderText('直接答复…')).toBeNull();
  });
  it('子代理会话显示祖先链与层级标签', async () => {
    // 主选中改为子代理
    activeId = 'a1';
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('content-a1')).toBeTruthy());

    const nav = document.querySelector('.center-pane-crumbs');
    expect(nav, '子代理会话应显示面包屑').toBeTruthy();
    const kinds = [...document.querySelectorAll('.center-pane-crumb-kind')].map(el => el.textContent);
    expect(kinds).toEqual(['会话', '子代理']);
    const names = [...document.querySelectorAll('.center-pane-crumb-name')].map(el => el.textContent);
    expect(names).toEqual(['顶层 A', '子代理 A1']);
  });

  it('祖先层级随语言切换，保留会话名称与导航', async () => {
    const rows = [...ROWS, sess('a2', '孙会话', { parentSessionId: 'a1' }), sess('a3', '深层会话', { parentSessionId: 'a2' })];
    activeId = 'a3';
    currentApiMock().override('sessions.list', () => Promise.resolve({ sessions: rows, activeId }));
    renderPanel(); await screen.findByTestId('content-a3');
    try {
      act(() => { applyLocaleSetting('en'); });
      expect([...document.querySelectorAll('.center-pane-crumb-kind')].map(el => el.textContent)).toEqual(['Session', 'Subagent', 'Grandchild agent', 'Subagent at level 4']);
      expect([...document.querySelectorAll('.center-pane-crumb-name')].map(el => el.textContent)).toEqual(['顶层 A', '子代理 A1', '孙会话', '深层会话']);
      expect(document.querySelectorAll('button.center-pane-crumb')).toHaveLength(3);
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });

  it('末级（当前会话）不可点，祖先可点回跳', async () => {
    activeId = 'a1';
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('content-a1')).toBeTruthy());

    const current = document.querySelector('.center-pane-crumb.is-current');
    expect(current).toBeTruthy();
    expect(current?.getAttribute('aria-current')).toBe('true');
    // 末级不是按钮（无回跳动作）
    expect(current?.tagName).toBe('SPAN');

    const ancestor = document.querySelector('button.center-pane-crumb');
    expect(ancestor).toBeTruthy();
    expect(ancestor?.textContent).toContain('顶层 A');
  });

  it('顶层会话不显示面包屑（保持单标题形态，不给所有会话加噪）', async () => {
    activeId = 'b';
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('content-b')).toBeTruthy());

    expect(document.querySelector('.center-pane-crumbs')).toBeNull();
    // 仍是原来的单标题
    expect(document.querySelector('.center-split-handle-name')?.textContent).toBe('顶层 B');
  });

  it('点祖先可回跳到该会话', async () => {
    activeId = 'a1';
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('content-a1')).toBeTruthy());

    const ancestor = document.querySelector('button.center-pane-crumb') as HTMLElement;
    expect(ancestor).toBeTruthy();
    await act(async () => {
      ancestor.click();
    });
    await waitFor(() => expect(selectedId).toBe('a'));
  });

  it('面包屑的分隔符渲染在两级之间', async () => {
    activeId = 'a1';
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('content-a1')).toBeTruthy());

    const seps = document.querySelectorAll('.center-pane-crumb-sep');
    expect(seps.length).toBe(1);
  });
});
