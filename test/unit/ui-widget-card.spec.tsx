/**
 * ma-ui 部件卡（智能界面 M2 GUI 呈现层，UiWidgetCard）：
 * - MarkdownBody 链接识别：…agent-sessions/<sid>/ui/<n>-<slug>.(inline|browser).html
 *   渲染为部件卡（inline iframe / browser 链接卡）；urlTransform 放行不被剥 href；
 * - inline 卡以来源校验过的桥信号确认加载，降级/错误可重试；
 * - 宿主桥消息：resize 高度协商（e.source 校验 + clamp）、followup 派发
 *   ma-ui-followup 事件、主题变更经 subscribeTheme 转发 appearance；
 * - ChatSurfaceView 集成：followup 事件 → 建议胶囊同款机制填入输入框（可编辑再发，
 *   不自动发送）；detail.el 不在本表面内不填入（多表面隔离）。
 * 运行: npx vitest run test/unit/ui-widget-card.spec.tsx
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { MarkdownBody } from '../../src/renderer/src/components/MarkdownBody';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import type { ChatMessage } from '../../src/shared/types';
import { ChatSurfaceView } from '../../src/renderer/src/chatSurface/ChatSurfaceView';
import { UI_FOLLOWUP_EVENT } from '../../src/renderer/src/chatSurface/UiWidgetCard';
import { applyTheme, getResolvedAppearance } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta } from '../../src/shared/types';
import type { ChatSurface } from '../../src/shared/chatSurface';
import type { GuiChatMessage } from '../../src/shared/guiWorker';
import { buildExternalFileUrl } from '../../src/shared/filePreview';
import { applyLocaleSetting } from '../../src/shared/i18n';
import { ChatLinkOwnerContext } from '../../src/renderer/src/chatSurface/chatLinkOwner';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
);

const INLINE_PATH = 'E:/data/agent-sessions/sg-1/ui/1-board.inline.html';
const BROWSER_PATH = 'E:/data/agent-sessions/sg-1/ui/2-cmp.browser.html';
const INLINE_MD = `[看板部件](${INLINE_PATH})`;
const BROWSER_MD = `[对比表部件](${BROWSER_PATH})`;

/** 给 jsdom iframe 塞一个假 contentWindow：消息 e.source 校验用它做同源判定 */
function stubContentWindow(iframe: Element, win: unknown): void {
  Object.defineProperty(iframe, 'contentWindow', { value: win, configurable: true });
}

function stubFetchOk(): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
}

function stubFetchMissing(): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
}

/** 来自部件 iframe 的宿主桥消息（e.source=iframe.contentWindow） */
function postFromWidget(win: unknown, data: unknown): void {
  window.dispatchEvent(
    new MessageEvent('message', { data: { v: 2, ...(data as object) }, source: win as unknown as Window })
  );
}
beforeEach(() => currentApiMock().override('uiWidgets.action', async (_path, action) => ({ ok: true, type: action.type, text: action.text, mode: action.mode || 'draft', url: action.url })));

/* ── ChatSurfaceView 集成（gui-session 表面）── */

const WS = [{ id: 'ws-a', path: 'E:/demo/a', name: 'Alpha', openedAt: 1 }];

function sess(id: string): SessionMeta {
  return {
    type: 'terminal',
    createdAt: 1,
    lastUsedAt: 1,
    launchKind: 'agent',
    runtime: 'cursor',
    workspaceId: 'ws-a',
    status: 'running',
    lifecycle: 'idle',
    phase: { value: 'idle', source: 'model', ts: 1 },
    id,
    name: 'GUI 会话'
  } as SessionMeta;
}

function seed(): void {
  const mock = currentApiMock();
  mock.override('workspaces.list', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a' })
  );
  mock.override('config.get', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a', locale: 'zh-CN' })
  );
  mock.override('sessions.list', () =>
    Promise.resolve({ sessions: [sess('sg-1')], activeId: 'sg-1' })
  );
}

function makeGuiSurface(
  messages: GuiChatMessage[],
  sendSpy: ChatSurface['actions']['send'] = async () => true
): ChatSurface {
  const snap = {
    messages,
    busy: false,
    queuedCount: 0,
    queuedItems: [],
    status: null,
    mode: null as null,
    preset: null
  };
  return {
    sessionId: 'sg-1',
    caps: { surfaceKind: 'gui-session' as const, draftKey: 'agent-session:sg-1' },
    subscribe: () => () => undefined,
    getSnapshot: () => snap,
    actions: {
      send: sendSpy,
      stop: () => undefined,
      clear: async () => undefined,
      retry: () => undefined,
      cancelQueued: () => undefined
    }
  };
}

describe('MarkdownBody 链接识别 → 部件卡', () => {
  it('inline 命中：渲染 iframe（sandbox + muster-ext URL），不再当普通链接', async () => {
    stubFetchOk();
    render(<MarkdownBody text={INLINE_MD} />);
    const iframe = (await screen.findByTitle('1-board.inline.html')) as HTMLIFrameElement;
    expect(iframe.getAttribute('src')).toBe(buildExternalFileUrl(INLINE_PATH) + '?attempt=0');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.closest('.ma-ui-card.is-inline')).toBeTruthy();
    expect(iframe.closest('.ma-ui-card')?.querySelector('.ma-ui-toolbar.chat-card-header .chat-card-header-icon svg')).toBeTruthy();
  });

  it('urlTransform 放行：href 不被默认白名单清空（部件路径原样到达 iframe src）', async () => {
    render(<MarkdownBody text={INLINE_MD} />);
    // iframe src = ext URL = href 全程未被剥成空串（不再依赖 HEAD 降级卡间接证明）
    const iframe = (await screen.findByTitle('1-board.inline.html')) as HTMLIFrameElement;
    expect(iframe.getAttribute('src')).toBe(buildExternalFileUrl(INLINE_PATH) + '?attempt=0');
  });

  it('桥活体信号超时：宽限窗内不误杀，超窗才判失败（含网页区兜底）', async () => {
    // 全程同步查询：findBy* 在假定时器下永不推进（此前泄漏导致后续用例全挂）
    vi.useFakeTimers();
    try {
      await act(async () => { render(<MarkdownBody text={`前文 [看板部件](${INLINE_PATH}) 后文`} />); });
      // 加载期直接挂 iframe（骨架态），不依赖 HEAD/CORS；jsdom 无 IO → 立即挂载
      const iframe = screen.getByTitle('1-board.inline.html') as HTMLIFrameElement;
      expect(iframe.getAttribute('src')).toBe(buildExternalFileUrl(INLINE_PATH) + '?attempt=0');
      // 并发宽限窗（实测：10+ 卡时沙箱 iframe 进程排队，4s 会误杀）——4s 仍活着
      act(() => { vi.advanceTimersByTime(4000); });
      expect(document.querySelector('iframe')).toBeTruthy();
      // 10s 仍无 __ma 桥消息 → 判加载失败
      act(() => { vi.advanceTimersByTime(6000); });
      expect(screen.getByRole('status').textContent).toContain('内容加载超时');
      expect(screen.queryByText(INLINE_PATH)).toBeNull();
      expect(document.querySelector('iframe')).toBeNull();
      // 兜底出口：网页区打开
      fireEvent.click(screen.getByRole('button', { name: '在网页区打开' }));
      expect(currentApiMock().mockOf('browser.open')).toHaveBeenCalledWith({
        url: buildExternalFileUrl(INLINE_PATH)
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('懒挂载：滚入视口前只留等高占位，IntersectionObserver 命中后才建 iframe', async () => {
    const instances: Array<{ cb: (entries: Array<{ isIntersecting: boolean }>) => void }> = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        cb: (entries: Array<{ isIntersecting: boolean }>) => void;
        constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
          this.cb = cb;
          instances.push(this);
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    );
    try {
      render(<MarkdownBody text={INLINE_MD} />);
      // 视口外：等高占位，无 iframe
      expect(document.querySelector('.ma-ui-frame-holder')).toBeTruthy();
      expect(document.querySelector('iframe')).toBeNull();
      // 滚入：建 iframe
      act(() => {
        instances[0]!.cb([{ isIntersecting: true }]);
      });
      const iframe = await waitFor(() => {
        const el = screen.getByTitle('1-board.inline.html') as HTMLIFrameElement;
        expect(el.getAttribute('src')).toBe(buildExternalFileUrl(INLINE_PATH) + '?attempt=0');
        return el;
      });
      expect(iframe).toBeTruthy();
      expect(document.querySelector('.ma-ui-frame-holder')).toBeNull();
    } finally {
      // 只还原 IO：unstubAllGlobals 会把模块级 ResizeObserver 桩一起清掉，殃及后续用例
      vi.unstubAllGlobals();
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe(): void {}
          unobserve(): void {}
          disconnect(): void {}
        }
      );
    }
  });

  it('browser 命中：链接卡形态，点击 browser.open({ url: ext URL })', async () => {
    const user = userEvent.setup();
    render(<MarkdownBody text={BROWSER_MD} />);
    const btn = await screen.findByRole('button', { name: /对比表部件/ });
    expect(btn.textContent).not.toContain('2-cmp.browser.html');
    await user.click(btn);
    expect(currentApiMock().mockOf('browser.open')).toHaveBeenCalledWith({
      url: buildExternalFileUrl(BROWSER_PATH)
    });
  });
  it('opens an interactive card in its originating conversation', async () => {
    render(<ChatLinkOwnerContext.Provider value={{ workspaceId: 'ws-card', sessionId: 'chat-card', scope: 'session' }}><MarkdownBody text={BROWSER_MD}/></ChatLinkOwnerContext.Provider>);
    fireEvent.click(await screen.findByRole('button', { name: /对比表部件/ }));
    expect(currentApiMock().mockOf('browser.open')).toHaveBeenCalledWith({ url: buildExternalFileUrl(BROWSER_PATH), workspaceId: 'ws-card', sessionId: 'chat-card', scope: 'session' });
  });

  it('非部件链接不受影响：工作区路径仍走 FileLink，http 仍是外链锚点', () => {
    const onFileLink = vi.fn();
    const { container } = render(
      <MarkdownBody
        text={'[说明](E:/ws/notes/readme.md) 和 [外链](https://example.com)'}
        onFileLink={onFileLink}
      />
    );
    expect(container.querySelector('.ws-file-link')).toBeTruthy();
    const anchor = container.querySelector('a[target="_blank"]');
    expect(anchor?.getAttribute('href')).toBe('https://example.com');
    expect(container.querySelector('.ma-ui-card')).toBeNull();
  });
});

describe('UiWidgetCard 宿主桥消息', () => {
  it('卸载时只释放本卡片的回执来源', async () => {
    const view = render(<MarkdownBody text={INLINE_MD} />);
    const frame = await screen.findByTitle('1-board.inline.html');
    fireEvent.load(frame);
    const calls = currentApiMock().mockOf('uiWidgets.receipt').mock.calls;
    const own = calls.find(call => call[0] === INLINE_PATH)?.[2];
    expect(typeof own).toBe('string');
    view.unmount();
    expect(currentApiMock().mockOf('uiWidgets.releaseReceipt')).toHaveBeenCalledWith(INLINE_PATH, own);
  });
  it('渲染失败的默认提示随语言切换，回执保留原始原因', async () => {
    render(<MarkdownBody text={INLINE_MD} />);
    const source = { postMessage: vi.fn() }; stubContentWindow(await screen.findByTitle('1-board.inline.html'), source);
    act(() => postFromWidget(source, { __ma: true, type: 'resize', stats: { degraded: 1 } }));
    try {
      act(() => { applyLocaleSetting('en'); });
      expect(screen.getByRole('status').textContent).toContain('Content rendering failed');
      expect(currentApiMock().mockOf('uiWidgets.receipt')).toHaveBeenCalledWith(INLINE_PATH, expect.objectContaining({ status: 'failed', error: '内容渲染失败' }), expect.any(String));
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('活跃状态桥漏收 render 时只复查一次，不提前发 failed 或重载 iframe', async () => {
    vi.useFakeTimers();
    try {
      await act(async () => { render(<MarkdownBody text={INLINE_MD} />); });
      const iframe = screen.getByTitle('1-board.inline.html') as HTMLIFrameElement;
      const source = { postMessage: vi.fn() }; stubContentWindow(iframe, source);
      await act(async () => postFromWidget(source, { __ma: true, type: 'ready' }));
      act(() => { vi.advanceTimersByTime(10000); });
      expect(screen.getByTitle('1-board.inline.html')).toBe(iframe);
      expect(document.querySelector('.ma-ui-card.is-missing')).toBeNull();
      expect(source.postMessage).toHaveBeenCalledWith({ __ma: true, type: 'probe' }, '*');
      expect(currentApiMock().mockOf('uiWidgets.receipt').mock.calls.some(([, receipt]) => receipt.status === 'failed')).toBe(false);
      act(() => postFromWidget(source, { __ma: true, type: 'render', status: 'rendered' }));
      act(() => { vi.advanceTimersByTime(2000); });
      expect(document.querySelector('.ma-ui-card.is-missing')).toBeNull();
      expect(screen.getByTitle('1-board.inline.html')).toBe(iframe);
    } finally { vi.useRealTimers(); }
  });

  it('活跃桥复查后仍无 render 会按最终期限失败', async () => {
    vi.useFakeTimers();
    try {
      await act(async () => { render(<MarkdownBody text={INLINE_MD} />); });
      const source = { postMessage: vi.fn() }; stubContentWindow(screen.getByTitle('1-board.inline.html'), source);
      act(() => postFromWidget(source, { __ma: true, type: 'resize', height: 100 }));
      act(() => { vi.advanceTimersByTime(10000); });
      expect(document.querySelector('iframe')).toBeTruthy();
      act(() => { vi.advanceTimersByTime(2000); });
      expect(screen.getByRole('status').textContent).toContain('内容加载超时');
    } finally { vi.useRealTimers(); }
  });

  it('degraded resize without a message cannot erase the author error or its line', async () => {
    render(<MarkdownBody text={INLINE_MD} />);
    const source = { postMessage: vi.fn() }; stubContentWindow(await screen.findByTitle('1-board.inline.html'), source);
    act(() => {
      postFromWidget(source, { __ma: true, type: 'error', message: 'HOST_EXPECTED_ERROR（行 7:3）' });
      postFromWidget(source, { __ma: true, type: 'resize', height: 80, stats: { degraded: 1 } });
    });
    expect(screen.getByRole('status').textContent).toContain('HOST_EXPECTED_ERROR（行 7:3）');
    expect(currentApiMock().mockOf('uiWidgets.receipt')).toHaveBeenCalledWith(INLINE_PATH, expect.objectContaining({ status: 'failed', error: 'HOST_EXPECTED_ERROR（行 7:3）' }), expect.any(String));
  });

  it('组合内容使用自然高度，长内容不被 720px/60vh 截断，短内容不留 120px 空白', async () => {
    stubFetchOk();
    render(<MarkdownBody text={INLINE_MD} />);
    const iframe = (await screen.findByTitle('1-board.inline.html')) as HTMLIFrameElement;
    expect(iframe.style.height).toBe('96px');
    const fakeWin = { postMessage: vi.fn() };
    stubContentWindow(iframe, fakeWin);

    act(() => postFromWidget(fakeWin, { __ma: true, type: 'resize', height: 300 }));
    await waitFor(() => expect(iframe.style.height).toBe('300px'));

    act(() => postFromWidget(fakeWin, { __ma: true, type: 'resize', height: 2400 }));
    await waitFor(() => expect(iframe.style.height).toBe('2400px'));

    act(() => postFromWidget(fakeWin, { __ma: true, type: 'resize', height: 30 }));
    await waitFor(() => expect(iframe.style.height).toBe('30px'));
  });

  it('e.source 不匹配 / 缺 __ma 标记的 message 不改高度', async () => {
    stubFetchOk();
    render(<MarkdownBody text={INLINE_MD} />);
    const iframe = (await screen.findByTitle('1-board.inline.html')) as HTMLIFrameElement;
    stubContentWindow(iframe, { postMessage: vi.fn() });

    postFromWidget({ postMessage: vi.fn() }, { __ma: true, type: 'resize', height: 222 });
    postFromWidget(iframe.contentWindow, { type: 'resize', height: 333 });
    postFromWidget(iframe.contentWindow, { __ma: true, v: 1, type: 'resize', height: 444 });
    await new Promise((r) => setTimeout(r, 20));
    expect(iframe.style.height).toBe('96px');
  });

  it('渲染降级不能冒充 alive；重试会重建 iframe 并可恢复', async () => {
    const user = userEvent.setup();
    render(<MarkdownBody text={INLINE_MD} />);
    const iframe = await screen.findByTitle('1-board.inline.html');
    const source = { postMessage: vi.fn() };
    stubContentWindow(iframe, source);
    act(() => postFromWidget(source, { __ma: true, type: 'resize', height: 80, stats: { ok: 0, degraded: 1 } }));
    expect(document.querySelector('.ma-ui-card.is-missing')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('内容渲染失败');
    await user.click(screen.getByRole('button', { name: '重试' }));
    const retry = screen.getByTitle('1-board.inline.html');
    expect(retry).not.toBe(iframe);
    const next = { postMessage: vi.fn() };
    stubContentWindow(retry, next);
    act(() => postFromWidget(next, { __ma: true, type: 'resize', height: 180, stats: { ok: 1, degraded: 0 } }));
    act(() => postFromWidget(next, { __ma: true, type: 'render', status: 'rendered' }));
    expect(document.querySelector('.ma-ui-card.is-missing')).toBeNull();
    expect(document.querySelector('.ma-ui-card.is-loading')).toBeNull();
  });

  it('作者脚本 error 显示原因，其他 iframe 的错误不能污染当前部件', async () => {
    await act(async () => { render(<MarkdownBody text={INLINE_MD} />); });
    const iframe = await screen.findByTitle('1-board.inline.html');
    const source = { postMessage: vi.fn() };
    stubContentWindow(iframe, source);
    act(() => postFromWidget({}, { __ma: true, type: 'error', message: 'foreign' }));
    expect(document.querySelector('.ma-ui-card.is-missing')).toBeNull();
    act(() => postFromWidget(source, { __ma: true, type: 'error', message: '变量不存在' }));
    expect(screen.getByRole('status').textContent).toContain('变量不存在');
  });

  it('recoverable component diagnostics keep the iframe and clear on a successful render', async () => {
    await act(async () => { render(<MarkdownBody text={INLINE_MD} />); });
    const iframe = await screen.findByTitle('1-board.inline.html');
    const source = { postMessage: vi.fn() }; stubContentWindow(iframe, source);
    act(() => postFromWidget(source, { __ma: true, type: 'diagnostic', recoverable: true, message: '开始日期不能晚于结束日期' }));
    expect(screen.getByTitle('1-board.inline.html')).toBe(iframe);
    expect(document.querySelector('.ma-ui-card.is-missing')).toBeNull();
    expect(currentApiMock().mockOf('uiWidgets.receipt')).toHaveBeenCalledWith(INLINE_PATH, expect.objectContaining({ status: 'degraded' }), expect.any(String));
    act(() => postFromWidget(source, { __ma: true, type: 'render', status: 'rendered' }));
    expect(screen.getByTitle('1-board.inline.html')).toBe(iframe);
    expect(currentApiMock().mockOf('uiWidgets.receipt')).toHaveBeenLastCalledWith(INLINE_PATH, expect.objectContaining({ status: 'rendered' }), expect.any(String));
  });

  it('followup 消息：派发 ma-ui-followup CustomEvent（detail.text + 卡片元素）', async () => {
    stubFetchOk();
    const events: CustomEvent[] = [];
    const onEvt = (e: Event): void => {
      events.push(e as CustomEvent);
    };
    window.addEventListener(UI_FOLLOWUP_EVENT, onEvt);
    try {
      await act(async () => { render(<MarkdownBody text={INLINE_MD} />); });
      const iframe = (await screen.findByTitle('1-board.inline.html')) as HTMLIFrameElement;
      const fakeWin = { postMessage: vi.fn() };
      stubContentWindow(iframe, fakeWin);

      postFromWidget(fakeWin, {
        __ma: true,
        type: 'action',
        action: { type: 'followup', text: '帮我算一下月供 8800' }
      });
      await waitFor(() => expect(events.length).toBe(1));
      const detail = events[0]!.detail as { text: string; el: Element | null };
      expect(detail.text).toBe('帮我算一下月供 8800');
      expect(detail.el?.classList.contains('ma-ui-card')).toBe(true);
    } finally {
      window.removeEventListener(UI_FOLLOWUP_EVENT, onEvt);
    }
  });

  it('主题同步：桥信号激活后 applyTheme 切浅色 → iframe 收到 appearance 消息', async () => {
    stubFetchOk();
    render(<MarkdownBody text={INLINE_MD} />);
    const iframe = (await screen.findByTitle('1-board.inline.html')) as HTMLIFrameElement;
    const fakeWin = { postMessage: vi.fn() };
    stubContentWindow(iframe, fakeWin);
    // 先激活（活体信号），appearance 订阅才挂
    act(() => postFromWidget(fakeWin, { __ma: true, type: 'resize', height: 300 }));
    await waitFor(() => expect(iframe.style.height).toBe('300px'));

    applyTheme(builtinTheme('light')!);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(fakeWin.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ __ma: true, type: 'appearance', theme: 'light', cssVars: expect.objectContaining({ '--bg-card': getResolvedAppearance().cssVars['--surface-canvas'], '--bg-canvas': getResolvedAppearance().cssVars['--surface-canvas'] }), fontStylesheets: [] }),
      '*'
    );
  });
});

describe('交互输出独立于工具日志', () => {
  function toolMsg(name: string, result: string | undefined): ChatMessage {
    return {
      id: 'm-tool',
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      toolCalls: [
        {
          id: 'tc1',
          name,
          arguments: JSON.stringify({ title: '回归汇总', html: '<ma-chart></ma-chart>' }),
          result,
          status: 'ok'
        }
      ]
    } as ChatMessage;
  }

  it('ui.render 结果直接成为消息输出，工具日志默认收起；非 ui 工具不挂', async () => {
    const { container } = render(
      <ChatMessageView message={toolMsg('ui.render', JSON.stringify({ link: INLINE_PATH, markdown: '[x](<…>)' }))} />
    );
    const widgetHost = container.querySelector('.chat-body > .ma-ui-card');
    expect(widgetHost).toBeTruthy();
    await waitFor(() => expect(widgetHost?.querySelector('iframe')?.getAttribute('src')).toBe(buildExternalFileUrl(INLINE_PATH) + '?attempt=0'));
    // 输出直接可见，技术日志不自动展开。
    expect(container.querySelector('details.tool-call-group-details')?.hasAttribute('open')).toBe(false);
    expect(container.querySelector('details.tool-card')).toBeNull();

    const plain = render(
      <ChatMessageView message={toolMsg('browser.open', JSON.stringify({ link: INLINE_PATH }))} />
    );
    expect(plain.container.querySelector('.tool-ui-widget')).toBeNull();
  });

  it('MCP 名（mcp__muster__ui_render）与失败结果（无 link）同样处理', async () => {
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(
      <ChatMessageView
        message={toolMsg('mcp__muster__ui_render', JSON.stringify({ link: BROWSER_PATH }))}
      />
    ); });
    const { container } = view;
    expect(container.querySelector('.chat-body > .ma-ui-card .ma-ui-linkcard')).toBeTruthy();

    const failed = render(
      <ChatMessageView message={toolMsg('ui.render', JSON.stringify({ ok: false }))} />
    );
    expect(failed.container.querySelector('.tool-ui-widget')).toBeNull();
  });
});

describe('ChatSurfaceView 集成：followup 回填输入框', () => {
  beforeEach(() => {
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
    if (typeof document.execCommand !== 'function') {
      document.execCommand = () => false;
    }
    seed();
    stubFetchOk();
  });

  it('部件 followup → 追加到已有草稿（可编辑再发，不自动发送）', async () => {
    const messages: GuiChatMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ kind: 'text', text: `部件做好了：${INLINE_MD}` }],
        ts: 2
      }
    ];
    const surface = makeGuiSurface(messages, (vi.fn(async () => true)) as unknown as ChatSurface['actions']['send']);
    render(
      <StoreProvider>
        <ChatSurfaceView surface={surface} workspaceId="ws-a" />
      </StoreProvider>
    );

    const iframe = await waitFor(() => {
      const el = document.querySelector('iframe.ma-ui-frame');
      expect(el).toBeTruthy();
      return el as HTMLIFrameElement;
    });
    const fakeWin = { postMessage: vi.fn() };
    stubContentWindow(iframe, fakeWin);
    const editorBefore = screen.getByRole('textbox');
    await userEvent.setup().click(editorBefore);
    await userEvent.setup().type(editorBefore, '保留这段草稿');
    act(() => postFromWidget(fakeWin, {
      __ma: true,
      type: 'action',
      action: { type: 'followup', text: '月供改成 8800 再算一次' }
    }));

    const editor = await waitFor(() => {
      const el = screen.getByRole('textbox');
      expect(el.textContent).toContain('保留这段草稿');
      expect(el.textContent).toContain('月供改成 8800 再算一次');
      return el;
    });
    expect(editor).toBeTruthy();
    // 填入 ≠ 发送
    expect(surface.actions.send).not.toHaveBeenCalled();
  });

  it('detail.el 不在本表面内（跨表面事件）不填入', async () => {
    const messages: GuiChatMessage[] = [
      { id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '完成。' }], ts: 2 }
    ];
    render(
      <StoreProvider>
        <ChatSurfaceView surface={makeGuiSurface(messages)} workspaceId="ws-a" />
      </StoreProvider>
    );
    await screen.findByText('完成。');
    window.dispatchEvent(
      new CustomEvent(UI_FOLLOWUP_EVENT, { detail: { text: '外部表面的文本', el: document.body } })
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByRole('textbox').textContent).not.toBe('外部表面的文本');
  });
  it('明确的发送动作走所属表面发送入口，并回报结果；跨会话事件不能冒领', async () => {
    const send = vi.fn(async () => true), respond = vi.fn(), claim = vi.fn(() => true);
    render(<StoreProvider><ChatSurfaceView surface={makeGuiSurface([], send)} workspaceId="ws-a" /></StoreProvider>);
    await act(async () => window.dispatchEvent(new CustomEvent(UI_FOLLOWUP_EVENT, {
      detail: { text: '用选中的 A 继续', sessionId: 'sg-1', el: null, mode: 'send', claim, respond }
    })));
    expect(send).toHaveBeenCalledWith('用选中的 A 继续', undefined);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    await act(async () => window.dispatchEvent(new CustomEvent(UI_FOLLOWUP_EVENT, {
      detail: { text: '不能串会话', sessionId: 'other', el: null, mode: 'send', claim, respond }
    })));
    expect(send).toHaveBeenCalledTimes(1);
  });
});
