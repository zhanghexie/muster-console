/**
 * 左栏会话树（子代理通用化）：子会话缩进挂父下、twisty 折叠整枝子树、
 * 数据属性供样式与测试定位。分屏拖拽行为不在此断言（另有 center-split 用例覆盖）。
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { PanelHistoryProvider } from '../../src/renderer/src/panelHistory';
import { LeftPanel } from '../../src/renderer/src/panels/LeftPanel';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta } from '../../src/shared/types';

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });

const WS = [{ id: 'ws-a', path: 'E:/demo/a', name: 'Alpha', openedAt: 1 }];

function sess(id: string, name: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    type: 'terminal',
    name,
    createdAt: 1,
    lastUsedAt: 1,
    launchKind: 'agent',
    runtime: 'pi',
    workspaceId: 'ws-a',
    status: 'running',
    lifecycle: 'idle',
    ...extra
  };
}

/** 顶层 A（带两个子）、顶层 B（带一个孙）、顶层 C（无子） */
const SESSIONS: SessionMeta[] = [
  sess('a', '顶层 A', { lastUsedAt: 10 }),
  sess('a-kid1', '子代理 A1', { parentSessionId: 'a', lastUsedAt: 9 }),
  sess('a-kid2', '子代理 A2', { parentSessionId: 'a', lastUsedAt: 8 }),
  sess('b', '顶层 B', { lastUsedAt: 7 }),
  sess('b-kid', '子代理 B1', { parentSessionId: 'b', lastUsedAt: 6 }),
  sess('b-grand', '孙代理 B1a', { parentSessionId: 'b-kid', lastUsedAt: 5 }),
  sess('c', '顶层 C', { lastUsedAt: 4 })
];

function renderLeft(sessions: SessionMeta[] = SESSIONS): void {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  const mock = currentApiMock();
  mock.override('workspaces.list', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a' })
  );
  mock.override('config.get', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a', locale: 'zh-CN' })
  );
  mock.override('sessions.list', () => Promise.resolve({ sessions, activeId: 'a' }));
  const noop = (): void => {};
  render(
    <StoreProvider>
      <PanelHistoryProvider>
        <LeftPanel utilityPanel={null} onSelectUtilityPanel={noop} onCloseUtilityPanel={noop} />
      </PanelHistoryProvider>
    </StoreProvider>
  );
}

const rowOf = (id: string): HTMLElement => {
  const el = document.querySelector(`[data-session-row="${id}"]`);
  if (!el) throw new Error(`找不到会话行 ${id}`);
  return el as HTMLElement;
};

describe('左栏会话树', () => {
  it('子会话按层级缩进挂在父下方，DOM 序父在子前', async () => {
    renderLeft();
    await waitFor(() => expect(rowOf('a')).toBeTruthy());

    expect(rowOf('a').dataset.treeLevel).toBeUndefined();
    expect(rowOf('a-kid1').dataset.treeLevel).toBe('1');
    expect(rowOf('a-kid2').dataset.treeLevel).toBe('1');
    expect(rowOf('b-kid').dataset.treeLevel).toBe('1');
    expect(rowOf('b-grand').dataset.treeLevel).toBe('2');

    const ids = [...document.querySelectorAll('[data-session-row]')].map(
      (el) => (el as HTMLElement).dataset.sessionRow
    );
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('a-kid1'));
    expect(ids.indexOf('b-kid')).toBeLessThan(ids.indexOf('b-grand'));
  });

  it('缩进宽度逐层递增', async () => {
    renderLeft();
    await waitFor(() => expect(rowOf('a-kid1')).toBeTruthy());
    const indent = rowOf('a-kid1').querySelector('.session-tree-indent') as HTMLElement;
    const grandIndent = rowOf('b-grand').querySelector('.session-tree-indent') as HTMLElement;
    expect(indent).toBeTruthy();
    expect(parseInt(indent.style.width, 10)).toBe(12);
    expect(parseInt(grandIndent.style.width, 10)).toBe(24);
  });

  it('展开箭头叠在状态图标位上，不额外占位（缩进只由层级决定）', async () => {
    renderLeft();
    await waitFor(() => expect(rowOf('a')).toBeTruthy());

    // twisty 与状态点同处 .session-state-slot 内——绝对定位覆盖，不占布局宽度
    const slot = rowOf('a').querySelector('.session-state-slot') as HTMLElement;
    expect(slot).toBeTruthy();
    const twisty = slot.querySelector('button.session-tree-twisty') as HTMLElement;
    const state = slot.querySelector('.session-state') as HTMLElement;
    expect(twisty).toBeTruthy();
    expect(state).toBeTruthy();
    // 二者是 slot 的两个子元素（叠放关系由 CSS absolute 承担）
    expect(twisty.parentElement).toBe(slot);
    expect(state.parentElement).toBe(slot);
  });

  it('有子会话的行渲染 twisty 按钮；叶子行不渲染箭头', async () => {
    renderLeft();
    await waitFor(() => expect(rowOf('a')).toBeTruthy());

    const aTwisty = rowOf('a').querySelector('button.session-tree-twisty') as HTMLElement;
    expect(aTwisty).toBeTruthy();
    expect(aTwisty.className).toContain('is-open');

    // 顶层无子行不渲染箭头（状态图标位只有状态点）
    expect(rowOf('c').querySelector('.session-tree-twisty')).toBeNull();

    // 子层叶子行同样不渲染箭头——箭头只在可展开时才有
    const leafRow = sess('a-kid9', '子代理叶子', { parentSessionId: 'a', lastUsedAt: 0 });
    renderLeft([...SESSIONS, leafRow]);
    await waitFor(() => expect(rowOf('a-kid9')).toBeTruthy());
    expect(rowOf('a-kid9').querySelector('.session-tree-twisty')).toBeNull();
    // 但状态点仍在（叶子行照样显示状态）
    expect(rowOf('a-kid9').querySelector('.session-state')).toBeTruthy();
  });

  it('只有有子会话的行标 data-has-children（hover 淡出状态点的限定依据）', async () => {
    renderLeft();
    await waitFor(() => expect(rowOf('a')).toBeTruthy());
    // 有子 → 标记
    expect(rowOf('a').getAttribute('data-has-children')).toBe('true');
    // 无子 → 不标（否则 hover 时状态点淡出却没箭头补位，行内会空一块）
    expect(rowOf('c').getAttribute('data-has-children')).toBeNull();
    expect(rowOf('a-kid1').getAttribute('data-has-children')).toBeNull();
  });

  it('aria-expanded 跟随折叠态', async () => {
    renderLeft();
    await waitFor(() => expect(rowOf('a')).toBeTruthy());
    expect(rowOf('a').getAttribute('aria-expanded')).toBe('true');
    expect(rowOf('c').getAttribute('aria-expanded')).toBeNull();
  });

  it('点 twisty 折叠整枝子树（含孙层），再点展开', async () => {
    renderLeft();
    await waitFor(() => expect(rowOf('a')).toBeTruthy());

    const twisty = rowOf('a').querySelector('.session-tree-twisty') as HTMLElement;
    fireEvent.click(twisty);

    await waitFor(() => expect(document.querySelector('[data-session-row="a-kid1"]')).toBeNull());
    expect(document.querySelector('[data-session-row="a-kid2"]')).toBeNull();
    expect(rowOf('a').getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(rowOf('a').querySelector('.session-tree-twisty') as HTMLElement);
    await waitFor(() => expect(document.querySelector('[data-session-row="a-kid1"]')).toBeTruthy());
    expect(document.querySelector('[data-session-row="a-kid2"]')).toBeTruthy();
  });

  it('折叠中间层时其子树整枝隐藏（含孙层）', async () => {
    renderLeft();
    await waitFor(() => expect(rowOf('b-kid')).toBeTruthy());

    // b-kid 有子（b-grand），点它折叠 → 孙层也必须消失
    const kidTwisty = rowOf('b-kid').querySelector('.session-tree-twisty') as HTMLElement;
    expect(kidTwisty).toBeTruthy();
    fireEvent.click(kidTwisty);

    await waitFor(() => expect(document.querySelector('[data-session-row="b-grand"]')).toBeNull());
    expect(document.querySelector('[data-session-row="b"]')).toBeTruthy();
  });

  it('点 twisty 不切换选中会话', async () => {
    renderLeft();
    await waitFor(() => expect(rowOf('a')).toBeTruthy());
    const before = rowOf('a').className;

    fireEvent.click(rowOf('b').querySelector('.session-tree-twisty') as HTMLElement);
    await waitFor(() => expect(document.querySelector('[data-session-row="b-kid"]')).toBeNull());

    // 选中态仍留在原会话（a）
    expect(rowOf('a').className).toBe(before);
  });

  it('父会话不在列表时子提升为顶层，不凭空消失', async () => {
    renderLeft([sess('orphan-kid', '孤儿子代理', { parentSessionId: 'gone' })]);
    await waitFor(() => expect(rowOf('orphan-kid')).toBeTruthy());
    // 提升为顶层 → 无 tree-level
    expect(rowOf('orphan-kid').dataset.treeLevel).toBeUndefined();
  });

  it('父子链数据成环时不丢行、不断渲染', async () => {
    renderLeft([
      sess('x', 'X', { parentSessionId: 'y' }),
      sess('y', 'Y', { parentSessionId: 'x' }),
      sess('z', 'Z', { parentSessionId: 'x' })
    ]);
    await waitFor(() => expect(rowOf('x')).toBeTruthy());
    const ids = [...document.querySelectorAll('[data-session-row]')].map(
      (el) => (el as HTMLElement).dataset.sessionRow
    );
    for (const id of ['x', 'y', 'z']) expect(ids).toContain(id);
  });

  it('展开箭头复用工作会话分组折叠的 IconChevronDown（同一个图标，同一套折叠语义）', async () => {
    renderLeft();
    await waitFor(() => expect(rowOf('a')).toBeTruthy());
    const twisty = rowOf('a').querySelector('button.session-tree-twisty') as HTMLElement;
    const svg = twisty.querySelector('svg') as SVGElement;

    // 图标本身：IconChevronDown 是 viewBox 0 0 16 16 的 M4 6l4 4 4-4 折线
    expect(svg.getAttribute('viewBox')).toBe('0 0 16 16');
    expect(svg.querySelector('path')?.getAttribute('d')).toBe('M4 6l4 4 4-4');
    // 尺寸与工作会话折叠一致（14px）
    expect(svg.getAttribute('width')).toBe('14');
    // 展开态不加旋转（IconChevronDown 基础态即朝下），收起态 CSS 转 -90° 朝右
    expect(twisty.className).toContain('is-open');
  });

  it('无子代理时退化为扁平列表（不渲染 indent/twisty）', async () => {
    renderLeft([sess('solo1', '独苗一', { lastUsedAt: 2 }), sess('solo2', '独苗二', { lastUsedAt: 1 })]);
    await waitFor(() => expect(rowOf('solo1')).toBeTruthy());
    expect(document.querySelector('.session-tree-indent')).toBeNull();
    expect(document.querySelector('.session-tree-twisty')).toBeNull();
    expect(screen.getByText('独苗二')).toBeTruthy();
  });

  it('箭头默认不可点，悬浮整行后才可点（不误触、不抢点击）', async () => {
    renderLeft();
    await waitFor(() => expect(rowOf('a')).toBeTruthy());
    const twisty = rowOf('a').querySelector('button.session-tree-twisty') as HTMLElement;
    // 契约：twisty 用 pointer-events 门控（CSS 控制），DOM 上它不是隐藏元素，
    // 因此「可点性」由样式而非属性决定——这里断言它仍在行内、且不夺走行的点击目标
    expect(twisty.tagName).toBe('BUTTON');
    expect(twisty.closest('.session-item')).toBe(rowOf('a'));
    // 键盘上不占位（tabIndex=-1）：焦点语义在整行，Tab 不会停在箭头上
    expect(twisty.getAttribute('tabindex')).toBe('-1');
    // 对辅助技术隐藏（行上已有 aria-expanded 表达展开态）
    expect(twisty.getAttribute('aria-hidden')).toBe('true');
  });

  it('子会话仍可拖拽（draggable 由分屏支持判定，不因层级排除）', async () => {
    renderLeft();
    await waitFor(() => expect(rowOf('a-kid1')).toBeTruthy());
    expect(rowOf('a-kid1').getAttribute('draggable')).toBe('true');
  });
});
