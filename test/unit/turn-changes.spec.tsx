import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TurnChangesCard } from '../../src/renderer/src/chatSurface/TurnChangesCard';
import { guiInlineCards, dispatchInlineCards } from '../../src/renderer/src/chatSurface/guiMessageView';
import { guiChatMessageEqual, sanitizeRestoredMessages } from '../../src/shared/guiWorker';
import { currentApiMock } from './helpers/api-mock';
import type { TurnChanges } from '../../src/shared/turnChanges';
import { TURN_REVIEW_EVENT } from '../../src/renderer/src/chatSurface/turnReviewNavigation';

vi.mock('../../src/renderer/src/panels/FileDiffView', () => ({ FileDiffView: ({diffText}: {diffText: string}) => <pre>{diffText}</pre> }));
const target = {kind:'gui' as const,id:'session-a',messageId:'m'};
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
const summary: TurnChanges = {id:'snap',state:'ready',warnings:[],files:[{path:'src/a.ts',kind:'modified',added:1,removed:1,revertible:true}]};
it.each(['ready', 'error'] as const)('keeps an empty %s review out of the transcript', state=>{
  const {container,rerender}=render(<TurnChangesCard summary={{...summary,state,files:[],warnings:[]}} target={target}/>);
  expect(container.querySelector('.turn-changes-card')).toBeNull();
  rerender(<TurnChangesCard summary={{...summary,state,files:[],warnings:['采集未完成']}} target={target}/>);
  expect(container.querySelector('.turn-changes-card')).toBeNull();
  expect(screen.queryByRole('button',{name:'审阅改动'})).toBeNull();
  expect(screen.queryByRole('button',{name:'回退本轮'})).toBeNull();
  expect(screen.queryByText('采集未完成')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});
it('aligns the hover preview with its review card rather than the inset file row', async()=>{
  currentApiMock().mockOf('turnChanges.diff').mockResolvedValue({ok:true,diff:'test'});
  const {container}=render(<TurnChangesCard summary={summary} target={target}/>);
  const file=screen.getByRole('button',{name:/src\/a.ts/});
  vi.spyOn(container.querySelector('.turn-changes-card')!, 'getBoundingClientRect').mockReturnValue({left:40,top:200,width:640,height:200,right:680,bottom:400} as DOMRect);
  vi.spyOn(file, 'getBoundingClientRect').mockReturnValue({left:52,top:250,width:616,height:40,right:668,bottom:290} as DOMRect);
  fireEvent.focus(file);
  const preview=await screen.findByRole('region',{name:'src/a.ts Diff'});
  expect(preview.style.width).toBe('640px');
  expect(preview.style.left).toBe('40px');
});
it('shows the change kind and size explanation without requesting an omitted diff', async () => {
  const file = { ...summary.files[0], diffOmitted: true, revertible: false, added: null, removed: null };
  const { container } = render(<TurnChangesCard summary={{ ...summary, files: [file] }} target={target}/>);
  const row = screen.getByRole('button', { name: /src\/a.ts.*修改/ });
  expect(container.querySelector('.turn-changes-totals')).toBeNull();
  fireEvent.focus(row);
  await screen.findByText('超出审阅大小上限，仅记录文件变化。');
  expect(currentApiMock().mockOf('turnChanges.diff')).not.toHaveBeenCalled();
});
it('summarizes all files above the list and keeps ownership guidance in the footer',()=>{
  const {container}=render(<TurnChangesCard summary={{...summary,files:[summary.files[0],{path:'src/b.ts',kind:'added',added:8,removed:0,revertible:false}]}} target={target}/>);
  expect(container.querySelector('.turn-changes-badge')?.textContent).toBe('2');
  expect(container.querySelector('.turn-changes-header.chat-card-header .chat-card-header-icon svg')).toBeTruthy();
  const totals=container.querySelector('.turn-changes-totals');
  expect(totals?.querySelector('.turn-added')?.textContent).toBe('+9');
  expect(totals?.querySelector('.turn-removed')?.textContent).toBe('−1');
  expect(screen.getByRole('button',{name:/src\/b.ts/})).toBeTruthy();
  expect(screen.getByRole('button',{name:'改动说明'}).getAttribute('title')).toContain('后续已修改或来源未确认的文件会保留。');
  expect(container.querySelector('.turn-changes-footer')?.textContent).not.toContain('后续已修改');
  expect(container.querySelector('.turn-changes-header')?.textContent).not.toContain('后续已修改');
});
it('shows recorded collisions only in the result of an explicit revert', async () => {
  const concurrentEdits = [{ path: 'src/a.ts', otherOwner: 'gui:peer', otherLabel: '修复样式会话' }];
  const revert = currentApiMock().mockOf('turnChanges.revert');
  revert.mockResolvedValue({ ok: false, restored: [], conflicts: [
    { path: 'src/a.ts', reason: '其他会话同时修改了该文件，已保留当前内容：修复样式会话' }
  ] });
  const { rerender } = render(<TurnChangesCard summary={{ ...summary, state: 'collecting', files: [], concurrentEdits }} target={target}/>);
  expect(screen.queryByRole('alert')).toBeNull();
  rerender(<TurnChangesCard summary={{ ...summary, files: [], concurrentEdits }} target={target}/>);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: '审阅改动' })).toBeNull();
  rerender(<TurnChangesCard summary={{ ...summary, files: [{ ...summary.files[0], revertible: false }], concurrentEdits }} target={target}/>);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText(/修复样式会话/)).toBeNull();
  expect(revert).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '回退本轮' }));
  expect(revert).toHaveBeenCalledWith(target);
  expect((await screen.findByRole('alert')).textContent).toContain('src/a.ts：其他会话同时修改了该文件，已保留当前内容：修复样式会话');
});
it('loads a diff on hover, keeps the preview interactive and opens review on click', async()=>{
  const api=currentApiMock(); api.mockOf('turnChanges.diff').mockResolvedValue({ok:true,diff:'-old\n+new'});
  render(<TurnChangesCard summary={summary} target={target}/>);
  expect(api.mockOf('turnChanges.diff')).not.toHaveBeenCalled();
  const file=screen.getByRole('button',{name:/src\/a.ts/}); fireEvent.mouseEnter(file);
  await screen.findByText('-old +new',{exact:false});
  expect(api.mockOf('turnChanges.diff')).toHaveBeenCalledWith(target,'src/a.ts');
  const preview=screen.getByRole('region',{name:'src/a.ts Diff'});
  expect(document.querySelector('.turn-changes-card')?.contains(preview)).toBe(false);
  fireEvent.mouseLeave(file); fireEvent.mouseEnter(preview);
  expect(preview.getAttribute('data-mp-stage')).not.toBe('out');
  const listener=vi.fn(); window.addEventListener(TURN_REVIEW_EVENT,listener);
  fireEvent.click(file);
  expect(listener.mock.calls[0][0].detail).toEqual({target,filePath:'src/a.ts'});
  expect(preview.getAttribute('data-mp-stage')).toBe('out');
  window.removeEventListener(TURN_REVIEW_EVENT,listener);
});
it('moves with the virtual strip and closes the Diff preview when the source page becomes the peek page', async () => {
  currentApiMock().mockOf('turnChanges.diff').mockResolvedValue({ ok: true, diff: 'test' });
  const layout = (peek: boolean) => <div className="h-strip" data-testid="review-strip">
    <div data-h-page="terminal" data-h-peek={peek ? '' : undefined}>
      <TurnChangesCard summary={summary} target={target} />
    </div>
  </div>;
  const view = render(layout(false));
  fireEvent.focus(screen.getByRole('button', { name: /src\/a.ts/ }));
  const preview = await screen.findByRole('region', { name: 'src/a.ts Diff' });
  expect(preview.parentElement).toBe(screen.getByTestId('review-strip'));
  view.rerender(layout(true));
  await waitFor(() => expect(preview.hasAttribute('inert')).toBe(true));
});
it('one click reverts this message, disables repeats and reports skipped files',async()=>{
  const api=currentApiMock(); let resolve!: (value:unknown)=>void;
  api.mockOf('turnChanges.revert').mockReturnValue(new Promise(r=>{resolve=r;}));
  render(<TurnChangesCard summary={summary} target={target}/>);
  fireEvent.click(screen.getByRole('button',{name:'回退本轮'}));
  expect((screen.getByRole('button',{name:'正在回退…'}) as HTMLButtonElement).disabled).toBe(true);
  resolve({ok:false,restored:[],conflicts:[{path:'src/a.ts',reason:'文件在本轮后已变化，已保留当前内容'}]});
  await screen.findByRole('alert'); expect(screen.getByRole('alert').textContent).toContain('已保留当前内容');
  expect(api.mockOf('turnChanges.revert')).toHaveBeenCalledTimes(1); expect(api.mockOf('turnChanges.revert')).toHaveBeenCalledWith(target);
});
it('success persists the reverted state and failures remain visible',async()=>{
  const api=currentApiMock(); api.mockOf('turnChanges.revert').mockResolvedValue({ok:true,restored:['src/a.ts'],conflicts:[],summary:{...summary,files:[{...summary.files[0],revertible:false,reverted:true}]}});
  render(<TurnChangesCard summary={summary} target={target}/>); fireEvent.click(screen.getByRole('button',{name:'回退本轮'}));
  await screen.findByText('已回退'); expect((screen.getByRole('button',{name:'回退本轮'}) as HTMLButtonElement).disabled).toBe(true);
});
it('unknown ownership and snapshot errors never expose an enabled revert',()=>{
  render(<TurnChangesCard summary={{...summary,files:[{...summary.files[0],revertible:false}],warnings:['快照达到容量上限']}} target={target}/>);
  expect(screen.getByText('来源未确认')).toBeTruthy(); expect((screen.getByRole('button',{name:'回退本轮'}) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('button',{name:'改动说明'}).getAttribute('title')).toContain('快照达到容量上限');
});
it('failed diff requests show an error instead of an empty successful view',async()=>{
  currentApiMock().mockOf('turnChanges.diff').mockRejectedValue(new Error('snapshot missing'));
  render(<TurnChangesCard summary={summary} target={target}/>); fireEvent.mouseEnter(screen.getByRole('button',{name:/src\/a.ts/}));
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('snapshot missing'));
});
it('both chat surfaces carry the card; reconciliation notices changed summary',()=>{
  const gui={id:'m',role:'assistant' as const,parts:[],ts:1,turnChanges:summary};
  expect(guiInlineCards('a',gui).changes).toBeTruthy();
  expect(dispatchInlineCards('w',{id:'m',role:'assistant',content:'',createdAt:1,turnChanges:summary}).changes).toBeTruthy();
  expect(guiChatMessageEqual(gui,{...gui,turnChanges:{...summary,files:[]}})).toBe(false);
});
it('restart converts a collecting snapshot into an explicit error and keeps a snapshot-only message',()=>{
  const message={id:'m',role:'assistant' as const,parts:[],ts:1,turnChanges:{...summary,state:'collecting' as const}};
  const restored=sanitizeRestoredMessages([message]);
  expect(restored.length).toBe(1); expect(restored[0].turnChanges?.state).toBe('error');
  expect(restored[0].turnChanges?.warnings.join('')).toContain('采集中断');
  expect(message.turnChanges.state).toBe('collecting');
});

it('defaults to three files, expands and collapses, and resets for a new turn',()=>{
  const files=Array.from({length:5},(_,i)=>({...summary.files[0],path:`src/${i}.ts`}));
  const {container,rerender}=render(<TurnChangesCard summary={{...summary,files}} target={target}/>);
  expect(container.querySelectorAll('.turn-changes-file')).toHaveLength(3);
  expect(container.querySelector('.turn-changes-badge')?.textContent).toBe('5');
  fireEvent.click(screen.getByRole('button',{name:'再显示 2 个文件'}));
  expect(screen.getByRole('button',{name:/src\/4.ts/})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'收起文件'}));
  expect(screen.queryByRole('button',{name:/src\/4.ts/})).toBeNull();
  expect(container.querySelector('.acc')?.hasAttribute('inert')).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'再显示 2 个文件'}));
  expect(screen.getByRole('button',{name:/src\/4.ts/})).toBeTruthy();
  rerender(<TurnChangesCard summary={{...summary,id:'next',files}} target={target}/>);
  expect(screen.queryByRole('button',{name:/src\/4.ts/})).toBeNull();
  expect(screen.getByRole('button',{name:'再显示 2 个文件'}).getAttribute('aria-expanded')).toBe('false');
});
it('anchors an upward preview by its bottom edge before diff contents load',async()=>{
  currentApiMock().mockOf('turnChanges.diff').mockResolvedValue({ok:true,diff:'loaded'});
  const {container}=render(<TurnChangesCard summary={summary} target={target}/>);
  const file=screen.getByRole('button',{name:/src\/a.ts/});
  vi.spyOn(container.querySelector('.turn-changes-card')!, 'getBoundingClientRect').mockReturnValue({left:40,width:640} as DOMRect);
  vi.spyOn(file,'getBoundingClientRect').mockReturnValue({top:600,bottom:640} as DOMRect);
  fireEvent.focus(file);
  const preview=screen.getByRole('region',{name:'src/a.ts Diff'});
  expect(preview.style.bottom).toBe(`${window.innerHeight-600+6}px`);
  expect(preview.style.top).toBe('');
  expect(preview.style.visibility).not.toBe('hidden');
  await screen.findByText('loaded');
  expect(preview.style.bottom).toBe(`${window.innerHeight-600+6}px`);
});
it('renders persisted warmup warnings as historical coverage, not live progress',()=>{
  const warning='文件基线正在后台预热，本轮按文件采集写前原文；无可靠写前事件的变化可能未完整覆盖，且不会自动回退';
  render(<TurnChangesCard summary={{...summary,warnings:[warning]}} target={target}/>);
  const tip=screen.getByRole('button',{name:'改动说明'}).getAttribute('title');
  expect(tip).toContain('本轮开始时文件基线尚未就绪');
  expect(tip).not.toContain('正在后台预热');
});

it('keeps capture details and recorded collisions quiet for unavailable snapshots', () => {
  const { rerender } = render(<TurnChangesCard summary={{...summary, files: [], state: 'collecting', preparing: true}} target={target}/>);
  // Routine preparation noise stays hidden: no status line, no card chrome.
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByText(/正在准备文件基线/)).toBeNull();
  expect(screen.queryByRole('button', {name: '回退本轮'})).toBeNull();
  // Detailed coverage and failures remain available in the explicit panel.
  rerender(<TurnChangesCard summary={{...summary, files: [], state: 'collecting', preparing: true, warnings: ['源目录不可用 fixture']}} target={target}/>);
  expect(screen.queryByText(/源目录不可用/)).toBeNull();
  rerender(<TurnChangesCard summary={{...summary, files: [], state: 'collecting'}} target={target}/>);
  expect(screen.queryByRole('status')).toBeNull();
  rerender(<TurnChangesCard summary={{...summary, files: [], state: 'error', warnings: ['本轮文件审阅不可用：缺少可靠基线']}} target={target}/>);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText('正在准备文件基线…')).toBeNull();
  rerender(<TurnChangesCard summary={{...summary, files: [], state: 'error', concurrentEdits: [{path:'a.ts',otherOwner:'gui:peer',otherLabel:'另一会话'}]}} target={target}/>);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText('另一会话')).toBeNull();
});

it('describes old Shell finalization warnings as historical, not live progress', () => {
  render(<TurnChangesCard summary={{...summary, warnings: ['文件基线仍在后台校验，Shell 变化可能未完整覆盖；已确认的工具文件仍按原文核对']}} target={target}/>);
  const guidance=screen.getByRole('button',{name:'改动说明'}).getAttribute('title');
  expect(guidance).toContain('本轮结束时未完成文件校验');
  expect(guidance).toContain('此为历史记录');
});

it('keeps finalization and failed snapshots out of chat actions and status text', () => {
  const {rerender} = render(<TurnChangesCard summary={{...summary, state:'collecting', finalizing:true}} target={target}/>);
  expect(screen.queryByRole('status')).toBeNull();
  rerender(<TurnChangesCard summary={{...summary,state:'error',warnings:['快照保存失败：磁盘已满']}} target={target}/>);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText(/磁盘已满/)).toBeNull();
  expect(screen.queryByRole('button',{name:'审阅改动'})).toBeNull();
  expect(screen.queryByRole('button',{name:'回退本轮'})).toBeNull();
});
