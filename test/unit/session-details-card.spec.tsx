import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionDetailsCard } from '../../src/renderer/src/components/SessionDetailsCard';
import type { SessionMeta } from '../../src/shared/types';

const session: SessionMeta = { id: 'hover-session', name: '悬浮详情', type: 'terminal', launchKind: 'agent',
  workspaceId: 'ws', createdAt: 1, status: 'running', lifecycle: 'idle' };

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
/** 只移除用例自建的夹具节点，别动 React 管理的 portal 子树 */
const mountFixture = (tag = 'div'): HTMLElement => {
  const el = document.createElement(tag);
  el.dataset.specFixture = '';
  document.body.appendChild(el);
  return el;
};

it('dismisses the details when its source page slides away', async () => {
  const page = mountFixture();
  page.dataset.hPage = 'terminal';
  const anchor = document.createElement('button');
  page.appendChild(anchor);
  const onClose = vi.fn();
  render(<SessionDetailsCard target={{ id: session.id, anchor }} session={session} runtime="Cursor" stateLabel="空闲" onClose={onClose} />);
  expect(screen.getByRole('dialog', { name: '会话详情' })).toBeTruthy();
  await act(async () => { page.dataset.hPeek = ''; });
  expect(onClose).toHaveBeenCalledOnce();
});
afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('[data-spec-fixture]').forEach(el => el.remove());
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

it('两个会话标识均可复制，卡片内部点击不关闭，成功后显示反馈', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const onClose = vi.fn();
  const anchor = mountFixture();
  render(<SessionDetailsCard target={{ id: session.id, anchor }} session={{ ...session, externalSessionId: 'runtime-session-id' }}
    runtime="Cursor" stateLabel="空闲" onClose={onClose} />);
  const button = screen.getByRole('button', { name: /^复制会话标识$/ });
  fireEvent.mouseDown(button);
  fireEvent.click(button);
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('hover-session'));
  expect(screen.getByRole('status').textContent).toBe('已复制');
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '复制运行时会话标识' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('runtime-session-id'));
  fireEvent.mouseDown(document.body);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('复制失败明确反馈，不显示已复制', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  const anchor = mountFixture();
  render(<SessionDetailsCard target={{ id: session.id, anchor }} session={session} runtime="Cursor" stateLabel="空闲" onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '复制会话标识' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('复制失败'));
});

it('详情卡从右侧放不下时向左避让，并限制在视口上下边界内', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const card = this.classList.contains('session-details-card');
    return { left: card ? 0 : 900, right: card ? 344 : 1000, top: card ? 0 : 700,
      bottom: card ? 300 : 738, width: card ? 344 : 100, height: card ? 300 : 38,
      x: 0, y: 0, toJSON: () => ({}) };
  });
  const anchor = mountFixture();
  const { container } = render(<SessionDetailsCard target={{ id: session.id, anchor }} session={session}
    runtime="Cursor" stateLabel="空闲" onClose={() => {}} />);
  const card = screen.getByRole('dialog', { name: '会话详情' });
  expect(container.contains(card)).toBe(false);
  expect(Number.parseFloat(card.style.left)).toBe(548);
  expect(Number.parseFloat(card.style.top)).toBeLessThanOrEqual(window.innerHeight - 308);
});

it('悬停捕获的 anchor 被重建脱接后，按会话 id 回查当前行定位（拦截左上角钉死 bug）', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('session-details-card')) {
      return { left: 0, right: 344, top: 0, bottom: 300, width: 344, height: 300, x: 0, y: 0, toJSON: () => ({}) };
    }
    if (this.dataset.sessionRow === session.id) {
      return { left: 0, right: 578, top: 700, bottom: 738, width: 578, height: 38, x: 0, y: 0, toJSON: () => ({}) };
    }
    return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
  });
  const stale = document.createElement('div'); // 未挂载：模拟 400ms 延迟内行被 React 重建
  const row = mountFixture();
  row.dataset.sessionRow = session.id;
  const onClose = vi.fn();
  render(<SessionDetailsCard target={{ id: session.id, anchor: stale }} session={session}
    runtime="Cursor" stateLabel="空闲" onClose={onClose} />);
  const card = screen.getByRole('dialog', { name: '会话详情' });
  expect(Number.parseFloat(card.style.left)).toBe(586); // 行右缘 578 + 8，右侧放得下
  expect(Number.parseFloat(card.style.top)).toBe(window.innerHeight - 308); // 700 被视口下界钳制
  expect(onClose).not.toHaveBeenCalled();
});

it('anchor 脱接且行已不存在时不渲染卡片并关闭，不按原点兜底闪现', () => {
  const stale = document.createElement('div');
  const onClose = vi.fn();
  render(<SessionDetailsCard target={{ id: session.id, anchor: stale }} session={session}
    runtime="Cursor" stateLabel="空闲" onClose={onClose} />);
  expect(screen.queryByRole('dialog', { name: '会话详情' })).toBeNull();
  // presence 阶段翻转可能重复触发，只要求已请求关闭（宿主 close 幂等）
  expect(onClose).toHaveBeenCalled();
});

it('无关面板的滚动（如转写自动贴底）不关闭详情卡', () => {
  const anchor = mountFixture();
  const transcript = mountFixture(); // 独立滚动容器，不含 anchor
  const onClose = vi.fn();
  render(<SessionDetailsCard target={{ id: session.id, anchor }} session={session}
    runtime="Cursor" stateLabel="空闲" onClose={onClose} />);
  transcript.dispatchEvent(new Event('scroll'));
  expect(onClose).not.toHaveBeenCalled();
});

it('anchor 所在容器滚动（会话列表滚动）会关闭详情卡', () => {
  const list = mountFixture();
  const anchor = list.appendChild(document.createElement('div'));
  const onClose = vi.fn();
  render(<SessionDetailsCard target={{ id: session.id, anchor }} session={session}
    runtime="Cursor" stateLabel="空闲" onClose={onClose} />);
  list.dispatchEvent(new Event('scroll'));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('会话内容变化会更新详情，缺省字段不展示空行', () => {
  const anchor = mountFixture();
  const close = (): void => {};
  const target = { id: session.id, anchor };
  const { rerender } = render(<SessionDetailsCard target={target} session={session} runtime="Cursor" stateLabel="空闲" onClose={close} />);
  expect(screen.queryByText('分支')).toBeNull();
  rerender(<SessionDetailsCard target={target} session={{ ...session, liveStatus: { label: '等验收', summary: '修改已经完成。', ts: 2 } }}
    runtime="Cursor" stateLabel="需要你" onClose={close} />);
  expect(screen.getByText('修改已经完成。')).toBeTruthy();
  expect(screen.getByText('需要你')).toBeTruthy();
  expect(screen.getByText('需要你').closest('.status-badge.session-capsule')).toBeTruthy();
  expect(screen.getByText('需要你').closest('.session-details-header')).toBe(screen.getByText('悬浮详情').closest('.session-details-header'));
});

it('运行时字段展示当前 Harness 图标和名称，并随会话变化更新', () => {
  const anchor = mountFixture();
  const target = { id: session.id, anchor };
  const close = (): void => {};
  const { rerender } = render(<SessionDetailsCard target={target}
    session={{ ...session, runtime: 'acp', piModeId: 'kimi' }} runtime="ACP" stateLabel="空闲" onClose={close} />);
  const runtimeField = () => screen.getByText('运行时').nextElementSibling!;
  expect(runtimeField().textContent).toBe('Kimi Code');
  expect(runtimeField().querySelector('img.session-details-harness-icon')?.getAttribute('src')).toContain('kimi');
  rerender(<SessionDetailsCard target={target} session={{ ...session, runtime: 'codex-gui' }}
    runtime="Codex" stateLabel="空闲" onClose={close} />);
  expect(runtimeField().textContent).toBe('Codex');
  expect(runtimeField().querySelector('.session-details-harness-icon[style*="mask"]')).toBeTruthy();
  rerender(<SessionDetailsCard target={target} session={session} runtime="Cursor" stateLabel="空闲" onClose={close} />);
  expect(runtimeField().textContent).toBe('Cursor');
  expect(runtimeField().querySelector('.session-details-harness-icon')).toBeNull();
});
