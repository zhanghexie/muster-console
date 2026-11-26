/**
 * 壳层确认框全链路（StoreProvider + i18n + usePresence + window.api mock）：
 * ui:confirm 事件 → 弹窗渲染；点取消/确认 → confirmRespond 正确回传；
 * 请求出队后经退场动画卸载。这是「新 UI 改动该往哪补测试」的样板。
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StoreProvider, useUiStore } from '../../src/renderer/src/store';
import { ConfirmDialog } from '../../src/renderer/src/components/ConfirmDialog';
import { MOTION } from '../../src/renderer/src/components/motion';
import { closeTopOverlay } from '../../src/renderer/src/keybindings/overlayStack';
import { currentApiMock } from './helpers/api-mock';
import type { ConfirmRequest } from '../../src/shared/types';

const REQ: ConfirmRequest = {
  requestId: 'req-e2e-1',
  title: 'Agent 请求执行：demo.tool',
  detail: '{"path":"src/index.ts"}'
} as ConfirmRequest;

const DANGEROUS: ConfirmRequest = {
  requestId: 'req-danger-1',
  title: 'metaagent-workbench · 调度',
  subtitle: '调度 · sessions.integrate',
  intent: '把隔离 worktree 合入主分支',
  summary: '把「T3.4」合入 main',
  confirmNote: '合入 T3.4 到 main（journal 冲突已解）',
  toolDescription: '调度在验收通过后调用',
  detail: '{"sessionId":"abc"}',
  dangerous: true,
  confirmLabel: '确认合入'
} as ConfirmRequest;

/** ConfirmDialog 的 request 由 App 从 store confirms 驱动——测试同样走真实链路 */
function Harness() {
  const { confirms } = useUiStore();
  return <ConfirmDialog request={confirms[confirms.length - 1] ?? null} />;
}

async function renderApp() {
  // StoreProvider 首挂会异步拉取工作区、运行时等数据；等 hydration 提交后再推送 IPC。
  await act(async () => {
    render(
      <StoreProvider>
        <Harness />
      </StoreProvider>
    );
  });
}

function emitConfirm(request: ConfirmRequest) {
  act(() => currentApiMock().emit('ui:confirm', request));
}

function closeConfirm(requestId: string) {
  act(() => currentApiMock().emit('ui:confirmClosed', { requestId }));
}

describe('ConfirmDialog 危险操作确认门（组件级）', () => {
  it('可见确认框切换队列请求时将焦点从旧批准按钮退回取消', async () => {
    const user = userEvent.setup();
    await renderApp();
    emitConfirm(REQ);
    const cancel = await screen.findByRole('button', { name: '取消' });
    expect(document.activeElement).toBe(cancel);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '确认执行' }));

    emitConfirm({ ...REQ, requestId: 'req-next', title: '下一个审批' });
    expect(document.activeElement).toBe(cancel);
    await user.keyboard('{Enter}');
    expect(currentApiMock().mockOf('confirmRespond').mock.calls).toEqual([['req-next', false, 'button']]);
  });

  it('桌面截图加载失败不能批准，新请求须等待自己的截图加载', async () => {
    const user = userEvent.setup();
    await renderApp();
    const evidence = { dataUrl: 'data:image/png;base64,fixture', region: { x: 1, y: 2, width: 30, height: 40 } };
    emitConfirm({ ...REQ, requestId: 'evidence-one', desktopEvidence: evidence });
    const image = await screen.findByRole('img', { name: '操作区域截图' });
    const approve = screen.getByRole('button', { name: '确认执行' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.error(image);
    expect(screen.getByText('截图无法显示，无法批准')).toBeTruthy();
    expect(approve.disabled).toBe(true);
    fireEvent.load(image);
    expect(approve.disabled).toBe(false);
    emitConfirm({ ...REQ, requestId: 'evidence-two', title: '第二次确认', desktopEvidence: evidence });
    await screen.findByText('第二次确认');
    expect((screen.getByRole('button', { name: '确认执行' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.load(screen.getByRole('img', { name: '操作区域截图' }));
    await user.click(screen.getByRole('button', { name: '确认执行' }));
    expect(currentApiMock().mockOf('confirmRespond').mock.calls).toEqual([['evidence-two', true, undefined]]);
  });
  it('主进程关闭旧请求只移除对应项，迟到关闭不影响新的确认', async () => {
    const user = userEvent.setup();
    await renderApp();
    const next = { ...REQ, requestId: 'req-new', title: '新的审批' };
    emitConfirm(REQ);
    await screen.findByRole('dialog');
    emitConfirm(next);
    await screen.findByText('新的审批');
    closeConfirm(REQ.requestId);
    expect(screen.getByText('新的审批')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '确认执行' }));
    expect(currentApiMock().mockOf('confirmRespond').mock.calls).toEqual([
      ['req-new', true, undefined]
    ]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('主进程取消后退场中的旧按钮不能再提交批准', async () => {
    await renderApp();
    emitConfirm(REQ);
    await screen.findByRole('dialog');
    const approve = screen.getByRole('button', { name: '确认执行' });
    // 同一次 act 批处理内，IPC 先取消、旧按钮再点击；不等 React 提交退场。
    act(() => {
      currentApiMock().emit('ui:confirmClosed', { requestId: REQ.requestId });
      fireEvent.click(approve);
    });
    expect(currentApiMock().mockOf('confirmRespond').mock.calls).toHaveLength(0);
    await waitFor(() => expect(screen.getByTestId('confirm-mask').dataset.mpStage).toBe('out'));
    fireEvent.click(approve);
    expect(currentApiMock().mockOf('confirmRespond').mock.calls).toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('v3 扩展人工审核显示确认原因，并保留范围、源码与指纹', async () => {
    await renderApp();
    emitConfirm({
      ...REQ,
      confirmNote: '审批服务暂不可用，请核对本次扩展权限后决定。',
      title: '审核扩展：测试扩展',
      detail: '范围：global\n源码：/workspace/extension\n整包指纹：package-v3:123'
    });
    await screen.findByRole('dialog');
    expect(screen.getByText('审批服务暂不可用，请核对本次扩展权限后决定。')).toBeTruthy();
    expect(screen.getByText(/整包指纹：package-v3:123/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '确认执行' })).toBeTruthy();
  });

  it('ui:confirm 推送 → 渲染标题与按钮；取消 → confirmRespond(id,false,button) 并退场卸载', async () => {
    const user = userEvent.setup();
    await renderApp();

    expect(screen.queryByRole('dialog')).toBeNull();

    emitConfirm(REQ);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Agent 请求执行：demo.tool')).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '确认执行' })).toBeTruthy();
    expect(screen.getByText('{"path":"src/index.ts"}')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '取消' }));

    const call = currentApiMock().mockOf('confirmRespond').mock.calls[0];
    expect(call).toEqual(['req-e2e-1', false, 'button']);

    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).toBeNull();
      },
      { timeout: MOTION.exitMs + 2000 }
    );
  });

  it('确认执行 → confirmRespond(id,true)', async () => {
    const user = userEvent.setup();
    await renderApp();

    emitConfirm(REQ);
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('button', { name: '确认执行' }));
    const call = currentApiMock().mockOf('confirmRespond').mock.calls[0];
    expect(call).toEqual(['req-e2e-1', true, undefined]);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('点遮罩不关闭危险确认框', async () => {
    await renderApp();
    emitConfirm(DANGEROUS);
    await screen.findByRole('dialog');
    expect(screen.getByText('把「T3.4」合入 main')).toBeTruthy();
    expect(screen.getByText('合入 T3.4 到 main（journal 冲突已解）')).toBeTruthy();
    expect(screen.getByRole('button', { name: '确认合入' })).toBeTruthy();

    fireEvent.mouseDown(screen.getByTestId('confirm-mask'));
    expect(currentApiMock().mockOf('confirmRespond').mock.calls).toHaveLength(0);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('危险确认 Esc（overlay.close）→ cancelledBy esc，框仍可关', async () => {
    await renderApp();
    emitConfirm(DANGEROUS);
    await screen.findByRole('dialog');
    act(() => closeTopOverlay());
    expect(currentApiMock().mockOf('confirmRespond').mock.calls[0]).toEqual([
      'req-danger-1',
      false,
      'esc'
    ]);
  });

  it('非危险确认点遮罩 → cancelledBy backdrop', async () => {
    await renderApp();
    emitConfirm(REQ);
    await screen.findByRole('dialog');
    fireEvent.mouseDown(screen.getByTestId('confirm-mask'));
    expect(currentApiMock().mockOf('confirmRespond').mock.calls[0]).toEqual([
      'req-e2e-1',
      false,
      'backdrop'
    ]);
  });

  it('批量删除确认框列出会话名与最后活跃时间，不甩裸 UUID', async () => {
    await renderApp();
    emitConfirm({
      requestId: 'req-close-batch',
      title: 'metaagent-workbench · 调度',
      subtitle: '调度 · sessions.delete',
      intent: '批量永久删除已归档会话（一次确认，列出名称与最后活跃）',
      summary: '将永久删除 2 个已归档会话：\n· 优化危险工具确认门 · 2小时前\n· 外观页头像 · 1天前',
      detail: '{"sessionIds":["43e7b2bd-1111-4222-8333-444444444444","bbbbbbbb-1111-4222-8333-555555555555"]}',
      dangerous: true,
      confirmLabel: '确认删除'
    } as ConfirmRequest);
    await screen.findByRole('dialog');
    const summary = document.querySelector('.confirm-summary');
    expect(summary?.textContent).toMatch(/优化危险工具确认门 · 2小时前/);
    expect(summary?.textContent).toMatch(/外观页头像 · 1天前/);
    expect(summary?.textContent).not.toMatch(/43e7b2bd-1111/);
    expect(screen.getByRole('button', { name: '确认删除' })).toBeTruthy();
  });

  it('sessions.review 通过并合入：intent/summary/按钮跟本次 decision，不列 catalog 枚举', async () => {
    await renderApp();
    emitConfirm({
      requestId: 'req-review-passed',
      title: 'metaagent-workbench · 调度',
      subtitle: '调度 · sessions.review',
      intent: '验收通过「修确认弹窗摘要」并合入 main',
      summary:
        '验收通过「修确认弹窗摘要」：将合入 main 并结任务 done\n隔离树: E:/ws/.worktrees/68d48aae\n隔离分支: ao/68d48aae\n备注：合入说明已写清',
      confirmNote: undefined,
      toolDescription: '人机同权的验收动作',
      detail: '{"sessionId":"68d48aae-968c-4d71-9d1c-e87b34b92532","decision":"passed"}',
      dangerous: true,
      confirmLabel: '确认通过并合入'
    } as ConfirmRequest);
    await screen.findByRole('dialog');
    expect(screen.getByText('验收通过「修确认弹窗摘要」并合入 main')).toBeTruthy();
    const summary = document.querySelector('.confirm-summary');
    expect(summary?.textContent).toMatch(/将合入 main 并结任务 done/);
    expect(summary?.textContent).toMatch(/隔离树:/);
    expect(summary?.textContent).toMatch(/备注：合入说明已写清/);
    expect(summary?.textContent).not.toMatch(/待验收：通过 \/ 打回/);
    expect(summary?.textContent).not.toMatch(/68d48aae-968c-4d71/);
    expect(screen.getByRole('button', { name: '确认通过并合入' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '确认执行' })).toBeNull();
  });

  it('sessions.review 打回：按钮与意图随 decision 变', async () => {
    await renderApp();
    emitConfirm({
      requestId: 'req-review-rejected',
      title: 'metaagent-workbench · 调度',
      subtitle: '调度 · sessions.review',
      intent: '打回「修确认弹窗摘要」重做',
      summary: '打回「修确认弹窗摘要」重做：将回注打回说明并让任务回到进行中\n备注：缺回归测试',
      dangerous: true,
      confirmLabel: '确认打回重做'
    } as ConfirmRequest);
    await screen.findByRole('dialog');
    expect(screen.getByText('打回「修确认弹窗摘要」重做')).toBeTruthy();
    expect(document.querySelector('.confirm-summary')?.textContent).toMatch(/回注打回说明/);
    expect(screen.getByRole('button', { name: '确认打回重做' })).toBeTruthy();
  });

  it('危险确认点 × → cancelledBy close', async () => {
    const user = userEvent.setup();
    await renderApp();
    emitConfirm(DANGEROUS);
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: '关闭' }));
    expect(currentApiMock().mockOf('confirmRespond').mock.calls[0]).toEqual([
      'req-danger-1',
      false,
      'close'
    ]);
  });
});
