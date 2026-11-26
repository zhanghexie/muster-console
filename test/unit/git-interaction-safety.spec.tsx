import { AppTipHost } from '../../src/renderer/src/components/AppTip';
import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { PanelHistoryProvider } from '../../src/renderer/src/panelHistory';
import { GitPanel, type GitPanelHandle } from '../../src/renderer/src/panels/GitPanel';
import { GitBranchPopover } from '../../src/renderer/src/panels/GitBranchPopover';
import { GitWorkspaceProvider } from '../../src/renderer/src/panels/gitpanel/GitWorkspaceScope';
import { defaultWorkspaceFileConfig } from '../../src/shared/metaAgent';
import type { GitRepoStatus } from '../../src/shared/types';
import { currentApiMock } from './helpers/api-mock';

beforeEach(() => dismissTip());

const ws = { id: 'safety', name: 'Safety', path: 'E:/safety', openedAt: 0, rootsRevision: 0 };
const clean: GitRepoStatus = { branch: 'main', tracking: 'origin/main', ahead: 1, behind: 0, files: [] };
type Invoke = (scope: unknown, method: string, ...args: unknown[]) => unknown;
function configure(invoke: Invoke) {
  Element.prototype.scrollIntoView = () => {};
  const mock = currentApiMock();
  mock.override('workspaces.list', async () => ({ workspaces: [ws], activeWorkspaceId: ws.id }));
  mock.override('config.get', async () => ({ workspaces: [ws], activeWorkspaceId: ws.id, locale: 'zh-CN' }));
  mock.override('workspaceFile.get', async () => ({ workspaceId: ws.id, config: { ...defaultWorkspaceFileConfig(), git: { selectedRepo: ws.path } } }));
  mock.override('workspaceFile.patch', async () => ({ ok: true, workspaceId: ws.id, config: defaultWorkspaceFileConfig() }));
  mock.override('git.listRepoLocations', async () => ({ workspaceId: ws.id, rootsRevision: 0, issues: [], issueCount: 0,
    repos: [{ path: ws.path, name: ws.name, branch: 'main', dirty: false }] }));
  mock.override('git.invokeScoped', (scope, method, ...args) => method === 'diff' ? { diff: '', staged: false, path: args[1] } : invoke(scope, method, ...args));
  return mock;
}
function panel(active = true) {
  return <StoreProvider><PanelHistoryProvider><GitPanel active={active} sideTab="git" /><AppTipHost /></PanelHistoryProvider></StoreProvider>;
}
async function ready() {
  await waitFor(() => expect(screen.getByTitle('点击切换 / 新建分支').hasAttribute('disabled')).toBe(false));
}

it('本地操作失败弹出 tip，切页不重放旧错误', async () => {
  configure(async (_scope, method) => method === 'status' ? { ...clean, files: [{ path: 'same.txt', index: ' ', working_dir: 'M' }] }
    : method === 'stageAll' ? { ok: false, message: 'STAGE_REJECTED' } : { ok: true });
  const view = render(panel()); await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Stage All' }));
  const tip = await screen.findByText('STAGE_REJECTED');
  expect(tip.closest('.app-tip')?.classList.contains('is-error')).toBe(true);
  expect(view.container.textContent).not.toContain('STAGE_REJECTED');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Stage All' }).hasAttribute('disabled')).toBe(false));
  act(() => dismissTip());
  view.rerender(panel(false)); view.rerender(panel(true));
  expect(getTipSnapshot()).toBeNull();
});

it('首次 status 失败显示未知，不显示干净；重试后恢复', async () => {
  let fail = true;
  configure(async (_scope, method) => { if (method === 'status') { if (fail) throw new Error('STATUS_FAILED'); return clean; } return { ok: true }; });
  render(panel());
  await screen.findByText('无法确认工作区状态');
  expect(screen.queryByText('工作区干净')).toBeNull();
  expect(screen.getByRole('button', { name: 'Commit' }).hasAttribute('disabled')).toBe(true);
  fail = false; fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await screen.findByText('工作区干净');
  expect(screen.queryByText('无法确认工作区状态')).toBeNull();
});

it('已有快照读取失败保留文件并标明旧数据', async () => {
  let fail = false;
  configure(async (_scope, method) => { if (method === 'status') { if (fail) throw new Error('STALE_STATUS'); return { ...clean, files: [{ path: 'same.txt', index: ' ', working_dir: 'M' }] }; } return { ok: true }; });
  const view = render(panel()); await ready(); await screen.findByText('same.txt');
  fail = true; view.rerender(panel(false)); view.rerender(panel(true));
  await screen.findByText(/状态读取失败，显示 .* 的旧数据/);
  expect(screen.getByText('same.txt')).toBeTruthy();
  expect(screen.queryByText('工作区干净')).toBeNull();
});

it.each(['unstaged', 'staged'] as const)('%s 分区丢弃的名称、确认范围和 IPC 一致', async zone => {
  const mock = configure(async (_scope, method) => method === 'status' ? { ...clean, files: [{ path: 'same.txt', index: 'M', working_dir: 'M' }] } : { ok: true });
  render(panel()); await ready();
  const files = await screen.findAllByText('same.txt');
  fireEvent.contextMenu(files[zone === 'unstaged' ? 0 : 1]);
  const label = zone === 'unstaged' ? '丢弃未暂存改动' : '丢弃全部改动';
  fireEvent.click(await screen.findByText(label));
  const dialog = await screen.findByRole('dialog');
  expect(dialog.textContent).toContain(ws.path); expect(dialog.textContent).toContain('same.txt');
  expect(dialog.textContent).toContain(zone === 'unstaged' ? '保留已暂存内容' : '已暂存及未暂存');
  fireEvent.click(within(dialog).getByRole('button', { name: '丢弃' }));
  await waitFor(() => expect(mock.mockOf('git.invokeScoped')).toHaveBeenCalledWith({ workspaceId: ws.id, rootsRevision: 0 }, 'discard', ws.path, ['same.txt'], zone === 'unstaged' ? 'unstaged' : 'all'));
});

it.each([true, false])('Stash 恢复失败保留警告、记录与冲突文件，部分成功=%s', async ok => {
  const warning = '已切换到 feature，但恢复临时保存的改动失败';
  configure(async (_scope, method) => method === 'listBranches' ? { current: 'main', local: [{ name: 'feature', ref: 'feature', current: false }], remote: [] }
    : method === 'checkout' ? { ok, warning: true, message: warning, stashRef: 'abc123', conflicts: ['same.txt'] } : { ok: true });
  const close = vi.fn(); const changed = vi.fn();
  render(<GitWorkspaceProvider scope={{ workspaceId: ws.id, rootsRevision: 0 }}><GitBranchPopover repoPath={ws.path} currentBranch="main" dirty open onClose={close} onChanged={changed}/><AppTipHost /></GitWorkspaceProvider>);
  fireEvent.doubleClick(await screen.findByText('feature'));
  fireEvent.click(await screen.findByRole('button', { name: '临时保存并切换后恢复' }));
  await screen.findByText(new RegExp(warning));
  expect(document.body.textContent).toContain('abc123'); expect(document.body.textContent).toContain('same.txt');
  expect(close).not.toHaveBeenCalled(); expect(changed).toHaveBeenCalledWith(undefined, expect.objectContaining({ warning: true }));
});

it('恢复失败的弹出 tip 不随分支菜单关闭', async () => {
  const warning = '恢复临时保存失败，需要处理冲突';
  let branch = 'main';
  configure(async (_scope, method) => {
    if (method === 'status') return { ...clean, branch, files: [{ path: 'same.txt', index: ' ', working_dir: 'M' }] };
    if (method === 'listBranches') return { current: branch, local: [{ name: 'feature', ref: 'feature', current: false }], remote: [] };
    if (method === 'checkout') { branch = 'feature'; return { ok: true, warning: true, message: warning, stashRef: 'abc123' }; }
    return { ok: true };
  });
  render(panel()); await ready();
  fireEvent.click(screen.getByTitle('点击切换 / 新建分支'));
  fireEvent.doubleClick(await screen.findByText('feature'));
  fireEvent.click(await screen.findByRole('button', { name: '临时保存并切换后恢复' }));
  await waitFor(() => expect(getTipSnapshot()?.text).toContain(warning));
  fireEvent.pointerDown(document.body);
  expect(getTipSnapshot()?.text).toContain(warning);
});

it('checkout warning arriving after repo switch must not publish old status as current repo', async () => {
  Element.prototype.scrollIntoView = () => {};
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  const ws = { id:'review', path:'E:/review', name:'Review', openedAt:0, rootsRevision:0 };
  const child = ws.path + '/child';
  const mock = currentApiMock();
  mock.override('workspaces.list', async () => ({ workspaces:[ws], activeWorkspaceId:ws.id }));
  mock.override('config.get', async () => ({ workspaces:[ws], activeWorkspaceId:ws.id, locale:'zh-CN' }));
  mock.override('workspaceFile.get', async () => ({ workspaceId:ws.id, config:{ ...defaultWorkspaceFileConfig(), git:{ selectedRepo:ws.path } } }));
  mock.override('workspaceFile.patch', async () => ({ ok:true, workspaceId:ws.id, config:defaultWorkspaceFileConfig() }));
  let listCalls = 0;
  mock.override('git.listRepoLocations', () => ++listCalls === 1 ? Promise.resolve({ workspaceId:ws.id, rootsRevision:0, issues:[], issueCount:0, repos:[{ path:ws.path,name:'Review',branch:'main',dirty:true },{ path:child,name:'Child',branch:'child-main',dirty:true }] }) : new Promise(() => {}));
  let resolveCheckout!: (v: unknown) => void;
  let checkoutDone = false;
  mock.override('git.invokeScoped', async (_scope, method, path) => {
    if(method === 'status') return { branch:path === child?'child-main':'main', tracking:null, ahead:0,behind:0, files:[{path:path === child?'B-only.txt':checkoutDone?'A-after-checkout.txt':'A-before.txt',index:' ',working_dir:'M'}] };
    if(method === 'listBranches') return { current:'main', local:[{name:'feature',ref:'feature',current:false}],remote:[] };
    if(method === 'checkout') return new Promise(resolve => { resolveCheckout=resolve; });
    if(method === 'diff') return { diff:'' };
    return {ok:true};
  });
  const ref = React.createRef<GitPanelHandle>();
  render(<StoreProvider><PanelHistoryProvider><GitPanel ref={ref} active sideTab="git"/></PanelHistoryProvider></StoreProvider>);
  await screen.findByText('A-before.txt');
  fireEvent.click(screen.getByTitle('点击切换 / 新建分支'));
  fireEvent.doubleClick(await screen.findByText('feature'));
  fireEvent.click(await screen.findByRole('button', {name:'临时保存并切换后恢复'}));
  await act(async () => { ref.current!.selectRepo(child); });
  await screen.findByText('B-only.txt');
  await act(async () => { checkoutDone=true; resolveCheckout({ok:true,warning:true,message:'late warning',stashRef:'oid'}); });
  expect(ref.current!.getSelectedRepo()).toBe(child);
  await waitFor(() => expect(screen.queryByText('A-after-checkout.txt')).toBeNull());
});
