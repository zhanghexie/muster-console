/**
 * 划词浮条宿主回归（组件级）：
 * 1) 任意滚动不再一律收起——活选区跟手重锚定，塌了也原位保留（中间会话刷新/滚动误关）；
 * 2) 外点 mousedown / 按键仍收起（收起通道没被顺手拆掉）。
 * SelectionMenuHost 会间接加载 textToolRunner（模块期订 window.api），须在 api-mock 装好后再动态 import。
 * window.api 走 helpers/api-mock（AGENTS.md 测试规约）。
 */
import React, { type ComponentType } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { installApiMock } from './helpers/api-mock';
import {
  dismissSelectionMenu,
  liveSelectionAnchor,
  readSelectionUi,
  showSelectionMenu,
  syncSelectionMenuToLiveSelection
} from '../../src/renderer/src/components/selectionMenuController';

let SelectionMenuHost: ComponentType;

beforeAll(async () => {
  installApiMock();
  ({ SelectionMenuHost } = await import('../../src/renderer/src/components/SelectionMenuHost'));
});

function renderHost() {
  return render(
    <StoreProvider>
      <div className="h-strip" data-testid="selection-strip">
        <div data-sel-area="default" className="chat-list">
          可选中的一段会话正文 hello-sel
        </div>
      </div>
      <SelectionMenuHost />
    </StoreProvider>
  );
}

function openDomMenu(anchor = { x: 40, y: 50 }): void {
  act(() => {
    showSelectionMenu({
      source: 'dom',
      area: 'default',
      text: 'hello-sel',
      anchor
    });
  });
}

afterEach(() => {
  act(() => dismissSelectionMenu());
  vi.restoreAllMocks();
});

describe('liveSelectionAnchor 纯逻辑', () => {
  it('塌/空选区返回 null；有可见矩形取末段右下', () => {
    expect(liveSelectionAnchor(null)).toBeNull();
    expect(
      liveSelectionAnchor({
        isCollapsed: true,
        rangeCount: 1,
        toString: () => 'x',
        getRangeAt: () => {
          throw new Error('should not read range');
        }
      })
    ).toBeNull();
    expect(
      liveSelectionAnchor({
        isCollapsed: false,
        rangeCount: 1,
        toString: () => '  ',
        getRangeAt: () => {
          throw new Error('should not read range');
        }
      })
    ).toBeNull();

    const sel = {
      isCollapsed: false,
      rangeCount: 1,
      toString: () => 'hello-sel',
      getRangeAt: () => ({
        getClientRects: () => [
          { right: 10, bottom: 20, width: 8, height: 8 },
          { right: 88, bottom: 66, width: 12, height: 10 }
        ],
        getBoundingClientRect: () => ({ right: 1, bottom: 1, width: 1, height: 1 })
      })
    };
    expect(liveSelectionAnchor(sel)).toEqual({ x: 88, y: 66 });
  });
});

describe('SelectionMenuHost 滚动/选区不误关', () => {
  it('CLI 的终端选区只投递到该终端提供的批注回调', () => {
    renderHost();
    const annotate = vi.fn(), clearSelection = vi.fn(), keepFocus = vi.fn();
    act(() => showSelectionMenu({ source: 'xterm', area: 'terminal', owner: 'cli-a', text: '终端原文',
      anchor: { x: 40, y: 50 }, context: { annotate, clearSelection, keepFocus } }));
    fireEvent.click(screen.getByRole('button', { name: '批注' }));
    expect(annotate).toHaveBeenCalledOnce();
    expect(annotate).toHaveBeenCalledWith('终端原文');
    expect(clearSelection).toHaveBeenCalled();
    expect(readSelectionUi().menu).toBeNull();
  });

  function mockLiveRange() {
    const source = document.querySelector<HTMLDivElement>('.chat-list')!;
    const rect = { right: 200, bottom: 140, width: 80, height: 18 };
    const range = {
      commonAncestorContainer: source.firstChild!,
      getClientRects: () => [rect],
      getBoundingClientRect: () => rect
    };
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false, rangeCount: 1, toString: () => 'hello-sel', getRangeAt: () => range
    } as unknown as Selection);
    return { source, rect, range };
  }

  it('从固定页面划词时保留工作区作用域', () => {
    renderHost();
    const { source } = mockLiveRange();
    source.dataset.rightLinkScope = 'workspace';
    source.dataset.rightLinkWorkspace = 'ws-origin';
    source.dataset.rightLinkSession = 'chat-origin';
    fireEvent.mouseUp(source, { button: 0 });
    expect(readSelectionUi().menu?.context?.rightOwner).toEqual({
      scope: 'workspace', workspaceId: 'ws-origin', sessionId: 'chat-origin'
    });
  });

  it('切离划词来源页后收起浮条并保留选区', async () => {
    renderHost();
    const { source } = mockLiveRange();
    source.dataset.hPage = 'git';
    const clearSelection = vi.fn();
    vi.mocked(window.getSelection).mockReturnValue({
      ...window.getSelection(), removeAllRanges: clearSelection
    } as unknown as Selection);
    fireEvent.mouseUp(source, { button: 0 });
    const bar = screen.getByRole('toolbar', { name: '选区操作' });
    expect(bar.parentElement).toBe(screen.getByTestId('selection-strip'));
    await act(async () => { source.dataset.hPeek = ''; });
    expect(screen.queryByRole('toolbar', { name: '选区操作' })).toBeNull();
    expect(bar.getAttribute('data-mp-stage')).toBe('out');
    await waitFor(() => expect(bar.isConnected).toBe(false));
    expect(clearSelection).not.toHaveBeenCalled();
  });

  it.each(['top', 'bottom', 'left', 'right'] as const)('选区滚出视口 %s 后暂隐，滚回自动恢复且保留文字', (edge) => {
    renderHost();
    const { source, rect } = mockLiveRange();
    openDomMenu();
    const original = { ...rect };
    if (edge === 'top') rect.bottom = -10;
    if (edge === 'bottom') rect.bottom = window.innerHeight + 50;
    if (edge === 'left') rect.right = -10;
    if (edge === 'right') rect.right = window.innerWidth + 100;
    fireEvent.scroll(source);
    expect(screen.queryByRole('toolbar', { name: '选区操作' })).toBeNull();
    expect(readSelectionUi().menu?.text).toBe('hello-sel');
    Object.assign(rect, original);
    fireEvent.scroll(source);
    expect(screen.getByRole('toolbar', { name: '选区操作' })).toBeTruthy();
    expect(readSelectionUi().menu?.anchor).toEqual({ x: 200, y: 140 });
  });

  it('嵌套滚动区裁切选区时隐藏；多行仍有可见片段时锚定可见片段', () => {
    renderHost();
    const { source, rect, range } = mockLiveRange();
    source.style.overflowX = 'auto';
    source.style.overflowY = 'auto';
    vi.spyOn(source, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 20, right: 300, bottom: 150 } as DOMRect);
    openDomMenu();
    rect.bottom = 190;
    fireEvent.scroll(source);
    expect(screen.queryByRole('toolbar')).toBeNull();
    range.getClientRects = () => [{ right: 180, bottom: 100, width: 60, height: 18 }, rect];
    fireEvent.scroll(source);
    expect(screen.getByRole('toolbar')).toBeTruthy();
    expect(readSelectionUi().menu?.anchor).toEqual({ x: 180, y: 100 });
  });

  it('选区被输入框遮住时暂隐，滚回重显；浮条自身不视作遮挡', () => {
    renderHost();
    const { source } = mockLiveRange();
    const composer = document.createElement('div');
    document.body.append(composer);
    const hits = vi.fn().mockReturnValue([composer, source]);
    const previous = Object.getOwnPropertyDescriptor(document, 'elementsFromPoint');
    Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: hits });
    try {
      openDomMenu();
      fireEvent.scroll(source);
      expect(screen.queryByRole('toolbar')).toBeNull();
      hits.mockReturnValue([document.querySelector('.sel-bar'), source]);
      fireEvent.scroll(source);
      expect(screen.getByRole('toolbar')).toBeTruthy();
      fireEvent.mouseDown(document.body);
      fireEvent.scroll(source);
      expect(readSelectionUi().menu).toBeNull();
    } finally {
      composer.remove();
      if (previous) Object.defineProperty(document, 'elementsFromPoint', previous);
      else Reflect.deleteProperty(document, 'elementsFromPoint');
    }
  });

  it('无关面板 scroll 不收起浮条；活选区矩形变化则重锚定', async () => {
    renderHost();
    openDomMenu({ x: 40, y: 50 });
    const bar = await screen.findByRole('toolbar', { name: '选区操作' });
    expect(bar).toBeTruthy();
    const leftBefore = (bar as HTMLElement).style.left;

    const otherPane = document.createElement('div');
    otherPane.className = 'other-session-pane';
    document.body.appendChild(otherPane);
    otherPane.dispatchEvent(new Event('scroll', { bubbles: false }));
    window.dispatchEvent(new Event('scroll'));
    expect(readSelectionUi().menu?.text).toBe('hello-sel');
    expect(screen.getByRole('toolbar', { name: '选区操作' })).toBeTruthy();
    otherPane.remove();

    act(() => {
      syncSelectionMenuToLiveSelection({
        isCollapsed: false,
        rangeCount: 1,
        toString: () => 'hello-sel',
        getRangeAt: () => ({
          getClientRects: () => [{ right: 200, bottom: 140, width: 20, height: 12 }],
          getBoundingClientRect: () => ({ right: 200, bottom: 140, width: 20, height: 12 })
        })
      });
    });
    expect(readSelectionUi().menu?.anchor).toEqual({ x: 200, y: 140 });
    await waitFor(() => {
      expect((screen.getByRole('toolbar', { name: '选区操作' }) as HTMLElement).style.left).not.toBe(
        leftBefore
      );
    });
  });

  it('selectionchange 塌陷（会话刷新换节点）不收起浮条', async () => {
    renderHost();
    openDomMenu();
    await screen.findByRole('toolbar', { name: '选区操作' });

    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(readSelectionUi().menu).toBeTruthy();
    expect(screen.getByRole('toolbar', { name: '选区操作' })).toBeTruthy();
  });

  it('点浮条外仍收起（收起通道保留）', async () => {
    renderHost();
    openDomMenu();
    await screen.findByRole('toolbar', { name: '选区操作' });

    act(() => {
      fireEvent.mouseDown(document.body);
    });
    expect(readSelectionUi().menu).toBeNull();
    expect(screen.queryByRole('toolbar', { name: '选区操作' })).toBeNull();
  });
});
