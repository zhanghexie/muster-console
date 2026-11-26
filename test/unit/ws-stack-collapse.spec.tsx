/**
 * 工作区胶囊栈折叠（iOS 堆叠式）组件级测试：
 * - 折叠钮随栈头渲染（≥2 个工作区才有），点按在折叠/展开间切换；
 * - 折叠=当前工作区行置顶且保持展开，其余行收起（acc 行失去 is-open）；
 * - 偏好按工作区落 localStorage（muster.sidebarCollapsed.v1:<workspaceId>:workspaces），重挂载按偏好恢复；
 * - 单工作区无折叠钮；
 * - 展开静止态无动画窗口标记，is-active-row 按真实激活工作区标记（防「内阴影」回归）；
 * - 切换挂 is-stack-animating 动画窗口，panelMs+级联延迟后收窗、连点重置（防瞬时滚动条回归）；
 * - 折叠几何静态守卫：飞行位移常量 --ws-row-h 与行高 --ws-bubble-h 一致（jsdom 无布局，
 *   transform 位移测不到，防行组成改动后忘同步常量的折叠错位回归）。
 * UI 交互改动须带组件测试（AGENTS.md 测试规约）；window.api 走 helpers/api-mock。
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StoreProvider } from '../../src/renderer/src/store';
import { AgentFloat } from '../../src/renderer/src/panels/AgentFloat';
import { MOTION } from '../../src/renderer/src/components/motion';
import { currentApiMock } from './helpers/api-mock';
import type { WorkspaceInfo } from '../../src/shared/types';

const KEY = 'muster.sidebarCollapsed.v1:ws-a:workspaces';

function ws(id: string, name: string): WorkspaceInfo {
  return { id, path: `E:/demo/${id}`, name, openedAt: 1 };
}

const THREE = [ws('ws-a', 'Alpha'), ws('ws-b', 'Beta'), ws('ws-c', 'Gamma')];
const FIVE = [
  ws('ws-a', 'Alpha'),
  ws('ws-b', 'Beta'),
  ws('ws-c', 'Gamma'),
  ws('ws-d', 'Delta'),
  ws('ws-e', 'Epsilon')
];

function seedWorkspaces(list: WorkspaceInfo[], activeId: string): void {
  const mock = currentApiMock();
  mock.override('workspaces.list', () =>
    Promise.resolve({ workspaces: list, activeWorkspaceId: activeId })
  );
  mock.override('config.get', () =>
    Promise.resolve({
      workspaces: list,
      activeWorkspaceId: activeId,
      locale: 'zh-CN'
    })
  );
}

function renderStack() {
  return render(
    <StoreProvider>
      {/* stackInline：栈内联渲染（窄屏路径），无需 portal 槽位即可测真实栈本体 */}
      <AgentFloat stackInline />
    </StoreProvider>
  );
}

function stackRows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('.agent-ws-stack:not(.agent-ws-stack-ghost) .agent-ws-stack-row')
  );
}

function collapseBtn(): HTMLElement {
  return document.querySelector<HTMLElement>('.agent-ws-collapse-btn')!;
}

beforeEach(() => {
  localStorage.removeItem(KEY);
  localStorage.removeItem('muster.sidebarCollapsed.v1:ws-b:workspaces');
  localStorage.removeItem('muster.wsStackCollapsed.v1');
});

describe('工作区栈折叠（iOS 堆叠式）', () => {
  it('实际工作区切换：A 收起、B 展开，来回切换分别恢复，不覆盖另一工作区', async () => {
    seedWorkspaces(THREE, 'ws-a');
    renderStack();
    await screen.findByTitle(/Alpha/);
    expect(screen.getByRole('button', { current: true }).textContent).toBe('Alpha');
    fireEvent.click(collapseBtn());
    expect(collapseBtn().getAttribute('aria-expanded')).toBe('false');
    act(() => currentApiMock().emit('workspaces:changed', { workspaces: THREE, activeWorkspaceId: 'ws-b' }));
    expect(collapseBtn().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { current: true }).textContent).toBe('Beta');
    fireEvent.click(collapseBtn());
    fireEvent.click(collapseBtn());
    act(() => currentApiMock().emit('workspaces:changed', { workspaces: THREE, activeWorkspaceId: 'ws-a' }));
    expect(collapseBtn().getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { current: true }).textContent).toBe('Alpha');
    expect(localStorage.getItem(KEY)).toBe('1');
    expect(localStorage.getItem('muster.sidebarCollapsed.v1:ws-b:workspaces')).toBe('0');
  });
  it('默认展开：全行 is-open，按钮 aria-expanded=true', async () => {
    seedWorkspaces(THREE, 'ws-a');
    renderStack();
    await screen.findByTitle(/Alpha/);

    const rows = stackRows();
    expect(rows.length).toBe(3);
    for (const row of rows) expect(row.className).toContain('is-open');
    expect(collapseBtn().getAttribute('aria-expanded')).toBe('true');
    expect(collapseBtn().className).not.toContain('is-collapsed');
  });

  it('点按折叠：当前工作区行置顶并保持展开，其余行按深度垫在后头；偏好写 localStorage', async () => {
    const user = userEvent.setup();
    seedWorkspaces(THREE, 'ws-b');
    renderStack();
    await screen.findByTitle(/Beta/);

    await user.click(collapseBtn());

    const rows = stackRows();
    // 置顶：当前工作区 Beta 的行排第一（头像按钮 title 以区名开头）
    const faceTitle = rows[0].querySelector('.agent-float-avatar')?.getAttribute('title') ?? '';
    expect(faceTitle.startsWith('Beta')).toBe(true);
    expect(rows[0].className).toContain('is-open');
    // 其余行收进堆叠：携带递增堆叠深度（CSS 据此缩小下移垫在后头）；
    // rest 手风琴同步收拢（管容器高度，钉底栈整体 glide）
    expect(document.querySelector('.agent-ws-stack-rest')?.className).not.toContain('is-open');
    const stacked = rows.slice(1);
    expect(stacked.length).toBe(2);
    expect(stacked[0].style.getPropertyValue('--ws-depth')).toBe('1');
    expect(stacked[1].style.getPropertyValue('--ws-depth')).toBe('2');
    for (const row of stacked) {
      expect(row.className).not.toContain('is-open');
      expect(row.getAttribute('aria-hidden')).toBe('true');
      expect(row.hasAttribute('inert')).toBe(true);
    }
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles/float.css'), 'utf8');
    // 2026-10-26 起后排直接堆叠真实胶囊（保留内容），重叠期间强制实底防止透出后排文字
    expect(css).not.toMatch(/\.agent-ws-stack\.is-collapsed[^{}]*\.agent-ws-stack-row > \*\s*\{\s*opacity:\s*0/);
    expect(css).toMatch(/\.agent-ws-stack:is\(\.is-collapsed, \.is-stack-animating\) \.agent-notify-bubble\s*\{\s*background:\s*rgb\(from var\(--surface-overlay\) r g b\)/);
    expect(css).toMatch(/\.left-ws-slot \.agent-ws-stack:is\(\.is-collapsed, \.is-stack-animating\) \.agent-notify-bubble\s*\{\s*background:\s*rgb\(from var\(--surface-frame\) r g b\)/);
    // 按钮态与持久化
    expect(collapseBtn().getAttribute('aria-expanded')).toBe('false');
    expect(localStorage.getItem('muster.sidebarCollapsed.v1:ws-b:workspaces')).toBe('1');

    // 再点展开：全行恢复、深度标记清空、手风琴张开
    await user.click(collapseBtn());
    await waitFor(() => {
      expect(document.querySelector('.agent-ws-stack-rest')?.className).toContain('is-open');
      // 深度是每行固定的堆叠序号，展开后保留，展开动画从同一深度反向滑回
      stackRows().forEach((row, index) => {
        expect(row.className).toContain('is-open');
        expect(row.hasAttribute('aria-hidden')).toBe(false);
        expect(row.hasAttribute('inert')).toBe(false);
        expect(row.style.getPropertyValue('--ws-depth')).toBe(String(index));
      });
    });
    expect(localStorage.getItem('muster.sidebarCollapsed.v1:ws-b:workspaces')).toBe('0');
  });

  it('折叠：超过可见层数（>3）的行完全隐藏（is-stack-buried），前 3 层正常堆叠', async () => {
    const user = userEvent.setup();
    seedWorkspaces(FIVE, 'ws-a');
    renderStack();
    await screen.findByTitle(/Alpha/);

    await user.click(collapseBtn());

    const rows = stackRows();
    expect(rows.length).toBe(5);
    for (let i = 1; i <= 3; i++) {
      expect(rows[i].className).not.toContain('is-stack-buried');
      expect(rows[i].style.getPropertyValue('--ws-depth')).toBe(String(i));
    }
    expect(rows[4].className).toContain('is-stack-buried');
    expect(rows[4].style.getPropertyValue('--ws-depth')).toBe('4');
  });

  it('折叠偏好重启恢复：localStorage=1 时挂载即折叠', async () => {
    localStorage.setItem(KEY, '1');
    seedWorkspaces(THREE, 'ws-a');
    renderStack();
    await screen.findByTitle(/Alpha/);

    const rows = stackRows();
    expect(rows[0].className).toContain('is-open');
    expect(rows[0].textContent).toContain('Alpha');
    for (const row of rows.slice(1)) expect(row.className).not.toContain('is-open');
    expect(collapseBtn().getAttribute('aria-expanded')).toBe('false');
  });

  it('单工作区：不渲染折叠钮（无堆叠可言）', async () => {
    seedWorkspaces([ws('ws-only', 'Only')], 'ws-only');
    renderStack();
    await screen.findByTitle(/Only/);

    expect(document.querySelector('.agent-ws-collapse-btn')).toBeNull();
    expect(stackRows().length).toBe(1);
  });

  it('展开静止态：无动画窗口标记，is-active-row 按真实激活工作区标记（防首行冒领投影）', async () => {
    seedWorkspaces(THREE, 'ws-b');
    renderStack();
    await screen.findByTitle(/Beta/);

    const stack = document.querySelector('.agent-ws-stack:not(.agent-ws-stack-ghost)')!;
    expect(stack.className).not.toContain('is-stack-animating');
    // 展开序=原序：首行 Alpha 不是激活行，中间的 Beta 才是。首行若按位置冒领
    // is-active-row（z-20），其 shadow-pop 会压到下一颗胶囊顶缘——展开态「内阴影」
    const rows = stackRows();
    expect(rows[0].textContent).toContain('Alpha');
    expect(rows[0].className).not.toContain('is-active-row');
    expect(rows[1].textContent).toContain('Beta');
    expect(rows[1].className).toContain('is-active-row');

    // 折叠态不受影响：激活行重排置顶后仍带 is-active-row
    fireEvent.click(collapseBtn());
    expect(stackRows()[0].textContent).toContain('Beta');
    expect(stackRows()[0].className).toContain('is-active-row');
  });

  it('折叠几何守卫：实际行高和飞行位移共用 --ws-row-h', () => {
    // jsdom 无布局，守住共用 token；真实位置由 workspace-reorder-visual 校验。
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles/float.css'), 'utf8');
    expect(css).toMatch(/--ws-bubble-h:\s*var\(--ws-row-h\);/);
  });

  it('折叠几何守卫：rest 手风琴列轨必须显式钉宽（防 auto 轨按内容撑出槽位）', () => {
    // 0fr 手风琴只约束高度；隐式 auto 列轨按内容 max-content 收宽，长名工作区
    // 会把 rest-body 撑出槽位、行随 width:100% 溢出被面板裁断（2026-09-20 事故）
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles/float.css'), 'utf8');
    const restBlock = css.match(/\.agent-ws-stack-rest\s*\{[^}]*\}/)?.[0];
    expect(restBlock).toBeTruthy();
    expect(restBlock).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it('栈头按钮显隐守卫：悬浮只认栈头自身；排序手势藏按钮不退布局（防点击行栈头下沉闪动）', () => {
    // 2026-10-31 报单：①悬浮任意工作区行不得带出折叠/新建按钮——显形作用域必须与
    // 工作会话/终端标题带一致（只认标题行自身 :hover/:focus-within），不得挂整栈 :hover；
    // ②长按排序在每次 pointerdown 行时即挂 data-sort-pressing，若用 display:none 藏
    // 栈头按钮（28px > min-height 22px），栈头高度塌 6px——点一下行表头就「下沉又弹回」。
    // jsdom 测不到 :hover/布局，此处做静态闸：把两处修复还原回旧写法即转红。
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles/float.css'), 'utf8');
    expect(css).not.toMatch(/\.agent-ws-stack:hover \.agent-ws-stack-header \.agent-ws-(?:collapse|add)-btn/);
    expect(css).toMatch(/\.agent-ws-stack-header:hover \.agent-ws-collapse-btn/);
    expect(css).toMatch(/\.agent-ws-stack-header:focus-within \.agent-ws-add-btn/);
    const gestureHide = css.match(/\.agent-ws-stack:has\(\[data-sort-pressing="true"\]\)[^{]*\{([^}]*)\}/)?.[1];
    expect(gestureHide).toBeTruthy();
    expect(gestureHide).toMatch(/visibility:\s*hidden/);
    expect(gestureHide).not.toMatch(/display:\s*none/);
  });

  it('切换动画窗口：点按挂 is-stack-animating，panelMs+级联延迟收窗，连点重置（防瞬时滚动条）', async () => {
    seedWorkspaces(FIVE, 'ws-a');
    renderStack();
    await screen.findByTitle(/Alpha/);

    vi.useFakeTimers();
    try {
      const stack = document.querySelector('.agent-ws-stack:not(.agent-ws-stack-ghost)')!;
      // 5 个工作区的窗口 = panelMs(280) + 最深一层延迟 (5-2)*30 = 370ms
      const windowMs = MOTION.panelMs + (FIVE.length - 2) * 30;

      fireEvent.click(collapseBtn());
      expect(stack.className).toContain('is-collapsed');
      expect(stack.className).toContain('is-stack-animating');
      act(() => {
        vi.advanceTimersByTime(windowMs - 1);
      });
      expect(stack.className).toContain('is-stack-animating');
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(stack.className).not.toContain('is-stack-animating');

      // 连点：窗口内再次切换即重置计时（transition 被打断重走，窗口跟着重开）
      fireEvent.click(collapseBtn());
      expect(stack.className).toContain('is-stack-animating');
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(stack.className).toContain('is-stack-animating');
      fireEvent.click(collapseBtn());
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(stack.className).toContain('is-stack-animating');
      act(() => {
        vi.advanceTimersByTime(windowMs - 200);
      });
      expect(stack.className).not.toContain('is-stack-animating');
    } finally {
      vi.useRealTimers();
    }
  });
});
