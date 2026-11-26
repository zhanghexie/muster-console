import React from 'react';
import {render,screen,waitFor,act,fireEvent} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {KnowledgePanel} from '../../src/renderer/src/components/KnowledgePanel';
import {KnowledgeHistory} from '../../src/renderer/src/components/KnowledgeHistory';
import type {KnowledgeApi,KnowledgeRecord,KnowledgeSnapshot} from '../../src/shared/knowledge';
import {currentApiMock} from './helpers/api-mock';
import {applyLocaleSetting} from '../../src/shared/i18n';
import {KNOWLEDGE_DISPLAY_KEYS,KNOWLEDGE_DISPLAY_TEMPLATES,localizeKnowledgeHostText} from '../../src/shared/knowledgeDisplayText';

const record:KnowledgeRecord={schema:1,id:'memory-a',revision:2,kind:'reusable_lesson',namespace:'worker',status:'pending',origin:'worker',
  summary:'订阅需要在卸载时清理',problem:'重复事件',action:'返回取消订阅函数',rationale:'卸载回归通过',expectedFutureUse:'避免重复回调',
  applicability:['React effect'],exceptions:['独立后台任务'],evidence:[{id:'event-a',source:'gui-session',eventTime:1,verification:'test',turnId:'turn-a'}],
  createdAt:1,updatedAt:2,decisionReason:'有可复用方法，等待确认',history:[]};
function setup(rows:KnowledgeRecord[]=[record]) {
  const mock=currentApiMock();
  const api=mock.api.knowledge as unknown as KnowledgeApi;
  mock.mockOf('knowledge.list').mockResolvedValue({records:rows,pending:rows.filter(r=>r.status==='pending').length,active:rows.filter(r=>r.status==='active').length,history:rows.filter(r=>r.kind==='task_fact').length,startedAt:1});
  return {api,mock};
}

function snapshotOf(records:KnowledgeRecord[]):KnowledgeSnapshot {
 return {records,pending:records.filter(item=>item.status==='pending').length,active:records.filter(item=>item.status==='active').length,history:records.filter(item=>item.kind==='task_fact').length,startedAt:1};
}
function deletionOf(target:KnowledgeRecord):KnowledgeRecord {
 return {...target,status:'rejected',revision:target.revision+1,updatedAt:target.updatedAt+1,decisionReason:'用户删除：停止使用并阻止同义内容自动复活'};
}

test('翻译宿主生成的记忆状态说明，保留记录和用户原文',async()=>{
 const current={...record,status:'active' as const,decisionReason:'仅留历史：用户原始理由'};
 const {api}=setup([current]),user=userEvent.setup();
 const view=render(<KnowledgePanel api={api} workspaceKey="ws-a" sharedSnapshot={snapshotOf([current])}/>);
 await user.click(await screen.findByRole('button',{name:'查看依据与修订'}));
 expect(screen.getByText('仅留历史：用户原始理由')).toBeTruthy();
 try {
   act(()=>{applyLocaleSetting('en');});
   for(const key of KNOWLEDGE_DISPLAY_KEYS)expect(localizeKnowledgeHostText(key),key).not.toBe(key);
   for(const item of KNOWLEDGE_DISPLAY_TEMPLATES)expect(localizeKnowledgeHostText(`${item.prefix}原始内容`)).toContain('原始内容');
   expect(await screen.findByText('Kept only as history: 用户原始理由')).toBeTruthy();
   expect(screen.getByRole('heading',{name:record.summary})).toBeTruthy();
   expect(current.decisionReason).toBe('仅留历史：用户原始理由');
 } finally { view.unmount(); act(()=>{applyLocaleSetting('zh-CN');}); }
});

test('知识状态说明的动态身份和用户理由不被改写',()=>{
 try {
   act(()=>{applyLocaleSetting('en');});
   expect(localizeKnowledgeHostText('证据合并至 memory-123：用户原始理由')).toBe('Evidence merged into memory-123: 用户原始理由');
   expect(localizeKnowledgeHostText('保留差异（对照 memory-123）：保留用户条件')).toBe('Differences retained (compared with memory-123): 保留用户条件');
   expect(localizeKnowledgeHostText('原始依据、适用内容和策略未变化：pending；沿用原候选，不重复复评')).toBe('The original evidence, applicable content and policy are unchanged: pending. The original candidate is retained without another review.');
   expect(localizeKnowledgeHostText('关联依据：用户原始结论（含括号）（supports，仅一跳）')).toBe('Related evidence: 用户原始结论（含括号） (supports, one hop)');
   expect(localizeKnowledgeHostText('关联依据：用户原始结论（custom，仅一跳）')).toBe('关联依据：用户原始结论（custom，仅一跳）');
   expect(localizeKnowledgeHostText('本批已确认 1/3 条处理回执，剩余 2 条经补结算仍未取得回执；已保留确认结果，未完成项可重试')).toBe('Confirmed 1/3 receipts in this batch; 2 remain without receipts after reconciliation. Confirmed results are retained; unfinished items can be retried.');
   expect(localizeKnowledgeHostText('本批已确认 1/3 条处理回执，剩余 2 条；已保留确认结果。第三方错误；回执复核失败：原始详情')).toBe('Confirmed 1/3 receipts in this batch; 2 remain. Confirmed results are retained. 第三方错误; receipt review failed: 原始详情');
   expect(localizeKnowledgeHostText('本批已确认 1/3 条处理回执，剩余 2 条；已保留确认结果。draft.summary: 必须提供非空文本（最多1500字符）'))
     .toBe('Confirmed 1/3 receipts in this batch; 2 remain. Confirmed results are retained. draft.summary: nonempty text is required (maximum 1500 characters).');
   expect(localizeKnowledgeHostText('draft.applicability: 必须提供字符串数组\ndraft.problem: 必须为非空文本，最多1500字符'))
     .toBe('draft.applicability: an array of strings is required.\ndraft.problem: must be nonempty text, at most 1500 characters.');
   const draftCases = [
     ['draft.summary: 必须为文本，最多1500字符', 'draft.summary: must be text, at most 1500 characters.'],
     ['draft.exceptions: 必须提供字符串数组（无已知例外时使用[]）', 'draft.exceptions: an array of strings is required (use [] when there are no known exceptions).'],
     ['draft.searchKeys: 必须为字符串数组，最多12项', 'draft.searchKeys: must be an array of at most 12 strings.'],
     ['draft.searchKeys: 最多12项', 'draft.searchKeys: at most 12 items are allowed.'],
     ['draft.searchKeys[3]: 必须为非空文本，最多300字符', 'draft.searchKeys[3]: must be nonempty text, at most 300 characters.'],
     ['draft.repoKey: 必须为文本，最多500字符；实际写入范围仍由宿主绑定', 'draft.repoKey: must be text of at most 500 characters; the host still determines the write scope.']
   ];
   for (const [raw, english] of draftCases) expect(localizeKnowledgeHostText(raw)).toBe(english);
   expect(localizeKnowledgeHostText('draft.用户字段: 必须提供字符串数组')).toBe('draft.用户字段: 必须提供字符串数组');
   expect(localizeKnowledgeHostText('evidence[3].source: 必须为非空宿主来源文本，最多1000字符\nevidence[4].eventTime: 必须为有限数值事件时间'))
     .toBe('evidence[3].source: nonempty host source text is required, at most 1000 characters.\nevidence[4].eventTime: a finite event timestamp is required.');
   expect(localizeKnowledgeHostText('evidence[3].用户字段: 必须为有限数值事件时间')).toBe('evidence[3].用户字段: 必须为有限数值事件时间');
   const evidenceCases = [
     ['evidence[1]: 记忆证据必须由宿主提供可追溯事件对象', 'evidence[1]: the host must provide a traceable event object.'],
     ['evidence[1].branch: 必须为宿主来源文本，最多1000字符', 'evidence[1].branch: host source text is required, at most 1000 characters.'],
     ['evidence[1].verification: 必须为宿主绑定的unverified/test/integration/runtime/user_stated/user_confirmed等级', 'evidence[1].verification: use a host-bound unverified/test/integration/runtime/user_stated/user_confirmed level.'],
     ['evidence[1].id: 证据身份不能重复', 'evidence[1].id: evidence IDs must be unique.'],
     ['evidence[1].contentHash: 证据内容签名必须为64位小写十六进制哈希', 'evidence[1].contentHash: the content signature must be a 64-digit lowercase hexadecimal hash.'],
     ['evidence[1].excerpt: 证据摘录必须为文本，最多4000字符', 'evidence[1].excerpt: the excerpt must be text of at most 4000 characters.'],
     ['evidence[1].observation: 宿主观察类型仅允许tool_output或user_input', 'evidence[1].observation: the host observation type must be tool_output or user_input.']
   ];
   for (const [raw, english] of evidenceCases) expect(localizeKnowledgeHostText(raw)).toBe(english);
   expect(localizeKnowledgeHostText('本批已确认 1/3 条处理回执，剩余 2 条；已保留确认结果。用户停止使用'))
     .toBe('Confirmed 1/3 receipts in this batch; 2 remain. Confirmed results are retained. 用户停止使用');
   expect(localizeKnowledgeHostText('本批已确认 0/1 条处理回执，剩余 1 条；已保留确认结果。记忆会话缺少可用模型或凭据，请在模型设置中配置'))
     .toBe('Confirmed 0/1 receipts in this batch; 1 remain. Confirmed results are retained. The memory session has no available model or credentials. Configure them in model settings.');
   expect(localizeKnowledgeHostText('用户自行撰写的未知说明')).toBe('用户自行撰写的未知说明');
   act(()=>{applyLocaleSetting('zh-CN');});
   expect(localizeKnowledgeHostText('证据合并至 memory-123：用户原始理由')).toBe('证据合并至 memory-123：用户原始理由');
 } finally { act(()=>{applyLocaleSetting('zh-CN');}); }
});

test('用户确认当前记忆时等待真实版本回执并保留旧依据',async()=>{
 const active={...record,status:'active' as const},confirmed={...active,revision:active.revision+1,userManaged:true,
   evidence:[...active.evidence,{id:'confirmation',source:'memory-user-confirmation',eventTime:3,verification:'user_confirmed' as const}]};
 const {api,mock}=setup([active]),user=userEvent.setup();
 mock.mockOf('knowledge.confirm').mockResolvedValue(confirmed);
 render(<KnowledgePanel api={api} workspaceKey="ws-a"/>);
 await user.click(await screen.findByRole('button',{name:'确认当前记忆'}));
 expect(mock.mockOf('knowledge.confirm')).toHaveBeenCalledWith({id:active.id,revision:active.revision});
 expect(await screen.findByText('用户已确认，自动整理不会覆盖此版本。')).toBeTruthy();
});

test('复制通用经验先让用户检查，再等待成功回执；失败时保留编辑内容',async()=>{
 const active={...record,status:'active' as const},copy={...active,id:'host-copy',namespace:'host' as const,userManaged:true,repoKey:undefined,branch:undefined};
 const {api,mock}=setup([active]),user=userEvent.setup();
 mock.mockOf('knowledge.promoteHost').mockRejectedValueOnce(new Error('保存失败')).mockResolvedValueOnce(copy);
 render(<KnowledgePanel api={api} workspaceKey="ws-a"/>);
 await user.click(await screen.findByRole('button',{name:'复制为工作台通用经验'}));
 expect(screen.getByText(/此副本可被所有工作区读取/)).toBeTruthy();
 await user.click(screen.getByRole('button',{name:'确认复制到工作台'}));
 expect((await screen.findByRole('alert')).textContent).toContain('保存失败');
 expect(screen.getByRole('button',{name:'确认复制到工作台'})).toBeTruthy();
 await user.click(screen.getByRole('button',{name:'确认复制到工作台'}));
 await waitFor(()=>expect(mock.mockOf('knowledge.promoteHost')).toHaveBeenCalledTimes(2));
 await waitFor(()=>expect(screen.queryByRole('button',{name:'确认复制到工作台'})).toBeNull());
 expect(screen.getByText('工作台通用')).toBeTruthy();
});

test('旧环境值发生变化时显示记录值和当前值',async()=>{
 const active={...record,status:'active' as const,environmentCheck:{state:'stale' as const,dependencies:[{key:'appVersion' as const,recorded:'1.0',current:'2.0'}]}};
 const {api}=setup([active]);render(<KnowledgePanel api={api} workspaceKey="ws-a"/>);
 expect((await screen.findByText(/环境参数可能已变化，请重新核实/)).textContent).toContain('appVersion: 1.0 → 2.0');
});

test('evidence retains source and time and shows a test record only when one exists',async()=>{
 const evidence=[{...record.evidence[0],verification:'unverified' as const},{...record.evidence[0],id:'tested',verification:'test' as const}];
 const {api}=setup([{...record,status:'active',evidence}]);
 render(<KnowledgePanel api={api} workspaceKey="ws-a"/>);
 const user=userEvent.setup();
 await user.click(await screen.findByRole('button',{name:'查看依据与修订'}));
 const sources=screen.getAllByText(/第 \d 份依据 · gui-session/);
 expect(sources).toHaveLength(2);
 expect(sources[0].textContent).not.toMatch(/未验证|unverified|测试记录/);
 expect(sources[1].textContent).toContain('测试记录');
 expect(screen.getAllByRole('button',{name:'核对快照依据'})).toHaveLength(2);
});

test('user provided profile evidence is distinguished from explicit confirmation',async()=>{
 const profile={...record,kind:'user_profile' as const,namespace:'profile' as const,status:'active' as const,summary:'用户常用邮箱',
  evidence:[{id:'provided',source:'memory.note',eventTime:1,verification:'user_stated' as const}]};
 const {api}=setup([profile]),user=userEvent.setup();
 render(<KnowledgePanel api={api} workspaceKey="ws-a"/>);
 await user.click(await screen.findByRole('button',{name:'查看依据与修订'}));
 expect(screen.getByText(/第 1 份依据 · memory.note/).textContent).toContain('用户提供');
 expect(screen.queryByText('用户确认')).toBeNull();
 expect(screen.getByRole('button',{name:'确认当前记忆'})).toBeTruthy();
});

test('ordinary lists exclude retired records and history exposes retired records in a separate recoverable view',async()=>{
 const active={...record,status:'active' as const},paused={...active,id:'paused',status:'needs_revalidation' as const,summary:'暂停中的知识'};
 const archived={...active,id:'archived',status:'archived' as const,summary:'旧的归档知识'},superseded={...active,id:'superseded',status:'superseded' as const,summary:'旧的取代知识',history:[{revision:1,summary:'取代前的知识',status:'active' as const,at:1}]};
 const deleted={...deletionOf(active),id:'deleted',summary:'旧的删除知识'},fact={...active,id:'fact',kind:'task_fact' as const,status:'archived' as const,summary:'任务事实原文'};
 const rows=[active,paused,archived,superseded,deleted,fact],{api,mock}=setup(rows),user=userEvent.setup();
 render(<KnowledgePanel api={api} workspaceKey="ws-a" sharedSnapshot={{...snapshotOf(rows),deletedIds:[deleted.id]}}/>);
 await waitFor(()=>expect((screen.getByRole('button',{name:'刷新'}) as HTMLButtonElement).disabled).toBe(false));
 expect(screen.getAllByRole('article')).toHaveLength(2);
 for(const item of [archived,superseded,deleted,fact])expect(screen.queryByRole('heading',{name:item.summary})).toBeNull();
 await user.click(screen.getByRole('button',{name:'任务历史'}));
 expect(screen.getByRole('heading',{name:fact.summary})).toBeTruthy();
 expect(screen.queryByRole('heading',{name:deleted.summary})).toBeNull();
 await user.click(screen.getByRole('button',{name:'历史类型'}));await user.click(screen.getByRole('option',{name:'退场与删除记录'}));
 expect(screen.getByRole('button',{name:'历史类型'}).getAttribute('aria-expanded')).toBe('false');
 expect(screen.getAllByRole('article')).toHaveLength(3);expect(screen.getByText('已删除')).toBeTruthy();
 expect(screen.queryByRole('button',{name:'删除'})).toBeNull();expect(screen.queryByRole('button',{name:'修订内容与条件'})).toBeNull();
 expect(screen.queryByRole('button',{name:'按含义查找相关记忆'})).toBeNull();
 await user.type(screen.getByLabelText('搜索记忆'),'取代');
 expect(screen.getAllByRole('article')).toHaveLength(1);expect(screen.getByRole('heading',{name:superseded.summary})).toBeTruthy();
 await user.click(screen.getByRole('button',{name:'查看依据与历史'}));expect(screen.getByText(/修订历史/)).toBeTruthy();
 await user.click(screen.getByRole('button',{name:'收起依据'}));
 await user.clear(screen.getByLabelText('搜索记忆'));
 await user.click(screen.getByRole('button',{name:'历史类型'}));await user.click(screen.getByRole('option',{name:'任务事实'}));
 expect(screen.getByRole('heading',{name:fact.summary})).toBeTruthy();expect(screen.queryByRole('heading',{name:deleted.summary})).toBeNull();
 expect(mock.mockOf('knowledge.historySources')).not.toHaveBeenCalled();
});

test('deletion waits for a real receipt then survives slow refresh and stale shared snapshots',async()=>{
 const active={...record,status:'active' as const},{api,mock}=setup([active]),user=userEvent.setup();
 const view=render(<KnowledgePanel api={api} workspaceKey="ws-a" sharedSnapshot={snapshotOf([active])}/>);
 await waitFor(()=>expect((screen.getByRole('button',{name:'刷新'}) as HTMLButtonElement).disabled).toBe(false));
 let finishDelete!:(value:KnowledgeRecord)=>void,finishRefresh!:(value:KnowledgeSnapshot)=>void;
 mock.mockOf('knowledge.decide').mockReturnValueOnce(new Promise(resolve=>{finishDelete=resolve;}));
 mock.mockOf('knowledge.list').mockReturnValueOnce(new Promise(resolve=>{finishRefresh=resolve;}));
 await user.click(screen.getByRole('button',{name:'删除'}));
 expect(screen.getByRole('heading',{name:active.summary})).toBeTruthy();
 await act(async()=>finishDelete(deletionOf(active)));
 expect(screen.queryByRole('heading',{name:active.summary})).toBeNull();
 expect((screen.getByRole('button',{name:'刷新'}) as HTMLButtonElement).disabled).toBe(true);
 view.rerender(<KnowledgePanel api={api} workspaceKey="ws-a" sharedSnapshot={snapshotOf([{...active}])}/>);
 expect(screen.queryByRole('heading',{name:active.summary})).toBeNull();
 await act(async()=>finishRefresh(snapshotOf([active])));
 expect(screen.queryByRole('heading',{name:active.summary})).toBeNull();
 await user.click(screen.getByRole('button',{name:'刷新'}));
 await waitFor(()=>expect((screen.getByRole('button',{name:'刷新'}) as HTMLButtonElement).disabled).toBe(false));
 expect(screen.queryByRole('heading',{name:active.summary})).toBeNull();
});

test('old semantic hits cannot revive a successfully deleted record',async()=>{
 const active={...record,status:'active' as const},{api,mock}=setup([active]),user=userEvent.setup();
 const hit={record:active,score:1,reason:'semantic',applicability:'needs_check'};
 mock.mockOf('knowledge.search').mockResolvedValue([hit]);mock.mockOf('knowledge.decide').mockResolvedValue(deletionOf(active));
 render(<KnowledgePanel api={api} workspaceKey="ws-a"/>);
 await screen.findByRole('heading',{name:active.summary});
 await user.click(screen.getByRole('button',{name:'记忆范围'}));await user.click(screen.getByRole('option',{name:'工作区共享'}));
 await user.type(screen.getByLabelText('搜索记忆'),'离开页面后仍收到回调');
 await user.click(screen.getByRole('button',{name:'按含义查找相关记忆'}));
 await screen.findByRole('heading',{name:active.summary});await user.click(screen.getByRole('button',{name:'删除'}));
 await waitFor(()=>expect((screen.getByRole('button',{name:'刷新'}) as HTMLButtonElement).disabled).toBe(false));
 expect(screen.queryByRole('heading',{name:active.summary})).toBeNull();
 await user.click(screen.getByRole('button',{name:'按含义查找相关记忆'}));
 await waitFor(()=>expect(mock.mockOf('knowledge.search')).toHaveBeenCalledTimes(2));
 expect(screen.queryByRole('heading',{name:active.summary})).toBeNull();
});

test('a late semantic response is checked against the latest deletion snapshot',async()=>{
 const active={...record,status:'active' as const},{api,mock}=setup([active]),user=userEvent.setup();
 const view=render(<KnowledgePanel api={api} workspaceKey="ws-a" sharedSnapshot={snapshotOf([active])}/>);
 await waitFor(()=>expect((screen.getByRole('button',{name:'刷新'}) as HTMLButtonElement).disabled).toBe(false));
 let finishSearch!:(value:any[])=>void;
 mock.mockOf('knowledge.search').mockReturnValueOnce(new Promise(resolve=>{finishSearch=resolve;})).mockResolvedValue([]);
 await user.type(screen.getByLabelText('搜索记忆'),'不同的问法');await user.click(screen.getByRole('button',{name:'按含义查找相关记忆'}));
 view.rerender(<KnowledgePanel api={api} workspaceKey="ws-a" sharedSnapshot={{...snapshotOf([deletionOf(active)]),deletedIds:[active.id]}}/>);
 await act(async()=>finishSearch([{record:active,score:1,reason:'semantic',applicability:'needs_check'}]));
 expect(screen.queryByRole('heading',{name:active.summary})).toBeNull();
});

test.each([undefined,{...record,status:'active' as const,revision:3},{...deletionOf(record),id:'wrong-record'}])('an invalid deletion receipt keeps the original card and reports failure (%s)',async receipt=>{
 const {api,mock}=setup();mock.mockOf('knowledge.decide').mockResolvedValueOnce(receipt);const user=userEvent.setup();
 render(<KnowledgePanel api={api} workspaceKey="ws-a"/>);
 await user.click(await screen.findByRole('button',{name:'删除'}));
 expect((await screen.findByRole('alert')).textContent).toContain('删除未返回有效回执');
 expect(screen.getByRole('heading',{name:record.summary})).toBeTruthy();expect(mock.mockOf('knowledge.list')).toHaveBeenCalledTimes(1);
});

test('a confirmed deletion stays removed when the following refresh fails',async()=>{
 const {api,mock}=setup(),user=userEvent.setup();mock.mockOf('knowledge.decide').mockResolvedValue(deletionOf(record));
 render(<KnowledgePanel api={api} workspaceKey="ws-a"/>);await screen.findByRole('heading',{name:record.summary});
 mock.mockOf('knowledge.list').mockRejectedValueOnce(new Error('存储暂不可读'));
 await user.click(screen.getByRole('button',{name:'删除'}));
 expect((await screen.findByRole('alert')).textContent).toContain('存储暂不可读');
 expect(screen.getByRole('alert').textContent).toContain('已确认的删除仍然生效');
 expect(screen.getByText('已删除，不再参与自动召回。')).toBeTruthy();
 expect(screen.queryByRole('heading',{name:record.summary})).toBeNull();
});

test('only a newer authoritative restore can supersede a confirmed deletion',async()=>{
 const active={...record,status:'active' as const},{api,mock}=setup([active]),user=userEvent.setup();
 mock.mockOf('knowledge.decide').mockResolvedValue(deletionOf(active));
 const view=render(<KnowledgePanel api={api} workspaceKey="ws-a" sharedSnapshot={snapshotOf([active])}/>);
 await waitFor(()=>expect((screen.getByRole('button',{name:'刷新'}) as HTMLButtonElement).disabled).toBe(false));
 await user.click(screen.getByRole('button',{name:'删除'}));
 await waitFor(()=>expect(screen.queryByRole('heading',{name:active.summary})).toBeNull());
 const restored={...active,revision:4,updatedAt:4};
 view.rerender(<KnowledgePanel api={api} workspaceKey="ws-a" sharedSnapshot={{...snapshotOf([restored]),deletedIds:[]}}/>);
 expect(screen.getByRole('heading',{name:restored.summary})).toBeTruthy();expect(screen.getByText('r4')).toBeTruthy();
 view.rerender(<KnowledgePanel api={api} workspaceKey="ws-a" sharedSnapshot={{...snapshotOf([deletionOf(active)]),deletedIds:[active.id]}}/>);
 expect(screen.getByRole('heading',{name:restored.summary})).toBeTruthy();expect(screen.getByText('r4')).toBeTruthy();
});

test('a late failed deletion cannot hide records or report errors in another workspace',async()=>{
 const {api,mock}=setup(),user=userEvent.setup();let rejectDelete!:(error:Error)=>void;
 mock.mockOf('knowledge.decide').mockReturnValueOnce(new Promise((_resolve,reject)=>{rejectDelete=reject;}));
 const view=render(<KnowledgePanel api={api} workspaceKey="old"/>);
 await user.click(await screen.findByRole('button',{name:'删除'}));
 mock.mockOf('knowledge.list').mockResolvedValue(snapshotOf([{...record,summary:'另一个工作区的知识'}]));
 view.rerender(<KnowledgePanel api={api} workspaceKey="new"/>);
 await screen.findByRole('heading',{name:'另一个工作区的知识'});
 await act(async()=>rejectDelete(new Error('旧工作区删除失败')));
 expect(screen.queryByRole('alert')).toBeNull();expect(screen.getByRole('heading',{name:'另一个工作区的知识'})).toBeTruthy();
});

test('clearing an entry route search and changing its scope survive shared snapshot refresh',async()=>{
 const target={...record,status:'active' as const},other={...target,id:'scheduler-memory',namespace:'scheduler' as const,summary:'调度的独立知识'};
 const {api}=setup([target,other]),user=userEvent.setup();
 const view=render(<KnowledgePanel api={api} workspaceKey="ws-a" focusEntryId={target.id} sharedSnapshot={null}/>);
 await waitFor(()=>expect((screen.getByRole('button',{name:'刷新'}) as HTMLButtonElement).disabled).toBe(false));
 view.rerender(<KnowledgePanel api={api} workspaceKey="ws-a" focusEntryId={target.id} sharedSnapshot={snapshotOf([target,other])}/>);
 const search=screen.getByLabelText('搜索记忆') as HTMLInputElement;
 await waitFor(()=>expect(search.value).toBe(target.summary));
 expect(screen.getByRole('button',{name:'记忆范围'}).textContent).toContain('工作区共享');
 await user.clear(search);
 await user.click(screen.getByRole('button',{name:'记忆范围'}));await user.click(screen.getByRole('option',{name:'调度专用'}));
 view.rerender(<KnowledgePanel api={api} workspaceKey="ws-a" focusEntryId={target.id} sharedSnapshot={snapshotOf([{...target,summary:'刷新的知识标题',revision:3},other])}/>);
 expect(search.value).toBe('');
 expect(screen.getByRole('button',{name:'记忆范围'}).textContent).toContain('调度专用');
 expect(screen.getByRole('heading',{name:other.summary})).toBeTruthy();
 expect(screen.queryByRole('heading',{name:'刷新的知识标题'})).toBeNull();
});

test('entry routes focus an available target once and wait for a new target to arrive',async()=>{
 const target={...record,status:'active' as const},next={...target,id:'later-memory',namespace:'scheduler' as const,kind:'task_fact' as const,summary:'稍后载入的任务事实'};
 const {api}=setup([target]),user=userEvent.setup();
 const view=render(<KnowledgePanel api={api} workspaceKey="ws-a" focusEntryId={target.id} sharedSnapshot={snapshotOf([target])}/>);
 const search=screen.getByLabelText('搜索记忆') as HTMLInputElement;
 await waitFor(()=>expect(search.value).toBe(target.summary));
 await user.clear(search);await user.type(search,'自己的查询');
 view.rerender(<KnowledgePanel api={api} workspaceKey="ws-a" focusEntryId={next.id} sharedSnapshot={snapshotOf([target])}/>);
 expect(search.value).toBe('自己的查询');
 view.rerender(<KnowledgePanel api={api} workspaceKey="ws-a" focusEntryId={next.id} sharedSnapshot={snapshotOf([target,next])}/>);
 await waitFor(()=>expect(search.value).toBe(next.summary));
 expect(screen.getByRole('button',{name:'记忆范围'}).textContent).toContain('调度专用');
 expect(screen.getByRole('button',{name:'任务历史'}).getAttribute('aria-pressed')).toBe('true');
 expect(screen.getByRole('heading',{name:next.summary})).toBeTruthy();
 await user.clear(search);
 view.rerender(<KnowledgePanel api={api} workspaceKey="ws-a" focusEntryId={next.id} sharedSnapshot={snapshotOf([target,{...next,revision:3}])}/>);
 expect(search.value).toBe('');
});

test('an initial namespace is not restored over user filters by shared snapshot refresh',async()=>{
 const profile={...record,id:'preference',namespace:'profile' as const,kind:'user_preference' as const,status:'active' as const,summary:'简洁回答偏好'};
 const worker={...record,status:'active' as const,summary:'简洁事件清理'};
 const {api}=setup([profile,worker]),user=userEvent.setup();
 const view=render(<KnowledgePanel api={api} workspaceKey="ws-a" initialNamespace="profile" sharedSnapshot={snapshotOf([profile,worker])}/>);
 await waitFor(()=>expect((screen.getByRole('button',{name:'刷新'}) as HTMLButtonElement).disabled).toBe(false));
 expect(screen.getByRole('button',{name:'记忆范围'}).textContent).toContain('用户画像');
 expect(screen.queryByRole('heading',{name:worker.summary})).toBeNull();
 await user.click(screen.getByRole('button',{name:'记忆范围'}));await user.click(screen.getByRole('option',{name:'全部范围'}));
 await user.type(screen.getByLabelText('搜索记忆'),'简洁');
 view.rerender(<KnowledgePanel api={api} workspaceKey="ws-a" initialNamespace="profile" sharedSnapshot={snapshotOf([{...profile,revision:3},worker])}/>);
 expect((screen.getByLabelText('搜索记忆') as HTMLInputElement).value).toBe('简洁');
 expect(screen.getByRole('button',{name:'记忆范围'}).textContent).toContain('全部范围');
 expect(screen.getByRole('heading',{name:worker.summary})).toBeTruthy();
});

test('profile scope shows both personal information and existing preferences',async()=>{
 const profile={...record,id:'personal-info',namespace:'profile' as const,kind:'user_profile' as const,status:'active' as const,summary:'常用邮箱 alice@example.com'};
 const preference={...record,id:'preference',namespace:'profile' as const,kind:'user_preference' as const,status:'active' as const,summary:'简洁回答偏好'};
 const worker={...record,id:'worker',status:'active' as const,summary:'工作区专用内容'};
 const {api}=setup([profile,preference,worker]);
 render(<KnowledgePanel api={api} workspaceKey="ws-a" initialNamespace="profile" sharedSnapshot={snapshotOf([profile,preference,worker])}/>);
 await waitFor(()=>expect(screen.getByRole('heading',{name:profile.summary})).toBeTruthy());
 expect(screen.getByRole('heading',{name:preference.summary})).toBeTruthy();
 expect(screen.queryByRole('heading',{name:worker.summary})).toBeNull();
 expect(screen.getByText('用户信息')).toBeTruthy();
});

test('entry navigation after a workspace switch waits for that workspace snapshot',async()=>{
 const target={...record,status:'active' as const},next={...target,summary:'新工作区中同 ID 的知识'};
 const {api,mock}=setup([target]);
 const view=render(<KnowledgePanel api={api} workspaceKey="old" focusEntryId={target.id}/>);
 await waitFor(()=>expect((screen.getByLabelText('搜索记忆') as HTMLInputElement).value).toBe(target.summary));
 let resolveNew!:(value:KnowledgeSnapshot)=>void;
 mock.mockOf('knowledge.list').mockReturnValueOnce(new Promise(resolve=>{resolveNew=resolve;}));
 view.rerender(<KnowledgePanel api={api} workspaceKey="new" focusEntryId={target.id}/>);
 expect((screen.getByLabelText('搜索记忆') as HTMLInputElement).value).toBe('');
 expect(screen.queryByRole('heading',{name:target.summary})).toBeNull();
 await act(async()=>resolveNew(snapshotOf([next])));
 expect((screen.getByLabelText('搜索记忆') as HTMLInputElement).value).toBe(next.summary);
 expect(screen.getByRole('heading',{name:next.summary})).toBeTruthy();
});

test('a revision refresh clears evidence loading and ignores the old diff',async()=>{
 const active={...record,status:'active' as const};const {api,mock}=setup([active]);
 let resolveEvidence!:(value:any)=>void;
 mock.mockOf('knowledge.evidence').mockReturnValue(new Promise(resolve=>{resolveEvidence=resolve;}));
 const user=userEvent.setup();render(<KnowledgePanel api={api} workspaceKey="ws-a"/>);
 await screen.findByRole('heading',{name:active.summary});
 await user.click(screen.getByRole('button',{name:'查看依据与修订'}));
 await user.click(screen.getByRole('button',{name:'核对快照依据'}));
 expect(screen.getByText('正在读取轮次快照…')).toBeTruthy();
 mock.mockOf('knowledge.list').mockResolvedValue({records:[{...active,revision:active.revision+1}],active:1,pending:0,history:0,startedAt:1});
 await user.click(screen.getByRole('button',{name:'刷新'}));
 await waitFor(()=>expect(screen.queryByText('正在读取轮次快照…')).toBeNull());
 expect((screen.getByRole('button',{name:'核对快照依据'}) as HTMLButtonElement).disabled).toBe(false);
 await act(async()=>resolveEvidence({status:'available',diff:'旧版本错误Diff',files:[]}));
 expect(screen.queryByText('旧版本错误Diff')).toBeNull();
});
test('original history is loaded only on request and searches the selected source',async()=>{
  const {api,mock}=setup([]);mock.mockOf('knowledge.historySources').mockResolvedValue([{id:'old',name:'旧会话',namespace:'worker'}]);
  mock.mockOf('knowledge.history').mockResolvedValue({messages:[{id:'turn-old',role:'user',text:'第二版使用取消订阅函数',at:1,state:'原始记录'}],truncated:false});
  const user=userEvent.setup();render(<KnowledgePanel api={api} workspaceKey="ws-a"/>);
  await user.click(await screen.findByRole('button',{name:'任务历史'}));
  expect(mock.mockOf('knowledge.historySources')).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'查询原始会话（含切换前历史）'}));
  await user.click(await screen.findByRole('button',{name:'原始会话'}));
  await user.click(screen.getByRole('option',{name:'旧会话'}));
  expect(screen.getByLabelText('历史关键词').classList.contains('ui-input')).toBe(true);
  await user.type(screen.getByLabelText('历史关键词'),'第二版');
  await user.keyboard('{Enter}');
  expect(await screen.findByText('第二版使用取消订阅函数')).toBeTruthy();
  expect(mock.mockOf('knowledge.history')).toHaveBeenCalledWith({sessionId:'old',query:'第二版'});
  expect(mock.mockOf('knowledge.govern')).not.toHaveBeenCalled();
});
test('translates host history labels and a host truncation marker without changing original text', async () => {
  const marker = '[正文超过4000字，余下内容请在原会话查看]';
  const messages = [
    { id: 'one', role: 'user', text: `用户原文\n${marker}`, textTruncated: true, state: '原始记录', at: 1 },
    { id: 'two', role: 'user', text: `用户自己写的 ${marker}`, state: '已中止', at: 2 }
  ];
  const api = {
    historySources: vi.fn(async () => [{ id: 'scheduler', name: '调度原始会话', namespace: 'scheduler' }]),
    history: vi.fn(async () => ({ messages, truncated: false }))
  } as unknown as KnowledgeApi;
  const view = render(<KnowledgeHistory api={api} />);
  try {
    fireEvent.click(screen.getByRole('button', { name: '查询原始会话（含切换前历史）' }));
    await waitFor(() => expect(api.historySources).toHaveBeenCalledOnce());
    await waitFor(() => expect((screen.getByRole('button', { name: '查询原文' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '查询原文' }));
    await screen.findByText((_content, node) => node?.tagName === 'PRE' && node.textContent === `用户原文\n${marker}`);
    act(() => { applyLocaleSetting('en'); });
    expect(screen.getByRole('button', { name: 'Original conversation' }).textContent).toContain('Dispatcher · Original scheduler conversation');
    expect(screen.getByText(/Original record/)).toBeTruthy();
    expect(screen.getByText(/Aborted/)).toBeTruthy();
    expect(screen.getByText((_content, node) => node?.tagName === 'PRE' && node.textContent === '用户原文\n[Text exceeds 4,000 characters. View the rest in the original conversation.]')).toBeTruthy();
    expect(screen.getByText(`用户自己写的 ${marker}`)).toBeTruthy();
    expect(messages[0].text).toBe(`用户原文\n${marker}`);
  } finally { view.unmount(); act(() => { applyLocaleSetting('zh-CN'); }); }
});
test('entry rendering retains the thirty-record bound',async()=>{
  const {api}=setup(Array.from({length:31},(_,i)=>({...record,id:`r${i}`,summary:`订阅清理方案 ${i}`})));
  const user=userEvent.setup();render(<KnowledgePanel api={api} workspaceKey="ws-a"/>);
  await screen.findByRole('heading',{name:'订阅清理方案 0'});
  expect(screen.getAllByRole('article').length).toBe(30);
  await user.click(screen.getByRole('button',{name:'再显示 30 条（共 31 条）'}));
  expect(screen.getAllByRole('article').length).toBe(31);
});
test('revision preserves structured lesson and edits conditions',async()=>{
  const {api,mock}=setup();const user=userEvent.setup();render(<KnowledgePanel api={api} workspaceKey="ws-a"/>);
  await user.click(await screen.findByRole('button',{name:'修订内容与条件'}));
  const conditions=screen.getByLabelText('适用条件（每行一条）');await user.clear(conditions);await user.type(conditions,'React 18');
  await user.click(screen.getByRole('button',{name:'保存并生效'}));
  expect(mock.mockOf('knowledge.revise')).toHaveBeenCalledWith(expect.objectContaining({id:'memory-a',revision:2,draft:expect.objectContaining({action:record.action,applicability:['React 18']})}));
});
test('workspace switch ignores a late list response',async()=>{
  const {api,mock}=setup();let resolveOld!:(value:unknown)=>void;
  mock.mockOf('knowledge.list').mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;})).mockResolvedValue({records:[],pending:0,active:0,history:0,startedAt:2});
  const view=render(<KnowledgePanel api={api} workspaceKey="old"/>);
  view.rerender(<KnowledgePanel api={api} workspaceKey="new"/>);
  await screen.findByText('目前没有匹配的知识');
  resolveOld({records:[{...record,status:'active'}],pending:0,active:1,history:0,startedAt:1});
  await waitFor(()=>expect(screen.queryByRole('heading',{name:record.summary})).toBeNull());
});

test('semantic search does not discard nonliteral matches',async()=>{
  const active={...record,status:'active' as const};const {api,mock}=setup([active]);
  mock.mockOf('knowledge.search').mockResolvedValue([{record:active,score:1,reason:'semantic',applicability:'needs_check'}]);
  const user=userEvent.setup();render(<KnowledgePanel api={api} workspaceKey="ws-a"/>);
  await screen.findByRole('heading',{name:active.summary});
  await user.click(screen.getByRole('button',{name:'记忆范围'}));
  await user.click(screen.getByRole('option',{name:'工作区共享'}));
  await user.type(screen.getByLabelText('搜索记忆'),'页面离开后还收到事件');
  expect(screen.queryByRole('heading',{name:active.summary})).toBeNull();
  await user.click(screen.getByRole('button',{name:'按含义查找相关记忆'}));
  expect(await screen.findByRole('heading',{name:active.summary})).toBeTruthy();
  expect(mock.mockOf('knowledge.search')).toHaveBeenCalledWith(expect.objectContaining({namespace:'worker',mode:'task'}));
});

test('automatic knowledge has only evidence, optional correction and delete actions',async()=>{
 const {api,mock}=setup([record,{...record,id:'active',status:'active',summary:'已生效知识'}]);
 const user=userEvent.setup();render(<KnowledgePanel api={api} workspaceKey="ws-a"/>);
 await screen.findByRole('heading',{name:record.summary});
 expect(screen.queryByRole('button',{name:/确认生效|不值得保留|标记需复核|恢复到待确认|确认取代|合并证据/})).toBeNull();
 expect(screen.getAllByRole('button',{name:'删除'})).toHaveLength(2);
 mock.mockOf('knowledge.decide').mockResolvedValue(deletionOf(record));
 mock.mockOf('knowledge.list').mockResolvedValue({records:[],active:0,pending:0,history:0,startedAt:1});
 await user.click(screen.getAllByRole('button',{name:'删除'})[0]);
 expect(mock.mockOf('knowledge.decide')).toHaveBeenCalledWith({id:record.id,revision:record.revision,decision:'archive'});
 await screen.findByText('目前没有匹配的知识');
 expect(mock.mockOf('knowledge.govern')).not.toHaveBeenCalled();expect(mock.mockOf('knowledge.restore')).not.toHaveBeenCalled();
});

test('stale deletion keeps the record visible and reports the actual failure',async()=>{
 const {api,mock}=setup();mock.mockOf('knowledge.decide').mockRejectedValue(new Error('记忆已变化'));
 const user=userEvent.setup();render(<KnowledgePanel api={api} workspaceKey="ws-a"/>);
 await user.click(await screen.findByRole('button',{name:'删除'}));
 expect((await screen.findByRole('alert')).textContent).toContain('记忆已变化');
 expect(screen.getByRole('heading',{name:record.summary})).toBeTruthy();
});

test('unavailable source remains explicit and historical versions have an explicit restore action',async()=>{
 const {api,mock}=setup([{...record,history:[{revision:1,summary:'旧结论',status:'active',at:1}]}]);
 mock.mockOf('knowledge.evidence').mockResolvedValue({status:'unavailable',reason:'快照已清理'});
 const user=userEvent.setup();render(<KnowledgePanel api={api} workspaceKey="ws-a"/>);
 await user.click(await screen.findByRole('button',{name:'查看依据与修订'}));
 await user.click(screen.getByRole('button',{name:'核对快照依据'}));
 expect(await screen.findByText('依据不可用：快照已清理')).toBeTruthy();
 expect(screen.getByRole('button',{name:'恢复版本 r1'})).toBeTruthy();
 expect(mock.mockOf('knowledge.restore')).not.toHaveBeenCalled();
});

test('known snapshot evidence errors follow the interface language without changing the response',async()=>{
 const {api,mock}=setup([{...record,status:'active'}]);
 const response={status:'unavailable' as const,reason:'证据仓库或分支范围未知、变化或不匹配'};
 mock.mockOf('knowledge.evidence').mockResolvedValue(response);
 const user=userEvent.setup(); const view=render(<KnowledgePanel api={api} workspaceKey="ws-a"/>);
 await user.type(await screen.findByLabelText('搜索记忆'),'订阅');
 await user.click(await screen.findByRole('button',{name:'查看依据与修订'}));
 await user.click(screen.getByRole('button',{name:'核对快照依据'}));
 expect(await screen.findByText(`依据不可用：${response.reason}`)).toBeTruthy();
 await user.click(screen.getByRole('button',{name:'修订内容与条件'}));
 fireEvent.change(screen.getByLabelText('记忆结论'),{target:{value:'未保存草稿'}});
 try {
   act(()=>{applyLocaleSetting('en');});
   expect(await screen.findByText('Source unavailable: The evidence repository or branch scope is unknown, changed or does not match.')).toBeTruthy();
   expect((screen.getByLabelText('Search memories') as HTMLInputElement).value).toBe('订阅');
   expect((screen.getByLabelText('Memory statement') as HTMLTextAreaElement).value).toBe('未保存草稿');
   expect(mock.mockOf('knowledge.list')).toHaveBeenCalledTimes(1);
   expect(response.reason).toBe('证据仓库或分支范围未知、变化或不匹配');
 } finally {view.unmount();act(()=>{applyLocaleSetting('zh-CN');});}
});

test('a stopped policy is shown as suspended before bounded compensation changes the stored status',async()=>{
 const active={...record,status:'active' as const};const {api,mock}=setup([active]);
 mock.mockOf('knowledge.list').mockResolvedValue({records:[active],policySuppressedIds:[active.id],active:0,pending:0,history:0,startedAt:1});
 const user=userEvent.setup();render(<KnowledgePanel api={api} workspaceKey="ws-a"/>);
 expect(await screen.findByText('策略已停用，暂停使用')).toBeTruthy();
 await user.click(screen.getByRole('button',{name:'记忆状态'}));await user.click(screen.getByRole('option',{name:'已生效'}));
 expect(screen.queryByRole('heading',{name:active.summary})).toBeNull();
 await user.click(screen.getByRole('button',{name:'记忆状态'}));await user.click(screen.getByRole('option',{name:'已暂停'}));
 expect(await screen.findByRole('heading',{name:active.summary})).toBeTruthy();
 expect(screen.getByRole('button',{name:'删除'})).toBeTruthy();
});

test('user correction takes effect from its receipt, survives stale snapshots and can be undone while processing is paused',async()=>{
 const active={...record,status:'active' as const};const {api,mock}=setup([active]),user=userEvent.setup();
 const stale={...snapshotOf([active]),policySuppressedIds:[active.id],processing:{pending:1,failed:0,errors:[],running:false,paused:true}};
 const view=render(<KnowledgePanel api={api} workspaceKey="ws-a" sharedSnapshot={stale}/>);
 await user.click(await screen.findByRole('button',{name:'修订内容与条件'}));
 const input=screen.getByLabelText('记忆结论');await user.clear(input);await user.type(input,'仅在组件卸载时清理订阅');
 const revised={...active,summary:'仅在组件卸载时清理订阅',revision:3,userManaged:true,history:[{revision:2,summary:active.summary,status:active.status,at:2}]};
 mock.mockOf('knowledge.revise').mockResolvedValue(revised);
 await user.click(screen.getByRole('button',{name:'保存并生效'}));
 expect(await screen.findByRole('heading',{name:revised.summary})).toBeTruthy();
 expect(screen.getByRole('status').textContent).toContain('已保存 r3 · 已生效');
 expect(screen.queryByText('策略已停用，暂停使用')).toBeNull();
 view.rerender(<KnowledgePanel api={api} workspaceKey="ws-a" sharedSnapshot={{...stale}}/>);
 expect(screen.getByRole('heading',{name:revised.summary})).toBeTruthy();
 mock.mockOf('knowledge.restore').mockResolvedValue({...active,revision:4,userManaged:true});
 await user.click(screen.getByRole('button',{name:'撤销本次修改'}));
 expect(mock.mockOf('knowledge.restore')).toHaveBeenCalledWith({id:active.id,revision:3,fromRevision:2});
 expect(await screen.findByRole('heading',{name:active.summary})).toBeTruthy();
 expect(mock.mockOf('knowledge.process')).not.toHaveBeenCalled();
});

test('stop and explicit historical restore use current revisions and wait for receipts',async()=>{
 const active={...record,status:'active' as const},stopped={...active,revision:3,status:'needs_revalidation' as const,userManaged:true,history:[{revision:2,summary:active.summary,status:active.status,at:2}]};
 const {api,mock}=setup([active]),user=userEvent.setup();
 let complete!:(record:KnowledgeRecord)=>void;mock.mockOf('knowledge.decide').mockReturnValueOnce(new Promise(resolve=>{complete=resolve;}));
 render(<KnowledgePanel api={api} workspaceKey="ws-a"/>);
 await user.click(await screen.findByRole('button',{name:'停止使用'}));
 expect(screen.getByText('已生效')).toBeTruthy();
 await act(async()=>complete(stopped));
 expect(screen.getByRole('status').textContent).toContain('已暂停');
 expect(mock.mockOf('knowledge.decide')).toHaveBeenCalledWith({id:active.id,revision:2,decision:'revalidate'});
 await user.click(screen.getByRole('button',{name:'查看依据与修订'}));
 mock.mockOf('knowledge.restore').mockResolvedValue({...active,revision:4,userManaged:true});
 await user.click(screen.getByRole('button',{name:'恢复版本 r2'}));
 expect(mock.mockOf('knowledge.restore')).toHaveBeenCalledWith({id:active.id,revision:3,fromRevision:2});
 expect(screen.getByRole('status').textContent).toContain('已保存 r4 · 已生效');
});

test.each([undefined,{...record,id:'wrong',revision:3}])('invalid correction receipt retains the edit draft (%s)',async receipt=>{
 const {api,mock}=setup(),user=userEvent.setup();mock.mockOf('knowledge.revise').mockResolvedValue(receipt);
 render(<KnowledgePanel api={api} workspaceKey="ws-a"/>);
 await user.click(await screen.findByRole('button',{name:'修订内容与条件'}));
 await user.click(screen.getByRole('button',{name:'保存并生效'}));
 expect((await screen.findByRole('alert')).textContent).toContain('有效版本回执');
 expect(screen.getByRole('button',{name:'保存并生效'})).toBeTruthy();
 expect(screen.getByRole('heading',{name:record.summary})).toBeTruthy();
});
