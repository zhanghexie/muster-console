/**
 * 会话查找浮条：开合、Ctrl+F 劫持、计数/导航、范围切换、正文高亮。
 */
import React, { useEffect, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChatFindBar } from '../../src/renderer/src/chatSurface/ChatFindBar';
import { applyChatFindMarks, clearChatFindMarks } from '../../src/renderer/src/chatSurface/chatFindHighlight';
import {
  patchChatFindShared,
  resolveChatFindTarget,
  registerChatFindTarget,
  resetChatFindSharedForTest
} from '../../src/renderer/src/chatSurface/chatFindRegistry';
import { resetPreferredFindSurfaceForTest } from '../../src/renderer/src/keybindings/findSurface';
import { KeybindingProvider, useKeybinding } from '../../src/renderer/src/keybindings/KeybindingHost';
import {
  pushOverlay,
  resetOverlayStackForTest
} from '../../src/renderer/src/keybindings/overlayStack';
import { MOTION } from '../../src/renderer/src/components/motion';

function FindBarHarness({
  groups,
  onJump,
  failedSessions,
  truncated,
  matchTotal
}: {
  groups?: Array<{
    sessionId: string;
    sessionName: string;
    hits: Array<{
      sessionId: string;
      sessionName: string;
      messageId: string;
      role: 'user' | 'assistant';
      start: number;
      end: number;
      indexInMessage: number;
      snippet: string;
    }>;
  }>;
  onJump?: (id: string) => void;
  failedSessions?: number;
  truncated?: boolean;
  matchTotal?: number;
}): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState('foo');
  const [scope, setScope] = useState<'current' | 'all'>('current');
  const [idx, setIdx] = useState(0);
  const total = matchTotal ?? (query.trim() ? 3 : 0);
  return (
    <ChatFindBar
      open={open}
      query={query}
      onQueryChange={setQuery}
      matchIndex={idx}
      matchTotal={total}
      onPrev={() => setIdx((i) => (i + total - 1) % total)}
      onNext={() => setIdx((i) => (i + 1) % total)}
      onClose={() => setOpen(false)}
      scope={scope}
      onToggleScope={() => setScope((s) => (s === 'all' ? 'current' : 'all'))}
      groups={groups}
      activeHit={groups?.[0]?.hits[idx]}
      onJumpHit={(h) => onJump?.(h.messageId)}
      failedSessions={failedSessions}
      truncated={truncated}
    />
  );
}

function CtrlFHarness(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const el = document.querySelector('.chat-surface-view');
    return registerChatFindTarget({
      id: 's1',
      kind: 'gui-session',
      enabled: true,
      sessionId: 's1',
      el: el instanceof HTMLElement ? el : document.body
    });
  }, []);
  useKeybinding('chat.find', () => {
    patchChatFindShared({ open: true, ownerId: 's1', focusEpoch: 1 });
    setOpen(true);
  });
  return (
    <div className="chat-surface-view">
      <input aria-label="composer" />
      <ChatFindBar
        open={open}
        query=""
        onQueryChange={() => undefined}
        matchIndex={0}
        matchTotal={0}
        onPrev={() => undefined}
        onNext={() => undefined}
        onClose={() => setOpen(false)}
        scope="current"
        onToggleScope={() => undefined}
      />
    </div>
  );
}

describe('ChatFindBar', () => {
  it('当前会话历史搜索失败时明确显示结果不完整', () => {
    render(<FindBarHarness failedSessions={1} />);
    expect(screen.getByRole('status').textContent).toContain('结果可能不完整');
  });
  beforeEach(() => {
    resetChatFindSharedForTest();
    resetPreferredFindSurfaceForTest();
    resetOverlayStackForTest();
  });

  it('分屏正文不获取键盘焦点时，快捷键跟随当前聚焦槽而非第一个注册会话', () => {
    const a = document.createElement('div'), b = document.createElement('div');
    document.body.append(a, b);
    const cleanA = registerChatFindTarget({ id: 'a', kind: 'gui-session', enabled: true, sessionId: 'a', el: a });
    const cleanB = registerChatFindTarget({ id: 'b', kind: 'gui-session', enabled: true, sessionId: 'b', el: b });
    try {
      fireEvent.pointerDown(b);
      expect(resolveChatFindTarget('b')?.id).toBe('b');
      expect(resolveChatFindTarget('a')?.id).toBe('a');
      // A stale input focus in the other split does not override the current pane.
      const input = document.createElement('input'); a.append(input); input.focus();
      expect(resolveChatFindTarget('b')?.id).toBe('b');
    } finally { cleanA(); cleanB(); a.remove(); b.remove(); }
  });

  it('Esc 在输入失焦、且下面已有 overlay 时仍关浮条（不关下层）', async () => {
    let underClosed = false;
    pushOverlay(() => {
      underClosed = true;
    });
    render(
      <KeybindingProvider>
        <>
          <button type="button">别处</button>
          <FindBarHarness />
        </>
      </KeybindingProvider>
    );
    expect(screen.getByRole('search', { name: '会话内查找' })).toBeTruthy();
    screen.getByRole('button', { name: '别处' }).focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(
      () => {
        expect(screen.queryByRole('search', { name: '会话内查找' })).toBeNull();
      },
      { timeout: MOTION.exitMs + 800 }
    );
    expect(underClosed).toBe(false);
  });

  it('IME 合成期 Esc 不关浮条', () => {
    render(
      <KeybindingProvider>
        <FindBarHarness />
      </KeybindingProvider>
    );
    fireEvent.keyDown(window, { key: 'Escape', isComposing: true });
    expect(screen.getByRole('search', { name: '会话内查找' })).toBeTruthy();
  });

  it('打开后显示 n/N，Enter/Shift+Enter 导航，点 × 关闭', async () => {
    const user = userEvent.setup();
    render(<FindBarHarness />);
    expect(screen.getByRole('search', { name: '会话内查找' })).toBeTruthy();
    expect(screen.getByText('1/3')).toBeTruthy();

    const input = screen.getByRole('searchbox', { name: '搜索当前会话' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('2/3')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(screen.getByText('1/3')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '关闭查找' }));
    await waitFor(
      () => {
        expect(screen.queryByRole('search', { name: '会话内查找' })).toBeNull();
      },
      { timeout: MOTION.exitMs + 800 }
    );
  });

  it('范围按钮在当前/全部之间切换，全部模式出分组列表', async () => {
    const user = userEvent.setup();
    const jumped: string[] = [];
    render(
      <FindBarHarness
        groups={[
          {
            sessionId: 's1',
            sessionName: '会话甲',
            hits: [
              {
                sessionId: 's1',
                sessionName: '会话甲',
                messageId: 'm1',
                role: 'user',
                start: 0,
                end: 3,
                indexInMessage: 0,
                snippet: 'foo bar'
              }
            ]
          }
        ]}
        onJump={(id) => jumped.push(id)}
      />
    );
    expect(screen.queryByRole('listbox', { name: '全部会话命中' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '范围：当前会话' }));
    expect(await screen.findByRole('listbox', { name: '全部会话命中' })).toBeTruthy();
    expect(screen.getByText('会话甲')).toBeTruthy();
    await user.click(screen.getByRole('option', { name: /foo bar/ }));
    expect(jumped).toEqual(['m1']);
  });

  it('全部会话有会话读取失败时列表尾部提示不完整，0 命中也不误报成无匹配', async () => {
    const user = userEvent.setup();
    render(<FindBarHarness groups={[]} matchTotal={0} failedSessions={2} />);
    await user.click(screen.getByRole('button', { name: '范围：当前会话' }));
    const list = await screen.findByRole('listbox', { name: '全部会话命中' });
    expect(list.textContent).toContain('无匹配的会话消息');
    expect(screen.getByText('2 个会话读取失败，结果可能不完整')).toBeTruthy();
  });

  it('命中触达上限时列表头部提示已截断（F-02），无截断标志不提示', async () => {
    const user = userEvent.setup();
    render(
      <FindBarHarness
        truncated
        matchTotal={2000}
        groups={[
          {
            sessionId: 's1',
            sessionName: '会话甲',
            hits: [
              {
                sessionId: 's1',
                sessionName: '会话甲',
                messageId: 'm1',
                role: 'user',
                start: 0,
                end: 3,
                indexInMessage: 0,
                snippet: 'foo bar'
              }
            ]
          }
        ]}
      />
    );
    await user.click(screen.getByRole('button', { name: '范围：当前会话' }));
    const list = await screen.findByRole('listbox', { name: '全部会话命中' });
    const note = list.querySelector('.chat-find-truncated');
    expect(note?.textContent).toContain('命中已达 2000 条上限');
    // 截断提示在列表头部（第一个分组之前）
    expect(list.firstElementChild).toBe(note);
  });

  it('Ctrl+F 在会话面 preventDefault 并打开；输入框聚焦时不劫持', async () => {
    render(
      <KeybindingProvider>
        <CtrlFHarness />
      </KeybindingProvider>
    );
    expect(screen.queryByRole('search', { name: '会话内查找' })).toBeNull();

    const composer = screen.getByRole('textbox', { name: 'composer' });
    composer.focus();
    fireEvent.keyDown(composer, { key: 'f', ctrlKey: true });
    expect(screen.queryByRole('search', { name: '会话内查找' })).toBeNull();

    fireEvent.keyDown(document.querySelector('.chat-surface-view')!, {
      key: 'f',
      ctrlKey: true
    });
    expect(await screen.findByRole('search', { name: '会话内查找' })).toBeTruthy();
  });

  it('在 .chat-text 里包 mark，活动命中带 is-active', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<div data-mid="m1"><div class="chat-text">hello Foo and foo</div></div>';
    const active = applyChatFindMarks(root, 'foo', { messageId: 'm1', indexInMessage: 1 });
    const marks = root.querySelectorAll('mark.chat-find-hit');
    expect(marks.length).toBe(2);
    expect(marks[1]?.classList.contains('is-active')).toBe(true);
    expect(active).toBe(marks[1]);
    clearChatFindMarks(root);
    expect(root.querySelectorAll('mark.chat-find-hit').length).toBe(0);
    expect(root.textContent).toBe('hello Foo and foo');
  });
});
