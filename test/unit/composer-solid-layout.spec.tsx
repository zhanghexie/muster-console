import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueueSendPanel, QUEUE_PANEL_MINIMIZED_KEY } from '../../src/renderer/src/components/QueueSendPanel';
import { AgentComposer } from '../../src/renderer/src/components/AgentComposer';
import { serializeComposerDom } from '../../src/renderer/src/components/composerDomText';
import { StoreProvider } from '../../src/renderer/src/store';
import { closeTopOverlay } from '../../src/renderer/src/keybindings/overlayStack';

const autoItems = [{ id: 'a', text: '第一条' }, { id: 'b', text: '第二条' }];
function panelProps() {
  return { autoItems, manualItems: [{ id: 'm', text: '待确认内容' }], onSendNow: vi.fn(), onEditToDraft: vi.fn(), onDelete: vi.fn(), onReorder: vi.fn(), onMoveLane: vi.fn() };
}
function more(row: number) { fireEvent.click(within(screen.getAllByRole('listitem')[row]).getByRole('button', { name: '消息操作' })); }
beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollIntoView ??= () => {};
  document.execCommand ??= () => false;
});

describe('纯色输入区：队列管理', () => {
  it('更多菜单可调整顺序、跨组和删除；边界项禁用', () => {
    const props = panelProps();
    render(<QueueSendPanel {...props}/>);
    more(0);
    expect(screen.getByRole('menuitemcheckbox', { name: '上移' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '下移' }));
    expect(props.onReorder).toHaveBeenCalledWith('auto', ['b', 'a']);
    more(0);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '转为手动确认' }));
    expect(props.onMoveLane).toHaveBeenCalledWith(autoItems[0], 'auto', 'manual');
    more(2);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '删除' }));
    expect(props.onDelete).toHaveBeenCalledWith(props.manualItems[0], 'manual');
  });

  it('菜单键盘选择取回编辑；Escape 关闭且回焦来源按钮', () => {
    const props = panelProps();
    render(<QueueSendPanel {...props}/>);
    more(0);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(props.onEditToDraft).toHaveBeenCalledWith(autoItems[0], 'auto');
    more(0);
    // App 的 Escape 命令分发到此栈；单独渲染组件不挂全局快捷键 Host。
    act(() => { closeTopOverlay(); });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(within(screen.getAllByRole('listitem')[0]).getByRole('button', { name: '消息操作' }));
  });

  it('拖拽保留同组重排和空组落点；收起后关闭在途菜单', () => {
    const props = { ...panelProps(), manualItems: [] };
    render(<QueueSendPanel {...props}/>);
    const start = (index = 0) => {
      const row = screen.getAllByRole('listitem')[index];
      fireEvent.mouseDown(within(row).getByRole('button', { name: '拖动调整顺序' }));
      fireEvent.dragStart(row, { dataTransfer: { effectAllowed: '', dropEffect: '' } });
    };
    start(1);
    const first = screen.getAllByRole('listitem')[0];
    fireEvent.dragOver(first, { dataTransfer: { dropEffect: '' } });
    fireEvent.drop(first);
    expect(props.onReorder).toHaveBeenCalledWith('auto', ['b', 'a']);
    start();
    fireEvent.drop(document.querySelector('.agent-composer-qslane.is-manual')!);
    expect(props.onMoveLane).toHaveBeenCalledWith(autoItems[0], 'auto', 'manual');
    more(0);
    fireEvent.click(screen.getByRole('button', { name: '收起排队面板' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(localStorage.getItem(QUEUE_PANEL_MINIMIZED_KEY)).toBe('1');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '展开排队面板' }));
  });
});

describe('纯色输入区：真实 Composer 装配', () => {
  it('打开期间建议先占据完整高度，启用后不重播展开', async () => {
    const props = { workspaceId: 'opening-suggestion', surfaceKind: 'gui-session' as const, busy: false,
      onSend: async () => true, onClear: async () => {}, replySuggestions: { messageId: 'a1', replies: ['继续检查'] } };
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<StoreProvider><AgentComposer {...props} disabled /></StoreProvider>); });
    const fold = view.container.querySelector('.composer-reply-suggestions')!.closest('.acc') as HTMLElement;
    expect(fold.classList.contains('is-open')).toBe(true);
    expect(fold.style.transition).toBe('none');
    expect(fold.hasAttribute('inert')).toBe(true);
    await act(async () => { view.rerender(<StoreProvider><AgentComposer {...props} disabled={false} /></StoreProvider>); });
    expect(fold.classList.contains('is-open')).toBe(true);
    expect(fold.style.transition).toBe('none');
    expect(fold.hasAttribute('inert')).toBe(false);
    expect(screen.getByRole('group', { name: '建议回复' })).toBeTruthy();
  });
  it('会话建议、队列和草稿动作在同一输入壳，取回编辑合并文图', async () => {
    const onSend = vi.fn(async () => true);
    const onCancelQueued = vi.fn();
    const image = (id: string) => ({ id, data: id, mimeType: 'image/png', name: `${id}.png` });
    await act(async () => {
      render(<StoreProvider><AgentComposer workspaceId="solid-ws" surfaceKind="gui-session" busy={false}
        queuedItems={autoItems.map(item => ({ ...item, imageCount: 1 }))}
        getQueuedImages={id => [image(id)]} onCancelQueued={onCancelQueued} onSend={onSend} onClear={async () => {}}
        replySuggestions={{ messageId: 'a1', replies: ['继续检查'] }} /></StoreProvider>);
    });
    const shell = document.querySelector('.chat-input-shell')!;
    expect(shell.contains(screen.getByRole('group', { name: '建议回复' }))).toBe(true);
    expect(shell.contains(document.querySelector('.agent-composer-qspanel'))).toBe(true);
    const editor = screen.getByRole('textbox');
    const header = shell.querySelector('.composer-actions-header');
    expect(header).not.toBeNull();
    expect(header!.contains(screen.getByRole('group', { name: '建议回复' }))).toBe(true);
    const draftActions = screen.getByRole('toolbar', { name: '入队建议' });
    expect(header!.contains(draftActions)).toBe(false);
    const sendActions = screen.getByRole('group', { name: '发送操作' });
    expect(sendActions.contains(draftActions)).toBe(true);
    expect(sendActions.closest('.agent-composer-toolbar')).not.toBeNull();
    expect(screen.getByRole('button', { name: '留待确认' }).textContent).toBe('');
    expect(sendActions.lastElementChild).toBe(screen.getByRole('button', { name: '发送' }));
    expect(screen.queryByText('Enter 发送')).toBeNull();
    expect(header!.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    editor.textContent = '正在写的草稿'; fireEvent.input(editor);
    expect(screen.getByRole('toolbar', { name: '入队建议' })).toBe(draftActions);
    fireEvent.click(within(screen.getAllByRole('listitem')[0]).getByRole('button', { name: '取回输入框编辑' }));
    fireEvent.click(within(screen.getAllByRole('listitem')[1]).getByRole('button', { name: '取回输入框编辑' }));
    expect(serializeComposerDom(editor)).toBe('正在写的草稿\n第一条\n第二条');
    expect(shell.querySelectorAll('.agent-composer-images img').length).toBe(2);
    expect(onCancelQueued.mock.calls).toEqual([['a'], ['b']]);
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => { fireEvent.keyDown(editor, { key: 'Enter' }); });
    expect(onSend).toHaveBeenCalledWith('正在写的草稿\n第一条\n第二条', expect.arrayContaining([expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })]));
  });
});

describe('输入区上沿统一胶囊行', () => {
  it('折叠队列、命令 chip 共用上沿，展开队列和取消命令仍可操作', async () => {
    await act(async () => { render(<StoreProvider><AgentComposer workspaceId="header-ws" surfaceKind="gui-session" busy={false}
      onSend={async () => true} onClear={async () => {}}/></StoreProvider>); });
    const editor = screen.getByRole('textbox');
    editor.textContent = '待确认的内容'; fireEvent.input(editor);
    fireEvent.click(screen.getByRole('button', { name: '留待确认' }));
    fireEvent.click(screen.getByRole('button', { name: '收起排队面板' }));
    await waitFor(() => expect(document.querySelector('.agent-composer-qspanel')).toBeNull());
    editor.textContent = '/quickInput'; fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: 'Enter' });
    await screen.findByRole('dialog', { name: '快捷短语' });
    const header = document.querySelector('.composer-actions-header')!;
    expect(header.contains(screen.getByRole('button', { name: '展开排队面板' }))).toBe(true);
    expect(header.contains(screen.getByRole('button', { name: '取消命令' }))).toBe(true);
    expect(document.querySelector('.composer-cmd-row')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开排队面板' }));
    expect(screen.getByRole('button', { name: '收起排队面板' })).toBeTruthy();
    const commandFold = screen.getByRole('button', { name: '取消命令' }).closest('.acc')!;
    fireEvent.click(screen.getByRole('button', { name: '取消命令' }));
    expect(commandFold.classList.contains('is-open')).toBe(false);
    expect(commandFold.getAttribute('aria-hidden')).toBe('true');
    await waitFor(() => expect(screen.queryByRole('button', { name: '取消命令' })).toBeNull());
    expect(screen.getByText('待确认的内容')).toBeTruthy();
  });
});
