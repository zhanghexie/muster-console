import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { AgentFloat } from '../../src/renderer/src/panels/AgentFloat';
import { StoreProvider, useUiActionsStore } from '../../src/renderer/src/store';
import { getDraft } from '../../src/renderer/src/composerDrafts';
import { resetOrchestratorListenersForTest } from '../../src/renderer/src/chatSurface/orchestratorSurface';
import { currentApiMock } from './helpers/api-mock';
import type { WorkspaceInfo } from '../../src/shared/types';

const ALPHA: WorkspaceInfo = { id: 'overview-alpha', name: 'Alpha', path: '/example/alpha', openedAt: 1 };
const BETA: WorkspaceInfo = { id: 'overview-beta', name: 'Beta', path: '/example/beta', openedAt: 2 };

function TestWorkbench({ inline }: { inline: boolean }): React.JSX.Element {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const { requestComposerInsert } = useUiActionsStore();
  return (
    <>
      <div ref={setSlot} className="left-ws-slot" />
      <AgentFloat stackInline={inline} wsStackSlot={slot} />
      <button type="button" onClick={() => requestComposerInsert('划词内容')}>插入选区</button>
    </>
  );
}

async function renderWorkbench(workspaces = [ALPHA, BETA], inline = false): Promise<HTMLElement> {
  resetOrchestratorListenersForTest();
  const mock = currentApiMock();
  const initial = { workspaces, activeWorkspaceId: workspaces[0].id };
  mock.override('workspaces.list', () => Promise.resolve(initial));
  mock.override('config.get', () => Promise.resolve({ ...initial, locale: 'zh-CN' }));
  mock.override('chat.send', () => Promise.resolve({ accepted: true }));
  render(<StoreProvider><KeybindingProvider><TestWorkbench inline={inline} /></KeybindingProvider></StoreProvider>);
  return screen.findByRole('button', { name: '展开并排对话' });
}

function columns(): HTMLElement[] {
  return within(screen.getByRole('dialog', { name: '工作区对话' })).getAllByRole('region', { name: /^(Alpha|Beta)$/ });
}

function editor(parent: ParentNode): HTMLElement {
  const element = parent.querySelector<HTMLElement>('[contenteditable="true"]');
  expect(element).toBeTruthy();
  return element!;
}

function type(editor: HTMLElement, value: string): void {
  editor.textContent = value;
  fireEvent.input(editor);
}

describe('调度并排对话', () => {
  beforeEach(() => {
    localStorage.removeItem('muster.schedulerOverviewSizes.v1');
    localStorage.removeItem('muster.schedulerOverviewStatuses.v1');
  });

  it('悬停选状态，按颜色筛选并保留被隐藏列的草稿和编辑器', async () => {
    const trigger = await renderWorkbench();
    fireEvent.click(trigger);
    const overview = screen.getByRole('dialog', { name: '工作区对话' });
    const [alpha, beta] = columns();
    const betaEditor = editor(beta);
    type(betaEditor, '过滤时保留的草稿');
    const status = within(alpha).getByRole('button', { name: '更改面板状态（未标记）' });
    fireEvent.pointerEnter(status, { pointerType: 'mouse' });
    const palette = within(alpha).getByRole('group', { name: '选择面板状态' });
    fireEvent.click(within(palette).getByRole('button', { name: '进行中' }));
    expect(within(alpha).getByRole('button', { name: '更改面板状态（进行中）' })).toBe(status);

    const filter = within(overview).getByRole('button', { name: '按状态筛选' });
    fireEvent.click(filter);
    const menu = within(overview).getByRole('group', { name: '按状态筛选' });
    fireEvent.click(within(menu).getByRole('checkbox', { name: '未标记' }));
    expect(columns()).toEqual([alpha]);
    fireEvent.click(within(menu).getByRole('checkbox', { name: '进行中' }));
    expect(within(overview).getByText('没有符合筛选条件的面板')).toBeTruthy();
    fireEvent.click(within(menu).getByRole('checkbox', { name: '显示全部状态' }));
    expect(columns()).toEqual([alpha, beta]);
    expect(editor(beta)).toBe(betaEditor);
    expect(betaEditor.textContent).toBe('过滤时保留的草稿');

    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(filter.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('dialog', { name: '工作区对话' })).toBe(overview);
  });

  it('在筛选弹层直接添加、重命名、删除状态，按工作区记住选中的状态', async () => {
    const trigger = await renderWorkbench();
    fireEvent.click(trigger);
    const dialog = () => screen.getByRole('dialog', { name: '工作区对话' });
    const filter = () => within(dialog()).getByRole('button', { name: '按状态筛选' });
    fireEvent.click(filter());
    fireEvent.click(within(dialog()).getByRole('button', { name: '新增状态' }));
    fireEvent.change(within(dialog()).getByRole('textbox', { name: '状态名称' }), { target: { value: '等待评审' } });
    fireEvent.click(within(dialog()).getByRole('radio', { name: '紫色' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: '保存' }));
    expect(within(dialog()).getByRole('checkbox', { name: '等待评审' })).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: '编辑状态 等待评审' }));
    fireEvent.change(within(dialog()).getByRole('textbox', { name: '状态名称' }), { target: { value: '评审中' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: '保存' }));
    fireEvent.click(filter());

    const [alpha] = columns();
    fireEvent.click(within(alpha).getByRole('button', { name: '更改面板状态（未标记）' }));
    fireEvent.click(within(alpha).getByRole('button', { name: '评审中' }));
    const oldDialog = dialog();
    fireEvent.click(within(oldDialog).getByRole('button', { name: '收起并排对话' }));
    await waitFor(() => expect(oldDialog.isConnected).toBe(false));
    fireEvent.click(trigger);
    expect(within(columns()[0]).getByRole('button', { name: '更改面板状态（评审中）' })).toBeTruthy();

    fireEvent.click(filter());
    fireEvent.click(within(dialog()).getByRole('button', { name: '编辑状态 评审中' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: '删除状态' }));
    expect(within(dialog()).queryByRole('checkbox', { name: '评审中' })).toBeNull();
    expect(within(columns()[0]).getByRole('button', { name: '更改面板状态（未标记）' })).toBeTruthy();
  });

  it('从停靠栈头展开折叠列表里的全部工作区，退场中可反转，Esc 后归还焦点', async () => {
    const trigger = await renderWorkbench();
    const stack = trigger.closest('.agent-ws-stack')!;
    expect(trigger.nextElementSibling?.getAttribute('title')).toBe('新建工作区');
    fireEvent.click(stack.querySelector('.agent-ws-collapse-btn')!);
    expect(stack.classList.contains('is-collapsed')).toBe(true);
    fireEvent.click(trigger);
    const overview = screen.getByRole('dialog', { name: '工作区对话' });
    expect(columns().map(column => column.getAttribute('aria-label'))).toEqual(['Alpha', 'Beta']);
    expect(columns().every(column => column.matches('.mp-panel[data-mp-stage="in"]'))).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(overview.id);
    expect(currentApiMock().mockOf('chat.send')).not.toHaveBeenCalled();
    expect(currentApiMock().mockOf('workspaces.switch')).not.toHaveBeenCalled();

    const collapse = within(overview).getByRole('button', { name: '收起并排对话' });
    expect(document.activeElement).toBe(collapse);
    const betaEditor = editor(columns()[1]);
    fireEvent.click(collapse);
    expect(overview.getAttribute('data-mp-stage')).toBe('out');
    expect(betaEditor.closest('.mp-panel')?.getAttribute('data-mp-stage')).toBe('out');
    expect(overview.parentElement?.hasAttribute('inert')).toBe(true);
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: '工作区对话' })).toBe(overview);
    expect(editor(columns()[1])).toBe(betaEditor);

    fireEvent.keyDown(collapse, { key: 'Escape' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(overview.isConnected).toBe(false));
    expect(document.activeElement).toBe(trigger);
  });

  it('仅点击空白处收起，面板内交互、拖出面板和取消手势保持展开', async () => {
    const trigger = await renderWorkbench();
    await act(async () => { fireEvent.click(trigger); });
    const overview = screen.getByRole('dialog', { name: '工作区对话' });
    const track = overview.querySelector('.scheduler-overview-track')!;
    const card = columns()[0];
    const pointer = { button: 0, isPrimary: true };

    fireEvent.pointerDown(card, pointer);
    fireEvent.pointerUp(card, pointer);
    fireEvent.click(card);
    fireEvent.pointerDown(card, pointer);
    fireEvent.pointerUp(track, pointer);
    fireEvent.click(track);
    fireEvent.pointerDown(track, pointer);
    fireEvent.pointerUp(card, pointer);
    fireEvent.click(track);
    fireEvent.pointerDown(track, pointer);
    fireEvent.pointerCancel(track);
    fireEvent.click(track);
    expect(overview.getAttribute('data-mp-stage')).toBe('in');

    fireEvent.pointerDown(track, pointer);
    fireEvent.pointerUp(track, pointer);
    fireEvent.click(track);
    expect(overview.getAttribute('data-mp-stage')).toBe('out');
    await waitFor(() => expect(overview.isConnected).toBe(false));
    expect(document.activeElement).toBe(trigger);
  });

  it('两列同时编辑、投递与接收，各动作使用对应工作区', async () => {
    const trigger = await renderWorkbench();
    fireEvent.click(trigger);
    const [alpha, beta] = columns();
    const alphaEditor = editor(alpha);
    const betaEditor = editor(beta);
    type(alphaEditor, 'Alpha 草稿');
    type(betaEditor, 'Beta 草稿');

    fireEvent.click(screen.getByRole('button', { name: '插入选区' }));
    await waitFor(() => expect(getDraft(ALPHA.id)).toBe('Alpha 草稿\n划词内容'));
    expect(getDraft(BETA.id)).toBe('Beta 草稿');

    fireEvent.keyDown(betaEditor, { key: 'Enter' });
    fireEvent.keyDown(alphaEditor, { key: 'Enter' });
    const mock = currentApiMock();
    await waitFor(() => expect(mock.mockOf('chat.send').mock.calls).toEqual([
      ['Beta 草稿', BETA.id, undefined],
      ['Alpha 草稿\n划词内容', ALPHA.id, undefined]
    ]));
    expect(mock.mockOf('workspaces.switch')).not.toHaveBeenCalled();

    await act(async () => {
      for (const workspace of [ALPHA, BETA]) {
        const content = `${workspace.name} 的消息`;
        const message = { id: `${workspace.id}-reply`, role: 'assistant',
          content, parts: [{ kind: 'text', text: content }], createdAt: Date.now() };
        mock.emit('agent:message', { ...message, workspaceId: workspace.id });
        mock.emit('agent:done', { workspaceId: workspace.id, message });
      }
    });
    expect(await within(alpha).findByText('Alpha 的消息')).toBeTruthy();
    expect(await within(beta).findByText('Beta 的消息')).toBeTruthy();
    expect(within(alpha).queryByText('Beta 的消息')).toBeNull();
  });

  it('收起恢复先前单窗及其草稿，另一列草稿可从原工作区入口打开', async () => {
    const trigger = await renderWorkbench([ALPHA, BETA], true);
    const bubbles = document.querySelectorAll('.agent-notify-chat');
    fireEvent.click(bubbles[0]);
    const previousPanel = document.querySelector('.agent-float-panel')!;
    type(editor(previousPanel), '切换保留的草稿');

    fireEvent.click(trigger);
    expect(previousPanel.isConnected).toBe(false);
    expect(editor(columns()[0]).textContent).toBe('切换保留的草稿');
    type(editor(columns()[1]), '另一列草稿');
    expect(screen.queryByRole('button', { name: '打开单独对话' })).toBeNull();
    fireEvent.click(within(screen.getByRole('dialog', { name: '工作区对话' })).getByRole('button', { name: '收起并排对话' }));

    const singlePanel = () => document.querySelector('.agent-float-anchor > .agent-float-panel');
    await waitFor(() => expect(singlePanel()).not.toBeNull());
    expect(editor(singlePanel()!).textContent).toBe('切换保留的草稿');

    fireEvent.click(bubbles[1]);
    await waitFor(() => expect(within(singlePanel() as HTMLElement).getByText('Beta')).toBeTruthy());
    expect(editor(singlePanel()!).textContent).toBe('另一列草稿');
  });

  it('独立调整一列的宽高，整理后两列恢复默认且保持编辑器实例', async () => {
    const trigger = await renderWorkbench();
    await act(async () => { fireEvent.click(trigger); });
    const overview = screen.getByRole('dialog', { name: '工作区对话' });
    const [alpha, beta] = columns();
    const alphaSlot = alpha.closest<HTMLElement>('[data-scheduler-workspace]')!;
    const betaSlot = beta.closest<HTMLElement>('[data-scheduler-workspace]')!;
    const alphaEditor = editor(alpha);
    // jsdom 不做布局，模拟读取当前生效的像素尺寸。真实拖拽与裁边由 Electron 验收。
    Object.defineProperties(alphaSlot, {
      offsetWidth: { get: () => parseFloat(alphaSlot.style.getPropertyValue('--scheduler-resize-w') ||
        alphaSlot.style.getPropertyValue('--scheduler-panel-w')) || 448 },
      offsetHeight: { get: () => parseFloat(alphaSlot.style.getPropertyValue('--scheduler-resize-h') ||
        alphaSlot.style.getPropertyValue('--scheduler-panel-h')) || 660 }
    });
    const handle = within(alpha).getByRole('button', { name: /调整 Alpha 面板大小/ });
    const arrange = within(overview).getByRole<HTMLButtonElement>('button', { name: '整理' });
    expect(arrange.textContent).toBe('');
    expect(arrange.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(arrange.disabled).toBe(true);
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(alphaSlot.offsetWidth).toBeGreaterThan(448);
    expect(alphaSlot.offsetHeight).toBeLessThan(660);
    expect(betaSlot.style.getPropertyValue('--scheduler-panel-w')).toBe('');
    expect(betaSlot.style.getPropertyValue('--scheduler-panel-h')).toBe('');
    fireEvent.click(arrange);
    expect(alphaSlot.offsetWidth).toBe(448);
    expect(alphaSlot.offsetHeight).toBe(660);
    expect(editor(alpha)).toBe(alphaEditor);
    expect(arrange.disabled).toBe(true);
  });

  it('重新展开时按工作区恢复各自尺寸，只改过宽度的列仍使用默认高度', async () => {
    const trigger = await renderWorkbench();
    fireEvent.click(trigger);
    let overview = screen.getByRole('dialog', { name: '工作区对话' });
    const [alpha] = columns();
    const alphaSlot = alpha.closest<HTMLElement>('[data-scheduler-workspace]')!;
    Object.defineProperty(alphaSlot, 'offsetWidth', {
      get: () => parseFloat(alphaSlot.style.getPropertyValue('--scheduler-resize-w')) || 448
    });
    fireEvent.keyDown(within(alpha).getByRole('button', { name: /调整 Alpha 面板大小/ }), { key: 'ArrowRight' });
    fireEvent.click(within(overview).getByRole('button', { name: '收起并排对话' }));
    await waitFor(() => expect(overview.isConnected).toBe(false));

    fireEvent.click(trigger);
    overview = screen.getByRole('dialog', { name: '工作区对话' });
    const [reopenedAlpha, reopenedBeta] = columns().map(column => column.closest<HTMLElement>('[data-scheduler-workspace]')!);
    expect(reopenedAlpha.style.getPropertyValue('--scheduler-panel-w')).toBe('464px');
    expect(reopenedAlpha.style.getPropertyValue('--scheduler-panel-h')).toBe('');
    expect(reopenedBeta.style.getPropertyValue('--scheduler-panel-w')).toBe('');
    fireEvent.click(within(overview).getByRole('button', { name: '整理' }));
    expect(localStorage.getItem('muster.schedulerOverviewSizes.v1')).toBeNull();
  });

  it('仅有一个工作区时也能打开并排视图', async () => {
    const trigger = await renderWorkbench([ALPHA]);
    await act(async () => { fireEvent.click(trigger); });
    expect(columns()).toHaveLength(1);
  });

  it('在某列发起重置时只清空该列，并保留并排视图', async () => {
    const trigger = await renderWorkbench();
    await act(async () => { fireEvent.click(trigger); });
    const clear = currentApiMock().mockOf('chat.clear');
    fireEvent.click(within(columns()[1]).getByRole('button', { name: '重置' }));
    const confirmation = screen.getByRole('dialog', { name: '重置调度会话？' });
    expect(clear).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole('button', { name: '确认重置' }));
    await waitFor(() => expect(clear).toHaveBeenCalledExactlyOnceWith(BETA.id));
    expect(columns()).toHaveLength(2);
  });
});
