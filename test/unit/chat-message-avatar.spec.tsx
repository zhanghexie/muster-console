import { renderWithAppTips as render } from './helpers/app-tips';
/**
 * 会话消息头像：各发送者渲染、设置切换实时生效、连续同发送者省略。
 * 运行: npx vitest run test/unit/chat-message-avatar.spec.tsx
 */
import React from 'react';
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import { ChatTranscript } from '../../src/renderer/src/chatSurface/ChatTranscript';
import { UserAvatarSettings } from '../../src/renderer/src/components/settings/UserAvatarSettings';
import { TooltipHost } from '../../src/renderer/src/components/Tooltip';
import { toDisplayMessage } from '../../src/renderer/src/chatSurface/guiMessageView';
import type { ChatMessage } from '../../src/shared/types';
import type { GuiChatMessage } from '../../src/shared/guiWorker';
import type { TranscriptModelBinding } from '../../src/renderer/src/chatSurface/ChatTranscript';
import type { ChatAvatarContext } from '../../src/shared/userAvatar';
import { resetUserAvatarForTest, getUserAvatar, setUserAvatar } from '../../src/renderer/src/userAvatar';
import { currentApiMock } from './helpers/api-mock';
import { SUBAGENT_CHARACTERS } from '../../src/shared/subagentCharacters';
import { createGuiUserMessage } from '../../src/shared/guiWorker';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
);

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: 'hello',
    createdAt: 1_000,
    ...partial
  };
}

const model: TranscriptModelBinding<ChatMessage> = { toDisplay: (m) => m };

const dispatchCtx: ChatAvatarContext = {
  surfaceKind: 'dispatch',
  workspaceAvatar: '🚀',
  workspaceName: '工作区'
};

const workerCtx: ChatAvatarContext = {
  surfaceKind: 'gui-session',
  runtimeId: 'cursor',
  runtimeLabel: 'Cursor',
  sessionName: '改布局'
};

describe('各类型头像渲染', () => {
  it('邮箱提醒经过 GUI 历史映射仍为宿主身份，正文用普通字号且无用户头像', () => {
    const stored = JSON.parse(JSON.stringify(createGuiUserMessage({ id: 'mail-wake', ts: 1,
      host: true, text: '【宿主收信提醒】邮箱收到 12 封新信。请主动收信。' })));
    const display = toDisplayMessage(stored);
    expect(display.host).toBe(true);
    const { container } = render(<ChatMessageView message={display} avatarContext={workerCtx} />);
    expect(container.querySelector('.chat-msg')?.classList.contains('is-host')).toBe(true);
    expect(container.querySelector('.chat-msg-avatar')?.getAttribute('data-avatar-sender')).toBe('host');
    expect(container.querySelector('.chat-msg')?.classList.contains('user')).toBe(false);
    expect(container.querySelectorAll('h1,h2,h3,h4,h5,h6')).toHaveLength(0);
    expect(container.textContent).toContain('宿主');
  });
  it('普通跨会话留言及异常包装不能把整段正文渲染成 Setext 标题', () => {
    const identity = { fromSessionId: 'child', fromSessionName: '像素 · 验证', text: '最小验证完成：17×23=391。' };
    // Historical wrappers are read-only fixtures; current mail never injects these bodies.
    const bodies = ['【Worker 跨会话留言】', '【审计副本】sessions.message 未送达', '【投递异常】sessions.message 直投失败']
      .map(title => title + '\n来自会话 像素 · 验证（child）。\n\n' + identity.text + '\n');
    for (const content of bodies) {
      const view = render(<ChatMessageView message={msg({ role: 'user', source: 'agent', content,
        sourceAgent: { sessionId: 'child', name: '像素 · 验证', characterId: 'pixel' } })}/>);
      expect(view.container.querySelectorAll('h1,h2,h3,h4,h5,h6')).toHaveLength(0);
      expect(view.container.querySelector('.chat-text')?.textContent).toContain(identity.text);
      expect(view.container.querySelector('.chat-msg-avatar')?.getAttribute('data-avatar-sender')).toBe('agent');
      view.unmount();
    }
  });
  beforeEach(() => {
    resetUserAvatarForTest({ kind: 'emoji', value: '🦊' });
  });

  it('子代理汇报：不借用用户头像，普通正文没有 Setext 大标题', () => {
    const content = '137*29=3973。已经汇报。';
    const display = toDisplayMessage({ id: 'child', role: 'user', source: 'agent', parts: [{ kind: 'text', text: content }], ts: 1 });
    expect(display.source).toBe('agent');
    const { container } = render(<ChatMessageView message={display} avatarContext={workerCtx} />);
    expect(container.querySelector('.chat-msg-avatar')?.getAttribute('data-avatar-sender')).toBe('agent');
    expect(container.querySelector('.chat-msg')?.classList.contains('is-left-aligned')).toBe(true);
    expect(container.querySelector('.chat-msg-avatar')?.getAttribute('data-avatar-face')).toBe('image');
    expect(container.querySelector('.chat-msg-avatar-img')?.getAttribute('src')).toContain('rivet.webp');
    expect(container.querySelector('.chat-msg')?.classList.contains('user')).toBe(false);
    expect(container.querySelector('h1,h2,h3')).toBeNull();
  });

  it.each(SUBAGENT_CHARACTERS)('角色 $name 的主动汇报、排队历史映射使用固定内置头像', character => {
    const sourceAgent = { sessionId: `child-${character.id}`, name: `${character.name} · 验证任务`, characterId: character.id };
    const stored = JSON.parse(JSON.stringify(createGuiUserMessage({ id: character.id, text: '已完成本轮检查', ts: 1,
      source: 'agent', sourceAgent, queued: true })));
    const display = toDisplayMessage(stored);
    const { container, rerender } = render(<ChatMessageView message={display} avatarContext={dispatchCtx} />);
    const avatar = container.querySelector('.chat-msg-avatar');
    expect(avatar?.getAttribute('data-avatar-sender')).toBe('agent');
    expect(avatar?.getAttribute('title')).toBe(`${sourceAgent.name}（${character.role}）`);
    expect(avatar?.querySelector('img')?.getAttribute('src')).toContain(`${character.id}.webp`);
    expect(avatar?.textContent).not.toContain('🦊'); expect(avatar?.textContent).not.toContain('🚀');
    rerender(<ChatMessageView message={display} avatarContext={{ ...dispatchCtx, sessionName: '父会话已经改名' }} />);
    expect(avatar?.querySelector('img')?.getAttribute('src')).toContain(`${character.id}.webp`);
  });

  it('用户 → 圆形 emoji', () => {
    const { container } = render(<ChatMessageView message={msg({ role: 'user', content: '我' })} />);
    const av = container.querySelector('.chat-msg-avatar');
    expect(av?.getAttribute('data-avatar-sender')).toBe('user');
    expect(av?.getAttribute('data-avatar-face')).toBe('text');
    expect(av?.classList.contains('is-circle')).toBe(true);
    expect(av?.textContent).toBe('🦊');
    expect(container.querySelector('.chat-msg')?.classList.contains('is-right-aligned')).toBe(true);
  });

  it('宿主 → 方印「宿主」', () => {
    const { container } = render(
      <ChatMessageView message={msg({ role: 'user', host: true, content: '【编排】' })} />
    );
    const av = container.querySelector('.chat-msg-avatar');
    expect(av?.getAttribute('data-avatar-sender')).toBe('host');
    expect(av?.classList.contains('is-squircle')).toBe(true);
    expect(screen.getByText('宿主')).toBeTruthy();
    expect(container.querySelector('.chat-msg')?.classList.contains('is-host')).toBe(true);
    expect(container.querySelector('.chat-msg')?.classList.contains('is-left-aligned')).toBe(true);
    expect(container.querySelector('.chat-msg')?.classList.contains('user')).toBe(false);
  });

  it.each([
    ['用户', {}],
    ['宿主', { host: true }],
    ['调度注入', { source: 'scheduler' as const }]
  ])('%s 的时间仅放在气泡下方的共用悬浮栏', (_sender, identity) => {
    const { container } = render(
      <ChatMessageView
        message={msg({ role: 'user', content: '通知', ...identity })}
        timeLabel="19:05"
        quiet
      />
    );
    expect(container.querySelector('.chat-host-tag')).toBeNull();
    expect(container.querySelector('.chat-role')).toBeNull();
    expect(container.querySelectorAll('.chat-time')).toHaveLength(1);
    expect(container.querySelector('.chat-hoverbar .chat-time')?.textContent).toBe('19:05');
    expect(container.querySelector('.chat-msg')?.classList.contains('chat-quiet')).toBe(true);
    expect(container.querySelector('.chat-msg-avatar')).not.toBeNull();
  });

  it('非简洁布局的宿主时间仍使用顶部时间位，不重复渲染悬浮栏', () => {
    const { container } = render(
      <ChatMessageView
        message={msg({ role: 'user', host: true, content: '通知' })}
        timeLabel="19:05"
      />
    );
    expect(container.querySelector('.chat-host-tag .chat-time')?.textContent).toBe('19:05');
    expect(container.querySelectorAll('.chat-time')).toHaveLength(1);
    expect(container.querySelector('.chat-hoverbar')).toBeNull();
  });

  it('调度面板里的 AI 回复不挂头像或占位', () => {
    const { container } = render(
      <ChatMessageView
        message={msg({ role: 'assistant', content: '调度回复' })}
        avatarContext={dispatchCtx}
      />
    );
    const av = container.querySelector('.chat-msg-avatar');
    expect(av).toBeNull();
    expect(container.querySelector('.chat-msg')?.classList.contains('is-avatarless')).toBe(true);
    expect(container.querySelector('.chat-msg')?.children.length).toBe(1);
  });

  it('Worker 会话里调度注入 → 工作区图标 +「调度 Agent」，不是用户黄脸', () => {
    const { container } = render(
      <ChatMessageView
        message={msg({
          role: 'user',
          source: 'scheduler',
          content: '【调度回注 Worker】\n已办'
        })}
        avatarContext={{
          surfaceKind: 'gui-session',
          workspaceAvatar: '🚀',
          workspaceName: '工作区',
          runtimeId: 'cursor',
          sessionName: '改布局'
        }}
      />
    );
    const root = container.querySelector('.chat-msg');
    const av = container.querySelector('.chat-msg-avatar');
    expect(av?.getAttribute('data-avatar-sender')).toBe('scheduler');
    expect(av?.textContent).toBe('🚀');
    expect(av?.getAttribute('title')).toBe('调度 Agent');
    expect(root?.classList.contains('user')).toBe(false);
    expect(root?.classList.contains('is-host')).toBe(false);
    expect(root?.classList.contains('is-left-aligned')).toBe(true);
    expect(screen.getByText('调度 Agent')).toBeTruthy();
  });

  it('用户手打仍是用户头像，不受注入身份影响', () => {
    const { container } = render(
      <ChatMessageView
        message={msg({ role: 'user', content: '我自己打的' })}
        avatarContext={workerCtx}
      />
    );
    const root = container.querySelector('.chat-msg');
    const av = container.querySelector('.chat-msg-avatar');
    expect(av?.getAttribute('data-avatar-sender')).toBe('user');
    expect(av?.textContent).toBe('🦊');
    expect(root?.classList.contains('user')).toBe(true);
    expect(root?.classList.contains('is-host')).toBe(false);
  });

  it('host 通栏不被 scheduler source 抢走', () => {
    const { container } = render(
      <ChatMessageView
        message={msg({
          role: 'user',
          host: true,
          source: 'scheduler',
          content: '【编排】'
        })}
      />
    );
    const root = container.querySelector('.chat-msg');
    expect(container.querySelector('.chat-msg-avatar')?.getAttribute('data-avatar-sender')).toBe(
      'host'
    );
    expect(root?.classList.contains('is-host')).toBe(true);
    expect(root?.classList.contains('user')).toBe(false);
  });

  it('Worker 的 AI 回复不挂头像，正文列独占消息宽度', () => {
    const { container } = render(
      <ChatMessageView
        message={msg({ role: 'assistant', content: '工人回复' })}
        avatarContext={workerCtx}
      />
    );
    const av = container.querySelector('.chat-msg-avatar');
    expect(av).toBeNull();
    expect(container.querySelector('.chat-msg')?.classList.contains('is-avatarless')).toBe(true);
    expect(container.querySelector('.chat-msg')?.children.length).toBe(1);
    expect(screen.getByText('工人回复')).toBeTruthy();
  });

  it('各类型 title 为完整发送者名', () => {
    resetUserAvatarForTest({ kind: 'emoji', value: '🦊', displayName: '小明' });
    const host = render(
      <ChatMessageView message={msg({ role: 'user', host: true, content: 'h' })} />
    );
    expect(host.container.querySelector('.chat-msg-avatar')?.getAttribute('title')).toBe('宿主');
    host.unmount();

    const user = render(<ChatMessageView message={msg({ role: 'user', content: 'u' })} />);
    expect(user.container.querySelector('.chat-msg-avatar')?.getAttribute('title')).toBe('小明');
    user.unmount();

    const sched = render(
      <ChatMessageView
        message={msg({ role: 'user', source: 'scheduler', content: 's' })}
        avatarContext={dispatchCtx}
      />
    );
    expect(sched.container.querySelector('.chat-msg-avatar')?.getAttribute('title')).toBe(
      '调度 Agent'
    );
    sched.unmount();
  });
});

describe('设置切换实时生效', () => {
  beforeEach(() => {
    resetUserAvatarForTest({ kind: 'emoji', value: '🙂' });
  });

  it('外观页点选符号立即改已挂载用户气泡头像并 config.update', async () => {
    const user = await import('@testing-library/user-event').then((m) => m.default);
    const { container } = render(
      <>
        <UserAvatarSettings />
        <ChatMessageView message={msg({ id: 'u', role: 'user', content: 'hi' })} />
      </>
    );
    expect(container.querySelector('[data-avatar-sender="user"]')?.textContent).toBe('🙂');

    await user.click(screen.getByRole('option', { name: '星探（探索者）' }));

    expect(container.querySelector('[data-avatar-sender="user"] img')?.getAttribute('src')).toContain('/scout.webp');
    expect(currentApiMock().mockOf('config.update')).toHaveBeenCalledWith({
      userAvatar: { kind: 'builtin', value: 'scout' }
    });
  });

  it('改显示名：击键只写草稿，失焦才提交（不每击键 config.update）', async () => {
    const user = await import('@testing-library/user-event').then((m) => m.default);
    const { container } = render(
      <>
        <UserAvatarSettings />
        <ChatMessageView message={msg({ id: 'u', role: 'user', content: 'hi' })} />
      </>
    );
    const input = screen.getByPlaceholderText('悬浮头像时显示，缺省为「我」');
    await user.clear(input);
    await user.type(input, '小明');
    // 输入中：草稿只在输入框里，头像与落盘都不动（主进程落盘是同步整份 config.json）
    expect((input as HTMLInputElement).value).toBe('小明');
    expect(container.querySelector('[data-avatar-sender="user"]')?.getAttribute('title')).toBe(
      '我'
    );
    expect(currentApiMock().mockOf('config.update')).not.toHaveBeenCalled();

    await user.tab(); // 失焦提交
    expect(container.querySelector('[data-avatar-sender="user"]')?.getAttribute('title')).toBe(
      '小明'
    );
    expect(currentApiMock().mockOf('config.update')).toHaveBeenCalledWith({
      userAvatar: { kind: 'emoji', value: '🙂', displayName: '小明' }
    });
  });

  it('显示名无变化时失焦不触发 config.update', async () => {
    const user = await import('@testing-library/user-event').then((m) => m.default);
    render(<UserAvatarSettings />);
    const input = screen.getByPlaceholderText('悬浮头像时显示，缺省为「我」');
    await user.type(input, '小明');
    await user.tab();
    expect(currentApiMock().mockOf('config.update')).toHaveBeenCalledTimes(1);
  });
});

describe('头像上传预检与落盘失败回滚', () => {
  beforeEach(() => {
    resetUserAvatarForTest({ kind: 'emoji', value: '🙂' });
  });

  it('超大图片入口即拒，不解码不落盘', async () => {
    const { container } = render(<UserAvatarSettings />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const big = new File(['x'], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });

    fireEvent.change(fileInput, { target: { files: [big] } });

    expect(screen.getByText('图片太大，请选择小于 20MB 的图片')).toBeTruthy();
    expect(currentApiMock().mockOf('config.update')).not.toHaveBeenCalled();
  });

  it('落盘失败回滚本地头像，避免重启后跳回旧值', async () => {
    currentApiMock().override('config.update', () => Promise.reject(new Error('disk-full')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    setUserAvatar({ kind: 'emoji', value: '😺' });
    expect(getUserAvatar().value).toBe('😺'); // 本地先立即生效

    await act(async () => {}); // flush 落盘 promise
    expect(getUserAvatar().value).toBe('🙂'); // 失败回滚
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('config.update 返回归一 config 时用返回值校正本地态', async () => {
    currentApiMock().override('config.update', () =>
      Promise.resolve({ userAvatar: { kind: 'emoji', value: '👽' } })
    );

    setUserAvatar({ kind: 'emoji', value: '😺' });
    expect(getUserAvatar().value).toBe('😺');

    await act(async () => {});
    expect(getUserAvatar().value).toBe('👽'); // 以主进程归一结果为准
  });
});

describe('头像悬浮名字气泡', () => {
  beforeEach(() => {
    resetUserAvatarForTest({ kind: 'emoji', value: '🙂' });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('悬停 350ms 后出现 mp-pop 气泡，文案为发送者名', () => {
    const { container } = render(
      <>
        <TooltipHost />
        <ChatMessageView message={msg({ role: 'user', host: true, content: '【编排】' })} />
      </>
    );
    const av = container.querySelector('.chat-msg-avatar')!;
    fireEvent.mouseOver(av);
    expect(document.querySelector('.app-tooltip')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(350);
    });
    const tip = document.querySelector('.app-tooltip');
    expect(tip?.classList.contains('mp-pop')).toBe(true);
    expect(tip?.textContent).toBe('宿主');
  });
});

describe('连续消息头像省略', () => {
  beforeEach(() => {
    resetUserAvatarForTest({ kind: 'emoji', value: '🙂' });
  });

  it('连续用户消息第二条省略头像；换发送者恢复', () => {
    const t0 = 10_000;
    const messages: ChatMessage[] = [
      msg({ id: 'u1', role: 'user', content: '一', createdAt: t0 }),
      msg({ id: 'u2', role: 'user', content: '二', createdAt: t0 + 1_000 }),
      msg({ id: 'a1', role: 'assistant', content: '答', createdAt: t0 + 2_000 })
    ];
    const { container } = render(
      <ChatTranscript
        busy={false}
        sessionId="s-av"
        model={model}
        messages={messages}
        avatarContext={workerCtx}
      />
    );
    const u1 = container.querySelector('[data-mid="u1"] .chat-msg-avatar');
    const u2 = container.querySelector('[data-mid="u2"] .chat-msg-avatar');
    const a1 = container.querySelector('[data-mid="a1"] .chat-msg-avatar');
    expect(u1?.getAttribute('data-avatar-omitted')).toBeNull();
    expect(u2?.getAttribute('data-avatar-omitted')).toBe('1');
    expect(u2?.getAttribute('title')).toBeNull();
    expect(container.querySelector('[data-mid="u2"]')?.classList.contains('is-continued')).toBe(
      true
    );
    expect(a1).toBeNull();
    expect(container.querySelector('[data-mid="a1"] .chat-msg')?.classList.contains('is-avatarless')).toBe(true);
  });

  it('调度 AI 回复后注入的消息保留右侧头像，不被同名发送者省略', () => {
    const { container } = render(<ChatTranscript busy={false} sessionId="s-side" model={model}
      avatarContext={dispatchCtx} messages={[
        msg({ id: 'a', role: 'assistant', content: '回复', createdAt: 10_000 }),
        msg({ id: 's', role: 'user', source: 'scheduler', content: '派发', createdAt: 11_000 }),
        msg({ id: 'h', role: 'user', host: true, content: '通知', createdAt: 12_000 })
      ]}/>);
    expect(container.querySelector('[data-mid="a"] .chat-msg-avatar')).toBeNull();
    const scheduler = container.querySelector('[data-mid="s"] .chat-msg-avatar');
    expect(scheduler?.getAttribute('data-avatar-omitted')).toBeNull();
    expect(scheduler?.textContent).toBe('🚀');
    expect(container.querySelector('[data-mid="s"] .chat-msg')?.classList.contains('is-left-aligned')).toBe(true);
    expect(container.querySelector('[data-mid="h"] .chat-msg')?.classList.contains('is-left-aligned')).toBe(true);
    expect(container.querySelector('[data-mid="h"] .chat-msg-avatar')?.textContent).toBe('宿主');
  });
});

describe('注入管线 → 转写身份', () => {
  beforeEach(() => {
    resetUserAvatarForTest({ kind: 'emoji', value: '🦊' });
  });

  it('toDisplayMessage 保留 scheduler source，用户消息不标', () => {
    const injected: GuiChatMessage = {
      id: 's1',
      role: 'user',
      parts: [{ kind: 'text', text: '【调度回注 Worker】\n已办' }],
      source: 'scheduler',
      ts: 1
    };
    const typed: GuiChatMessage = {
      id: 'u1',
      role: 'user',
      parts: [{ kind: 'text', text: '手打' }],
      ts: 2
    };
    const dInject = toDisplayMessage(injected);
    const dUser = toDisplayMessage(typed);
    expect(dInject.source).toBe('scheduler');
    expect(dInject.role).toBe('user');
    expect(dInject.host).toBeUndefined();
    expect(dUser.source).toBeUndefined();
    expect(dUser.role).toBe('user');
  });

  it('ChatTranscript：调度注入用调度头像，同列用户消息仍是用户头像', () => {
    const wsCtx: ChatAvatarContext = {
      surfaceKind: 'gui-session',
      workspaceAvatar: '🚀',
      workspaceName: '工作区',
      runtimeId: 'cursor',
      sessionName: '改布局'
    };
    const messages: ChatMessage[] = [
      msg({
        id: 's1',
        role: 'user',
        source: 'scheduler',
        content: '【调度回注 Worker】\n已办',
        createdAt: 10_000
      }),
      msg({ id: 'u1', role: 'user', content: '手打', createdAt: 11_000 })
    ];
    const { container } = render(
      <ChatTranscript
        busy={false}
        sessionId="s-inject"
        model={model}
        messages={messages}
        avatarContext={wsCtx}
      />
    );
    const sched = container.querySelector('[data-mid="s1"] .chat-msg-avatar');
    const user = container.querySelector('[data-mid="u1"] .chat-msg-avatar');
    expect(container.querySelector('[data-mid="s1"]')?.getAttribute('data-role')).toBe(
      'scheduler'
    );
    expect(sched?.getAttribute('data-avatar-sender')).toBe('scheduler');
    expect(sched?.textContent).toBe('🚀');
    expect(sched?.getAttribute('title')).toBe('调度 Agent');
    expect(container.querySelector('[data-mid="u1"]')?.getAttribute('data-role')).toBe('user');
    expect(user?.getAttribute('data-avatar-sender')).toBe('user');
    expect(user?.textContent).toBe('🦊');
    expect(user?.getAttribute('data-avatar-omitted')).toBeNull();
  });
});
