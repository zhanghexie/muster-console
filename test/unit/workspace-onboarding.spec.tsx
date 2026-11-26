/**
 * 零工作区常驻新建引导（组件级）：
 * - required 模式没有 × / 取消，ESC 与点遮罩都不关闭，并显示引导文案；
 * - 推荐路径「一键填入」填好名称与源根，提交带 ensureRecommendedRoot；换成手动选路径后标记失效；
 * - StoreProvider + AgentFloat：零工作区常驻，创建后收起，删空后再次出现。
 * window.api 走 helpers/api-mock（AGENTS.md 测试规约）。
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CreateWorkspaceModal, type CreateWorkspaceResult } from '../../src/renderer/src/components/CreateWorkspaceModal';
import { StoreProvider } from '../../src/renderer/src/store';
import { AgentFloat } from '../../src/renderer/src/panels/AgentFloat';
import { MOTION } from '../../src/renderer/src/components/motion';
import { currentApiMock } from './helpers/api-mock';

vi.mock('../../src/renderer/src/avatarAccent', () => ({
  extractAvatarAccent: () => Promise.resolve('#7a6cff')
}));

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

const ROOT = 'C:/Users/tester/Muster';
const NAME = 'muster 默认工作区';

const noopSave = async (_result: CreateWorkspaceResult): Promise<void> => {};

function renderModal(props: {
  required?: boolean;
  onClose?: () => void;
  onSave?: (result: CreateWorkspaceResult) => Promise<void>;
}) {
  return render(
    <CreateWorkspaceModal
      open
      mode="create"
      required={props.required}
      recommendedRoot={ROOT}
      recommendedName={NAME}
      onClose={props.onClose ?? (() => {})}
      onSave={props.onSave ?? noopSave}
    />
  );
}

describe('零工作区新建引导', () => {
  it('required 引导不可关闭：无 × / 取消，ESC 与遮罩都不触发 onClose', async () => {
    const onClose = vi.fn();
    renderModal({ required: true, onClose });
    const dialog = await screen.findByRole('dialog', { name: '新建工作区' });
    expect(screen.getByText('创建一个工作区就可以使用了')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: '关闭' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: '取消' })).toBeNull();
    expect(document.querySelector('.modal-mask.is-required')).toBeTruthy();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.mouseDown(document.querySelector('.modal-mask') as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '新建工作区' })).toBeTruthy();
  });

  it('非 required 的新建面板仍保留取消与 ×', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    const dialog = await screen.findByRole('dialog', { name: '新建工作区' });
    expect(screen.queryByText('创建一个工作区就可以使用了')).toBeNull();
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '关闭' })).toBeTruthy();
  });

  it('首启沿用普通新建对话框，预选推荐目录，选已有目录后只提交用户选中的路径', async () => {
    const onSave = vi.fn<(result: CreateWorkspaceResult) => Promise<void>>().mockResolvedValue(undefined);
    const mock = currentApiMock();
    mock.override('workspaces.pickDir', async () => ({ ok: true, path: 'D:/projects/demo' }));
    render(<CreateWorkspaceModal open guided multiFolder={false} recommendedRoot={ROOT} recommendedName={NAME}
      onClose={() => {}} onSave={onSave} />);
    const dialog = await screen.findByRole('dialog', { name: '新建工作区' });
    const create = within(dialog).getByRole<HTMLButtonElement>('button', { name: '创建' });
    expect(create.disabled).toBe(false);
    expect(within(dialog).queryByRole('button', { name: '一键填入' })).toBeNull();
    fireEvent.click(create);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ path: ROOT, ensureRecommendedRoot: true })));
    const pick = within(dialog).getByRole<HTMLButtonElement>('button', { name: '选择已有文件夹' });
    await waitFor(() => expect(pick.disabled).toBe(false));
    fireEvent.click(pick);
    await waitFor(() => expect((within(dialog).getByPlaceholderText('名称') as HTMLInputElement).value).toBe('demo'));
    fireEvent.click(create);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1][0]).toMatchObject({ path: 'D:/projects/demo', name: 'demo' });
    expect(onSave.mock.calls[1][0].ensureRecommendedRoot).toBeUndefined();
  });

  it('一键填入推荐路径：名称、源根与提交标记都对', async () => {
    const onSave = vi.fn<(r: CreateWorkspaceResult) => Promise<void>>(() => Promise.resolve());
    renderModal({ required: true, onSave });
    const dialog = await screen.findByRole('dialog', { name: '新建工作区' });
    expect(screen.getByText(`还没想好放哪里？用 ${ROOT} 试试`)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: '一键填入' }));
    expect((within(dialog).getByPlaceholderText('名称') as HTMLInputElement).value).toBe(NAME);
    expect((document.querySelector('.ws-root-path') as HTMLElement).textContent).toBe(ROOT);

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));
    });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const result = onSave.mock.calls[0][0];
    expect(result.name).toBe(NAME);
    expect(result.ensureRecommendedRoot).toBe(true);
    expect(result.roots?.[0].path).toBe(ROOT);
    expect(result.defaultRootId).toBe(result.roots?.[0].id);
    expect(result.controlRootId).toBe(result.roots?.[0].id);
  });

  it('换成手动选目录后不再带推荐建目录标记', async () => {
    const mock = currentApiMock();
    mock.override('workspaces.pickDir', () => Promise.resolve({ ok: true, paths: ['D:/projects/demo'] }));
    const onSave = vi.fn<(r: CreateWorkspaceResult) => Promise<void>>(() => Promise.resolve());
    renderModal({ required: true, onSave });
    const dialog = await screen.findByRole('dialog', { name: '新建工作区' });
    fireEvent.click(within(dialog).getByRole('button', { name: '一键填入' }));

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '添加文件夹' }));
    });
    await waitFor(() => expect(document.querySelectorAll('.ws-root-path').length).toBe(2));

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));
    });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].ensureRecommendedRoot).toBeUndefined();
  });

  it('桌面首启指向工作区原有加号，点击后才打开新建表单', async () => {
    const mock = currentApiMock();
    const snapshot = { workspaces: [], activeWorkspaceId: '' };
    mock.override('config.get', async () => snapshot);
    mock.override('workspaces.list', async () => ({ ...snapshot, recommendedRoot: ROOT, recommendedName: NAME }));
    await act(async () => {
      render(<StoreProvider><AgentFloat stackInline requireWorkspace={false} guideNewWorkspace /></StoreProvider>);
    });
    const add = screen.getByRole('button', { name: '新建工作区' });
    expect(add.textContent?.trim()).toBe('+');
    expect(add.getAttribute('data-setup-target')).toBe('workspace');
    expect(screen.queryByRole('dialog', { name: '新建工作区' })).toBeNull();
    fireEvent.click(add);
    const dialog = await screen.findByRole('dialog', { name: '新建工作区' });
    await waitFor(() => expect(within(dialog).getByDisplayValue(ROOT)).toBeTruthy());
    expect(mock.mockOf('workspaces.open')).not.toHaveBeenCalled();
  });

  it('零工作区常驻；创建后收起，删空后再次出现', async () => {
    const mock = currentApiMock();
    const one = [{ id: 'ws-a', path: 'E:/demo/a', name: 'A', openedAt: 1 }];
    mock.override('workspaces.list', () => Promise.resolve({
      workspaces: [], activeWorkspaceId: '', recommendedRoot: ROOT, recommendedName: NAME
    }));
    mock.override('config.get', () => Promise.resolve({
      workspaces: [], activeWorkspaceId: '', locale: 'zh-CN'
    }));
    mock.override('codeAnalysis.status', () => Promise.resolve({ ok: false }));

    await act(async () => {
      render(<StoreProvider><AgentFloat stackInline /></StoreProvider>);
    });
    await screen.findByRole('dialog', { name: '新建工作区' });
    expect(screen.getByText('创建一个工作区就可以使用了')).toBeTruthy();

    act(() => mock.emit('workspaces:changed', { workspaces: one, activeWorkspaceId: 'ws-a' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建工作区' })).toBeNull(),
      { timeout: MOTION.exitMs + 1500 });

    act(() => mock.emit('workspaces:changed', { workspaces: [], activeWorkspaceId: '' }));
    await screen.findByRole('dialog', { name: '新建工作区' });
    expect(screen.getByText('创建一个工作区就可以使用了')).toBeTruthy();
  });
});
