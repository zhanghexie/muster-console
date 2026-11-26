import { renderWithAppTips as render, findAppTip } from './helpers/app-tips';
import React from 'react';
import {screen,act,within,fireEvent} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MemoryProcessingView} from '../../src/renderer/src/components/MemoryProcessingView';
import {currentApiMock} from './helpers/api-mock';
import type {MemoryCuratorQueueEntry,MemoryCuratorQueuePage,MemoryCuratorQueueQuery,MemoryCuratorSnapshot} from '../../src/shared/memoryCurator';
import {resetMemoryCenterRouteForTest,useMemoryCenterRoute} from '../../src/renderer/src/memoryCenterRoute';
import {applyLocaleSetting} from '../../src/shared/i18n';
import {validateProfileSource} from '../../src/main/memory/profileProvenance';
import type {KnowledgeDraft} from '../../src/shared/knowledge';

const state:MemoryCuratorSnapshot={workspaceId:'a',sessionId:'memory-a',generation:1,status:'idle',paused:false,pending:1,failed:1,running:false,messages:[],updatedAt:1,model:{name:'实际记忆模型'}};
const row:MemoryCuratorQueueEntry={id:'candidate-a',kind:'candidate',text:'卸载订阅时调用取消函数',namespace:'worker',state:'failed',archived:false,createdAt:1,availableAt:2,attempts:1,evidenceCount:2,error:'draft.rationale: 缺少成立依据'};
const attentionEmpty='没有待关注的整理事务。已处理和已归档的记录仍可从上方筛选查看。';
function entry(extra:Partial<MemoryCuratorQueueEntry>={}):MemoryCuratorQueueEntry{return {...row,...extra};}
function pageFor(rows:MemoryCuratorQueueEntry[],input:MemoryCuratorQueueQuery={}):MemoryCuratorQueuePage{
  const visibility=input.visibility??'visible',state=input.state??'all',offset=input.offset??0,limit=input.limit??30;
  const matching=rows.filter(item=>(visibility==='all'||item.archived===(visibility==='archived'))&&(state==='all'||state==='attention'&&(item.state!=='done'||item.result?.disposition==='needs_user')||state==='queued'&&['pending','running','deferred'].includes(item.state)||state===item.state));
  return {items:matching.slice(offset,offset+limit),total:matching.length,offset,limit};
}
function seed(rows:MemoryCuratorQueueEntry[]=[entry()]){
  const mock=currentApiMock();mock.mockOf('memoryCurator.state').mockResolvedValue(state);
  mock.mockOf('memoryCurator.inspect').mockImplementation(async(_workspace,input)=>pageFor(rows,input));
  mock.mockOf('memoryCurator.onChanged').mockImplementation(()=>()=>{});
  return mock;
}
function noModelOrKnowledgeChanges(mock:ReturnType<typeof seed>):void{
  expect(mock.mockOf('memoryCurator.send')).not.toHaveBeenCalled();expect(mock.mockOf('knowledge.process')).not.toHaveBeenCalled();
  expect(mock.mockOf('knowledge.decide')).not.toHaveBeenCalled();expect(mock.mockOf('knowledge.create')).not.toHaveBeenCalled();
  expect(mock.mockOf('knowledge.revise')).not.toHaveBeenCalled();expect(mock.mockOf('knowledge.restore')).not.toHaveBeenCalled();
}

test('翻译已处理事项的宿主说明而不改动保存的原因',async()=>{
  const result={disposition:'duplicate' as const,reason:'已有相同知识，仅关联新增证据'};
  seed([entry({state:'done',error:undefined,result})]);
  const view=render(<MemoryProcessingView workspaceId="a" snapshot={null} initialFilter="done" onRefresh={async()=>{}} onOpenConversation={()=>{}}/>);
  await screen.findByText('处理说明：已有相同知识，仅关联新增证据');
  try {
    act(()=>{applyLocaleSetting('en');});
    expect(await screen.findByText('Decision: Equivalent knowledge already exists; only new evidence was linked.')).toBeTruthy();
    expect(result.reason).toBe('已有相同知识，仅关联新增证据');
  } finally { view.unmount(); act(()=>{applyLocaleSetting('zh-CN');}); }
});

test('翻译失败原因并保留队列原始错误',async()=>{
  const failed=entry({error:'记忆会话仍在处理，暂不能维护'});
  seed([failed]);
  const view=render(<MemoryProcessingView workspaceId="a" snapshot={null} onRefresh={async()=>{}} onOpenConversation={()=>{}}/>);
  fireEvent.click(await screen.findByRole('button',{name:'查看详情'}));
  await screen.findByText('记忆会话仍在处理，暂不能维护');
  try {
    act(()=>{applyLocaleSetting('en');});
    fireEvent.click(await screen.findByRole('button',{name:'View details'}));
    expect(await screen.findByText('The memory session is still processing and cannot be maintained yet.')).toBeTruthy();
    expect(failed.error).toBe('记忆会话仍在处理，暂不能维护');
  } finally {view.unmount();act(()=>{applyLocaleSetting('zh-CN');});}
});

test.each([
  [undefined, '', '没有邮箱', 'The profile must be traceable to the user’s original words in this turn.'],
  ['不要记住我的邮箱', '不要记住我的邮箱', '没有邮箱', 'The user asked not to record this; the profile cannot be saved automatically this turn.'],
  ['my email is a@example.com', 'my email is a@example.com', 'my email is b@example.com', 'The profile email must match the user’s original words.'],
  ['我的手机 12345678', '我的手机 12345678', '我的手机 87654321', 'The profile phone number must match the user’s original words.']
] as const)('translates real profile-provenance failures without rewriting the queue',async(userText,quote,summary,english)=>{
  const draft={kind:'user_profile',summary,applicability:[]} as KnowledgeDraft;
  let raw='';
  try { validateProfileSource(userText,quote,draft); } catch(error) { raw=(error as Error).message; }
  expect(raw).toBeTruthy();
  const failed=entry({error:raw});seed([failed]);
  const view=render(<MemoryProcessingView workspaceId="a" snapshot={null} onRefresh={async()=>{}} onOpenConversation={()=>{}}/>);
  fireEvent.click(await screen.findByRole('button',{name:'查看详情'}));
  await screen.findByText(`${raw}`);
  try {
    act(()=>{applyLocaleSetting('en');});
    fireEvent.click(await screen.findByRole('button',{name:'View details'}));
    expect(await screen.findByText(`${english}`)).toBeTruthy();
    expect(failed.error).toBe(raw);
  } finally {view.unmount();act(()=>{applyLocaleSetting('zh-CN');});}
});

test.each([
  ['记忆会话模型调用预算已用尽', 'The memory session exhausted its model request budget.'],
  ['记忆会话上下文预算已用尽', 'The memory session exhausted its context budget.'],
  ['本轮记忆处理时间预算已用尽', 'This memory processing turn exhausted its time budget.']
])('translates the host budget failure without rewriting the queue: %s',async(raw,english)=>{
  const failed=entry({error:raw});seed([failed]);
  const view=render(<MemoryProcessingView workspaceId="a" snapshot={null} onRefresh={async()=>{}} onOpenConversation={()=>{}}/>);
  fireEvent.click(await screen.findByRole('button',{name:'查看详情'}));
  await screen.findByText(`${raw}`);
  try {
    act(()=>{applyLocaleSetting('en');});
    fireEvent.click(await screen.findByRole('button',{name:'View details'}));
    expect(await screen.findByText(`${english}`)).toBeTruthy();
    expect(failed.error).toBe(raw);
  } finally {view.unmount();act(()=>{applyLocaleSetting('zh-CN');});}
});

test('翻译批次失败的宿主说明并保留原始错误详情',async()=>{
  const error='本批已确认 1/3 条处理回执，剩余 2 条；已保留确认结果。第三方错误';
  const failed=entry({error});seed([failed]);
  const view=render(<MemoryProcessingView workspaceId="a" snapshot={null} onRefresh={async()=>{}} onOpenConversation={()=>{}}/>);
  fireEvent.click(await screen.findByRole('button',{name:'查看详情'}));
  await screen.findByText(`${error}`);
  try {
    act(()=>{applyLocaleSetting('en');});
    fireEvent.click(await screen.findByRole('button',{name:'View details'}));
    expect(await screen.findByText('Confirmed 1/3 receipts in this batch; 2 remain. Confirmed results are retained. 第三方错误')).toBeTruthy();
    expect(failed.error).toBe(error);
  } finally {view.unmount();act(()=>{applyLocaleSetting('zh-CN');});}
});

test('翻译批次中可识别的宿主校验错误并保留原始队列记录',async()=>{
  const error='本批已确认 1/3 条处理回执，剩余 2 条；已保留确认结果。工作区删除记录已变化或尚未比较，请重新检索后提交';
  const failed=entry({error});seed([failed]);
  const view=render(<MemoryProcessingView workspaceId="a" snapshot={null} onRefresh={async()=>{}} onOpenConversation={()=>{}}/>);
  fireEvent.click(await screen.findByRole('button',{name:'查看详情'}));
  await screen.findByText(`${error}`);
  try {
    act(()=>{applyLocaleSetting('en');});
    fireEvent.click(await screen.findByRole('button',{name:'View details'}));
    expect(await screen.findByText('Confirmed 1/3 receipts in this batch; 2 remain. Confirmed results are retained. Workspace deletion records changed or have not been compared. Search again before submitting.')).toBeTruthy();
    expect(failed.error).toBe(error);
  } finally {view.unmount();act(()=>{applyLocaleSetting('zh-CN');});}
});

const correction={memoryId:'original-memory',revision:4,problem:'原结论遗漏了退出时机',evidence:'src/subscriptions.ts 的清理函数',suggestion:'退出时取消订阅'};
function RouteObserver():React.JSX.Element {const route=useMemoryCenterRoute();return <output aria-label="记忆跳转">{route?`${route.tab}:${route.entryId}`:''}</output>;}

test('production correction payload is shown through structured fields without leaking the raw JSON text',async()=>{
  const text=JSON.stringify(correction),mock=seed([entry({state:'pending',error:undefined,text,correction})]);
  render(<MemoryProcessingView workspaceId="a" snapshot={null} onRefresh={async()=>{}} onOpenConversation={()=>{}}/>);
  expect(await screen.findByText('记忆更正请求')).toBeTruthy();
  expect(screen.queryByText(text)).toBeNull();
  expect(screen.getByText('原记忆：original-memory · 提交时版本 r4')).toBeTruthy();
  expect(screen.getAllByText(correction.problem,{exact:false})).toHaveLength(1);
  expect(screen.getAllByText(correction.evidence,{exact:false})).toHaveLength(1);
  expect(screen.getAllByText(correction.suggestion,{exact:false})).toHaveLength(1);
  noModelOrKnowledgeChanges(mock);
});

test.each(['pending','running','deferred','failed'] as const)('correction %s shows target revision and input without presenting an earlier result as applied',async state=>{
  const mock=seed([entry({state,correction,result:{disposition:'updated',recordId:'original-memory',recordRevision:5}})]);
  render(<MemoryProcessingView workspaceId="a" snapshot={null} onRefresh={async()=>{}} onOpenConversation={()=>{}}/>);
  expect(await screen.findByText('记忆更正请求')).toBeTruthy();
  expect(screen.getByText('原记忆：original-memory · 提交时版本 r4')).toBeTruthy();
  expect(screen.getByText(correction.problem,{exact:false})).toBeTruthy();expect(screen.getByText(correction.evidence,{exact:false})).toBeTruthy();
  expect(screen.getByText(correction.suggestion,{exact:false})).toBeTruthy();
  expect(screen.getByText(state==='failed'?'本次更正处理失败，尚未确认应用；请查看失败原因。':'更正请求已入队，尚未应用；以审查结果和结果版本为准。')).toBeTruthy();
  expect(screen.queryByText('已更正并生效')).toBeNull();expect(screen.queryByText(/结果版本：/)).toBeNull();
  expect(screen.getByRole('button',{name:'打开原记忆'})).toBeTruthy();noModelOrKnowledgeChanges(mock);
});

test.each([['updated','已更正并生效',5],['suspended','已暂停原记忆',5],['rejected','更正未采用',undefined],['discarded','更正未采用',undefined]] as const)('completed correction %s displays the reviewed outcome and only a confirmed result revision',async(disposition,label,recordRevision)=>{
  const mock=seed([entry({state:'done',error:undefined,correction,result:{disposition,reason:'已核对实际来源',targetId:correction.memoryId,targetRevision:4,recordId:recordRevision?correction.memoryId:undefined,recordRevision}})]);
  render(<MemoryProcessingView workspaceId="a" snapshot={null} initialFilter="done" onRefresh={async()=>{}} onOpenConversation={()=>{}}/>);
  expect(await screen.findByText(label)).toBeTruthy();expect(screen.getByText('审查目标：original-memory · r4')).toBeTruthy();
  expect(screen.getByText('处理说明：已核对实际来源')).toBeTruthy();
  if(recordRevision)expect(screen.getByText('结果版本：original-memory · r5')).toBeTruthy();
  else {expect(screen.queryByText(/结果版本：/)).toBeNull();expect(screen.getByText('本次更正未应用，原记忆未因本请求改动。')).toBeTruthy();}
  expect(screen.queryByText(/更正请求已入队/)).toBeNull();noModelOrKnowledgeChanges(mock);
});

test('needs_user remains visible in attention, shows the complete unapplied proposal and navigates to the original without saving',async()=>{
  resetMemoryCenterRouteForTest();
  const proposal={decision:'correct' as const,draft:{kind:'reusable_lesson' as const,summary:'离开页面时取消订阅',problem:'卸载后仍收到事件',action:'调用返回的取消函数',rationale:'清理函数释放监听器',applicability:['页面存在订阅'],exceptions:['共享持久监听器'],expectedFutureUse:'避免重复事件',searchKeys:['取消订阅'],repoKey:'workbench',branch:'main',taskId:'task-1',expiresAt:2000000000000}};
  const mock=seed([entry({state:'done',error:undefined,correction,result:{disposition:'needs_user',reason:'用户确认的版本受保护',targetId:correction.memoryId,targetRevision:4,recordId:correction.memoryId,recordRevision:4,proposedCorrection:proposal}})]),user=userEvent.setup();
  render(<><MemoryProcessingView workspaceId="a" snapshot={null} onRefresh={async()=>{}} onOpenConversation={()=>{}}/><RouteObserver/></>);
  expect(await screen.findByText('审查完成，待你处理')).toBeTruthy();
  expect(screen.getByText('本次审查已结束，建议尚未应用。请打开原记忆，核对当前版本后自行修订或停止使用。')).toBeTruthy();
  const details=within(screen.getByRole('region',{name:'审查建议（尚未应用）'}));
  expect(details.getByText('建议修订原记忆')).toBeTruthy();
  for(const value of [proposal.draft.summary,proposal.draft.problem,proposal.draft.action,proposal.draft.rationale,...proposal.draft.applicability,...proposal.draft.exceptions,proposal.draft.expectedFutureUse])expect(details.getByText(value,{exact:false})).toBeTruthy();
  expect(details.getByText('检索词：').closest('p')?.textContent).toBe('检索词：取消订阅');
  expect(details.getByText('仓库：workbench')).toBeTruthy();expect(details.getByText('分支：main')).toBeTruthy();expect(details.getByText('任务：task-1')).toBeTruthy();expect(details.getByText(/建议保留至：/)).toBeTruthy();
  expect(screen.queryByText('已更正并生效')).toBeNull();expect(screen.queryByText(/结果版本：/)).toBeNull();expect(screen.queryByRole('button',{name:'保存并生效'})).toBeNull();
  await user.click(screen.getByRole('button',{name:'打开原记忆'}));expect(screen.getByLabelText('记忆跳转').textContent).toBe('entries:original-memory');
  noModelOrKnowledgeChanges(mock);
});

test('a protected suspension proposal stays unapplied, while ordinary task-history results retain their existing navigation',async()=>{
  resetMemoryCenterRouteForTest();const mock=seed([
    entry({id:'correction',state:'done',error:undefined,correction,result:{disposition:'needs_user',targetId:correction.memoryId,targetRevision:4,proposedCorrection:{decision:'suspend',draft:{kind:'stable_constraint',summary:'待核对的旧约束',applicability:[]}}}}),
    entry({id:'history',state:'done',error:undefined,text:'普通任务事实',result:{disposition:'retained_ephemeral',recordId:'task-history'}})
  ]),user=userEvent.setup();
  render(<><MemoryProcessingView workspaceId="a" snapshot={null} initialFilter="done" onRefresh={async()=>{}} onOpenConversation={()=>{}}/><RouteObserver/></>);
  expect(await screen.findByText('建议停止使用原记忆')).toBeTruthy();expect(screen.queryByText('已暂停原记忆')).toBeNull();
  const ordinary=within(screen.getByText('普通任务事实').closest('article')!);expect(ordinary.getByText('仅留任务历史')).toBeTruthy();expect(ordinary.getByText('记忆候选')).toBeTruthy();expect(ordinary.queryByText(/原记忆：/)).toBeNull();
  await user.click(ordinary.getByRole('button',{name:'查看对应记忆'}));expect(screen.getByLabelText('记忆跳转').textContent).toBe('history:task-history');noModelOrKnowledgeChanges(mock);
});

test('attention is the default, archive visibility is explicit, and live candidates cannot be hidden',async()=>{
  const rows=[entry(),entry({id:'pending',state:'pending',text:'等待中的候选',error:undefined}),entry({id:'running',state:'running',text:'正在执行的候选',error:undefined}),entry({id:'deferred',state:'deferred',text:'等待自动续跑',error:'工具回合预算已用完'}),entry({id:'done',state:'done',text:'已完成的新记录',error:undefined}),entry({id:'archived',state:'done',archived:true,text:'七天前已归档的记录',error:undefined})];
  const mock=seed(rows),user=userEvent.setup();render(<MemoryProcessingView workspaceId="a" snapshot={null} onRefresh={async()=>{}} onOpenConversation={()=>{}}/>);
  await screen.findByText(row.text);
  expect(mock.mockOf('memoryCurator.inspect')).toHaveBeenCalledWith('a',{state:'attention',visibility:'visible',offset:0,limit:30});
  expect(screen.getAllByRole('article')).toHaveLength(4);expect(screen.queryByText('已完成的新记录')).toBeNull();
  const deferred = within(screen.getByText('等待自动续跑').closest('article')!);
  await user.click(deferred.getByRole('button',{name:'查看详情'}));
  expect(screen.getByText('工具回合预算已用完')).toBeTruthy();
  expect(within(screen.getByText('正在执行的候选').closest('article')!).queryByRole('button',{name:'归档记录'})).toBeNull();
  expect(screen.getAllByRole('button',{name:'归档记录'})).toHaveLength(1);
  await user.click(screen.getByRole('button',{name:'全部记录'}));await screen.findByText('已完成的新记录');expect(screen.queryByText('七天前已归档的记录')).toBeNull();
  await user.click(screen.getByRole('button',{name:'已归档'}));await screen.findByText('七天前已归档的记录');expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(mock.mockOf('memoryCurator.inspect')).toHaveBeenLastCalledWith('a',{state:'all',visibility:'archived',offset:0,limit:30});
  expect(screen.getByRole('button',{name:'移回记录'})).toBeTruthy();noModelOrKnowledgeChanges(mock);
});

test('records show field errors and retry results while reads never send model messages',async()=>{
  const rows=[entry()],mock=seed(rows),user=userEvent.setup(),refresh=vi.fn(async()=>{}),open=vi.fn();
  render(<MemoryProcessingView workspaceId="a" snapshot={null} onRefresh={refresh} onOpenConversation={open}/>);
  expect(await screen.findByText(row.text)).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'查看详情'}));expect(screen.getByText(/draft.rationale/)).toBeTruthy();expect(screen.getByText('模型：实际记忆模型')).toBeTruthy();
  noModelOrKnowledgeChanges(mock);
  await user.click(screen.getByRole('button',{name:'打开记忆子系统对话'}));expect(open).toHaveBeenCalledOnce();
  mock.mockOf('knowledge.process').mockImplementation(async()=>{
    mock.mockOf('memoryCurator.state').mockResolvedValue({...state,failed:0,updatedAt:2});
    rows[0]=entry({state:'done',error:undefined,result:{disposition:'active',reason:'原文依据完整',recordId:'memory-result'}});
  });
  await user.click(screen.getByRole('button',{name:'重试失败项'}));await screen.findByText(attentionEmpty);
  await user.click(screen.getByRole('button',{name:'已处理'}));expect(await screen.findByText('处理说明：原文依据完整')).toBeTruthy();expect(screen.queryByRole('button',{name:'查看详情'})).toBeNull();
  expect(mock.mockOf('knowledge.process')).toHaveBeenCalledWith('a');expect(refresh).toHaveBeenCalled();expect(mock.mockOf('memoryCurator.send')).not.toHaveBeenCalled();
});

test('queued filters retain compatibility, pagination is bounded, and pause and read errors stay actionable',async()=>{
  const rows=[...Array.from({length:31},(_,index)=>entry({id:'pending-'+index,state:'pending',text:'待处理候选 '+index,error:undefined})),entry()],mock=seed(rows),user=userEvent.setup();
  render(<MemoryProcessingView workspaceId="a" snapshot={null} onRefresh={async()=>{}} onOpenConversation={()=>{}} initialFilter="queued"/>);
  await screen.findByText('待处理候选 0');expect(mock.mockOf('memoryCurator.inspect')).toHaveBeenCalledWith('a',{state:'queued',visibility:'visible',offset:0,limit:30});
  await user.click(screen.getByRole('button',{name:'下一页'}));await screen.findByText('待处理候选 30');
  expect(mock.mockOf('memoryCurator.inspect')).toHaveBeenLastCalledWith('a',{state:'queued',visibility:'visible',offset:30,limit:30});
  await user.click(screen.getByRole('button',{name:'失败'}));await screen.findByText(row.text);
  expect(mock.mockOf('memoryCurator.inspect')).toHaveBeenLastCalledWith('a',{state:'failed',visibility:'visible',offset:0,limit:30});
  mock.mockOf('memoryCurator.setPaused').mockImplementation(async()=>{mock.mockOf('memoryCurator.state').mockResolvedValue({...state,paused:true,updatedAt:2});return {...state,paused:true,updatedAt:2};});
  await user.click(screen.getByRole('button',{name:'暂停整理'}));await screen.findByRole('button',{name:'恢复整理'});
  expect((screen.getByRole('button',{name:'重试失败项'}) as HTMLButtonElement).disabled).toBe(true);
  mock.mockOf('memoryCurator.inspect').mockRejectedValue(new Error('账本暂时不可读'));
  await user.click(screen.getByRole('button',{name:'刷新记录'}));expect((await findAppTip()).textContent).toContain('账本暂时不可读');
});

test('archive waits for a valid receipt and moving back only restores record visibility',async()=>{
  const rows=[entry()],mock=seed(rows),user=userEvent.setup(),refresh=vi.fn(async()=>{});
  render(<MemoryProcessingView workspaceId="a" snapshot={null} onRefresh={refresh} onOpenConversation={()=>{}}/>);await screen.findByText(row.text);
  let finish!:(receipt:{changed:boolean})=>void;mock.mockOf('memoryCurator.setArchived').mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
  await user.click(screen.getByRole('button',{name:'归档记录'}));
  expect(screen.getByText(row.text)).toBeTruthy();expect((screen.getByRole('button',{name:'归档记录'}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button',{name:'暂停整理'}) as HTMLButtonElement).disabled).toBe(true);
  rows[0]=entry({archived:true});mock.mockOf('memoryCurator.state').mockResolvedValue({...state,failed:0,updatedAt:2});
  await act(async()=>finish({changed:true}));await screen.findByText(attentionEmpty);
  expect(mock.mockOf('memoryCurator.setArchived')).toHaveBeenCalledWith('a',row.id,true);
  await user.click(screen.getByRole('button',{name:'已归档'}));await screen.findByText(row.text);
  mock.mockOf('memoryCurator.setArchived').mockImplementationOnce(async()=>{rows[0]=entry();mock.mockOf('memoryCurator.state').mockResolvedValue({...state,failed:1,updatedAt:3});return {changed:true};});
  await user.click(screen.getByRole('button',{name:'移回记录'}));await screen.findByText('暂无已归档的整理记录。归档只影响记录展示。');
  expect(mock.mockOf('memoryCurator.setArchived')).toHaveBeenLastCalledWith('a',row.id,false);expect(refresh).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole('button',{name:'待关注'}));await screen.findByText(row.text);expect((screen.getByRole('button',{name:'重试失败项'}) as HTMLButtonElement).disabled).toBe(false);noModelOrKnowledgeChanges(mock);
});

test.each([undefined,{}])('an invalid archive receipt keeps the card and reports the unconfirmed action (%s)',async receipt=>{
  const mock=seed(),user=userEvent.setup();mock.mockOf('memoryCurator.setArchived').mockResolvedValue(receipt);
  render(<MemoryProcessingView workspaceId="a" snapshot={null} onRefresh={async()=>{}} onOpenConversation={()=>{}}/>);
  await user.click(await screen.findByRole('button',{name:'归档记录'}));expect((await findAppTip()).textContent).toContain('归档操作未返回有效回执');
  expect(screen.getByText(row.text)).toBeTruthy();expect(mock.mockOf('memoryCurator.inspect')).toHaveBeenCalledTimes(1);noModelOrKnowledgeChanges(mock);
});

test('archive failures keep records visible and an idempotent false receipt still reloads',async()=>{
  const rows=[entry()],mock=seed(rows),user=userEvent.setup();mock.mockOf('memoryCurator.setArchived').mockRejectedValueOnce(new Error('整理记录正在变化'));
  render(<MemoryProcessingView workspaceId="a" snapshot={null} onRefresh={async()=>{}} onOpenConversation={()=>{}}/>);
  await user.click(await screen.findByRole('button',{name:'归档记录'}));expect((await findAppTip()).textContent).toContain('整理记录正在变化');expect(screen.getByText(row.text)).toBeTruthy();
  mock.mockOf('memoryCurator.setArchived').mockImplementationOnce(async()=>{rows[0]=entry({archived:true});return {changed:false};});
  await user.click(screen.getByRole('button',{name:'归档记录'}));await screen.findByText(attentionEmpty);expect(screen.queryByRole('alert')).toBeNull();noModelOrKnowledgeChanges(mock);
});

test('archiving the last row on the last page returns to the final valid page',async()=>{
  const rows=Array.from({length:31},(_,index)=>entry({id:'done-'+index,state:'done',text:'已完成候选 '+index,error:undefined})),mock=seed(rows),user=userEvent.setup();
  mock.mockOf('memoryCurator.setArchived').mockImplementation(async()=>{rows[30]={...rows[30],archived:true};return {changed:true};});
  render(<MemoryProcessingView workspaceId="a" snapshot={null} onRefresh={async()=>{}} onOpenConversation={()=>{}} initialFilter="all"/>);
  await screen.findByText('已完成候选 0');await user.click(screen.getByRole('button',{name:'下一页'}));await screen.findByText('已完成候选 30');
  await user.click(screen.getByRole('button',{name:'归档记录'}));await screen.findByText('已完成候选 0');
  expect(screen.queryByText('已完成候选 30')).toBeNull();expect(screen.queryByRole('button',{name:'上一页'})).toBeNull();
  expect(mock.mockOf('memoryCurator.inspect')).toHaveBeenLastCalledWith('a',{state:'all',visibility:'visible',offset:0,limit:30});
});

test.each(['success','failure'])('late action %s cannot affect a different workspace or refresh its snapshot',async outcome=>{
  const mock=seed(),user=userEvent.setup(),refresh=vi.fn(async()=>{});let reject!:(error:Error)=>void,resolve!:(value:{changed:boolean})=>void;
  mock.mockOf('memoryCurator.setArchived').mockReturnValueOnce(new Promise((done,fail)=>{resolve=done;reject=fail;}));
  const view=render(<MemoryProcessingView workspaceId="a" snapshot={null} onRefresh={refresh} onOpenConversation={()=>{}}/>);
  await user.click(await screen.findByRole('button',{name:'归档记录'}));
  mock.mockOf('memoryCurator.state').mockResolvedValue({...state,workspaceId:'b'});
  mock.mockOf('memoryCurator.inspect').mockResolvedValue(pageFor([entry({id:'b',text:'另一工作区的候选'})]));
  view.rerender(<MemoryProcessingView workspaceId="b" snapshot={null} onRefresh={refresh} onOpenConversation={()=>{}}/>);await screen.findByText('另一工作区的候选');
  await act(async()=>{if(outcome==='success')resolve({changed:true});else reject(new Error('旧工作区归档失败'));});
  expect(screen.queryByRole('alert')).toBeNull();expect(screen.getByText('另一工作区的候选')).toBeTruthy();expect(refresh).not.toHaveBeenCalled();
  expect((screen.getByRole('button',{name:'归档记录'}) as HTMLButtonElement).disabled).toBe(false);
});

test('a late page cannot replace a newer filter and subscriptions clean up',async()=>{
  const mock=seed(),user=userEvent.setup(),stop=vi.fn();mock.mockOf('memoryCurator.onChanged').mockImplementation(()=>stop);
  let resolve!:(value:MemoryCuratorQueuePage)=>void;
  mock.mockOf('memoryCurator.inspect').mockReturnValueOnce(new Promise<MemoryCuratorQueuePage>(done=>{resolve=done;})).mockResolvedValue(pageFor([]));
  const view=render(<MemoryProcessingView workspaceId="a" snapshot={null} onRefresh={async()=>{}} onOpenConversation={()=>{}}/>);
  await user.click(screen.getByRole('button',{name:'已处理'}));await screen.findByText('当前筛选下没有整理记录。新候选只在发现有用内容时提交。');
  await act(async()=>resolve(pageFor([row])));expect(screen.queryByText(row.text)).toBeNull();
  view.unmount();expect(stop).toHaveBeenCalled();
});
