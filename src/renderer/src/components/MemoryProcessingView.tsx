import { ErrorTip, ErrorTipDetails } from './ErrorTip';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localizeKnowledgeHostText } from '../../../shared/knowledgeDisplayText';
import type { KnowledgeSnapshot } from '../../../shared/knowledge';
import type { MemoryCuratorQueueEntry, MemoryCuratorQueuePage, MemoryCuratorQueueQuery, MemoryCuratorSnapshot } from '../../../shared/memoryCurator';
import { requestMemoryCenterTab } from '../memoryCenterRoute';

const FILTERS = [{id:'attention',label:'待关注'},{id:'queued',label:'待处理'},{id:'failed',label:'失败'},{id:'done',label:'已处理'},{id:'all',label:'全部记录'},{id:'archived',label:'已归档'}] as const;
type Filter = NonNullable<MemoryCuratorQueueQuery['state']> | 'archived';
const STATES = {pending:'等待整理',running:'正在整理',deferred:'等待重试',failed:'处理失败',done:'已处理'};
const RESULTS: Record<string,string> = {active:'已生效',duplicate:'已有相同知识',retained_ephemeral:'仅留任务历史',discarded:'未保留',suspended:'已暂停',superseded:'已取代',rejected:'未采用'};
const SCOPES = {worker:'工作区共享',scheduler:'调度专用',profile:'用户画像',host:'工作台通用'};
const CORRECTION_RESULTS: Record<string,string> = {updated:'已更正并生效',suspended:'已暂停原记忆',rejected:'更正未采用',discarded:'更正未采用',needs_user:'审查完成，待你处理'};
const KINDS = {task_fact:'任务历史',stable_constraint:'持续约束',user_preference:'用户偏好',user_profile:'用户信息',reusable_lesson:'可复用经验'};
function entryStatus(item:MemoryCuratorQueueEntry):string {
  if(item.correction)return item.state==='done'?CORRECTION_RESULTS[item.result?.disposition??'']??'审查完成，结果待核对':STATES[item.state];
  return item.result?.disposition?RESULTS[item.result.disposition]??STATES[item.state]:STATES[item.state];
}

function CorrectionDetails({item}:{item:MemoryCuratorQueueEntry}):React.JSX.Element|null {
  const {t}=useTranslation();
  if(!item.correction)return null;
  const correction=item.correction, result=item.state==='done'?item.result:undefined;
  const proposal=result?.disposition==='needs_user'?result.proposedCorrection:undefined;
  return <div className="knowledge-details">
    <p>{t('原记忆：{{id}} · 提交时版本 r{{revision}}',{id:correction.memoryId,revision:correction.revision})}</p>
    <p className="memory-processing-text"><strong>{t('更正问题：')}</strong>{correction.problem}</p>
    <p className="memory-processing-text"><strong>{t('核查线索：')}</strong>{correction.evidence}</p>
    {correction.suggestion?<p className="memory-processing-text"><strong>{t('提交建议（未经审查）：')}</strong>{correction.suggestion}</p>:null}
    {item.state==='done'?<>
      {result?.targetId&&result.targetRevision!==undefined?<p>{t('审查目标：{{id}} · r{{revision}}',{id:result.targetId,revision:result.targetRevision})}</p>:null}
      {result&&['updated','suspended'].includes(result.disposition??'')&&result.recordId&&result.recordRevision!==undefined?<p>{t('结果版本：{{id}} · r{{revision}}',{id:result.recordId,revision:result.recordRevision})}</p>:null}
      {result?.disposition==='needs_user'?<p>{t('本次审查已结束，建议尚未应用。请打开原记忆，核对当前版本后自行修订或停止使用。')}</p>:null}
      {result&&['rejected','discarded'].includes(result.disposition??'')?<p>{t('本次更正未应用，原记忆未因本请求改动。')}</p>:null}
    </>:<p className="hint-muted">{t(item.state==='failed'?'本次更正处理失败，尚未确认应用；请查看失败原因。':'更正请求已入队，尚未应用；以审查结果和结果版本为准。')}</p>}
    {proposal?<section aria-label={t('审查建议（尚未应用）')}>
      <h3>{t('审查建议（尚未应用）')}</h3>
      <p>{t(proposal.decision==='suspend'?'建议停止使用原记忆':'建议修订原记忆')}</p>
      <p>{t(KINDS[proposal.draft.kind])}</p>
      <p className="memory-processing-text"><strong>{t('记忆结论：')}</strong>{proposal.draft.summary}</p>
      {proposal.draft.problem?<p className="memory-processing-text"><strong>{t('问题：')}</strong>{proposal.draft.problem}</p>:null}
      {proposal.draft.action?<p className="memory-processing-text"><strong>{t('怎么做：')}</strong>{proposal.draft.action}</p>:null}
      {proposal.draft.rationale?<p className="memory-processing-text"><strong>{t('判断依据：')}</strong>{proposal.draft.rationale}</p>:null}
      <p><strong>{t('适用条件：')}</strong>{proposal.draft.applicability.join('；')||t('未声明特定条件')}</p>
      {proposal.draft.exceptions?.length?<p><strong>{t('不适用：')}</strong>{proposal.draft.exceptions.join('；')}</p>:null}
      {proposal.draft.expectedFutureUse?<p className="memory-processing-text"><strong>{t('下次有什么用：')}</strong>{proposal.draft.expectedFutureUse}</p>:null}
      {proposal.draft.searchKeys?.length?<p><strong>{t('检索词：')}</strong>{proposal.draft.searchKeys.join('；')}</p>:null}
      {proposal.draft.repoKey?<p>{t('仓库：{{repo}}',{repo:proposal.draft.repoKey})}</p>:null}
      {proposal.draft.branch?<p>{t('分支：{{branch}}',{branch:proposal.draft.branch})}</p>:null}
      {proposal.draft.taskId?<p>{t('任务：{{id}}',{id:proposal.draft.taskId})}</p>:null}
      {proposal.draft.expiresAt!==undefined?<p>{t('建议保留至：{{date}}',{date:new Date(proposal.draft.expiresAt).toLocaleString()})}</p>:null}
    </section>:null}
  </div>;
}

/** Read-only queue inspection is independent from model execution and the actual conversation. */
export function MemoryProcessingView({ workspaceId, snapshot, initialFilter = 'attention', onOpenConversation, onOpenSettings, onRefresh }: {
  workspaceId: string;
  snapshot: KnowledgeSnapshot | null;
  initialFilter?: MemoryCuratorQueueQuery['state'];
  onOpenConversation: () => void;
  onOpenSettings?: () => void;
  onRefresh: () => Promise<unknown>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [filter,setFilter] = useState<Filter>(initialFilter), [offset,setOffset] = useState(0);
  const [loadedPage,setPage] = useState<{context:string;value:MemoryCuratorQueuePage}|null>(null), [observedStatus,setStatus] = useState<MemoryCuratorSnapshot|null>(null);
  const [loading,setLoading] = useState(false), [acting,setActing] = useState(false), [error,setError] = useState('');
  const generation = useRef(0), actionGeneration = useRef(0), mounted = useRef(true), currentWorkspace = useRef(workspaceId);
  currentWorkspace.current = workspaceId;
  const context = JSON.stringify([workspaceId,filter,offset]);
  const page = loadedPage?.context === context ? loadedPage.value : null;
  const status = observedStatus?.workspaceId === workspaceId ? observedStatus : null;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; actionGeneration.current++; }; }, []);
  useEffect(() => {
    actionGeneration.current++;setFilter(initialFilter);setOffset(0);setPage(null);setStatus(null);setActing(false);setError('');
  },[workspaceId,initialFilter]);
  const acceptStatus = useCallback((incoming:MemoryCuratorSnapshot):void => {
    if(incoming?.workspaceId !== currentWorkspace.current)return;
    setStatus(previous => previous?.workspaceId === incoming.workspaceId && (previous.generation > incoming.generation || previous.generation === incoming.generation && previous.updatedAt > incoming.updatedAt) ? previous : incoming);
  },[]);
  const load = useCallback(async (): Promise<void> => {
    const token = ++generation.current; setLoading(true); setError('');
    try {
      const [entries,state] = await Promise.all([window.api.memoryCurator.inspect(workspaceId,{state:filter==='archived'?'all':filter,visibility:filter==='archived'?'archived':'visible',offset,limit:30}),window.api.memoryCurator.state(workspaceId)]);
      if (!mounted.current || token !== generation.current || currentWorkspace.current !== workspaceId) return;
      if (!entries || !Array.isArray(entries.items)) throw new Error(t('无法读取记忆整理记录'));
      const lastOffset = entries.total > 0 ? Math.floor((entries.total-1)/Math.max(1,entries.limit))*Math.max(1,entries.limit) : 0;
      if(offset > lastOffset){setOffset(lastOffset);return;}
      setPage({context,value:entries});acceptStatus(state);
    } catch (failure) { if(mounted.current && token === generation.current)setError(String((failure as Error).message)); }
    finally { if(mounted.current && token === generation.current)setLoading(false); }
  },[workspaceId,filter,offset,context,t,acceptStatus]);
  const currentLoad = useRef(load); currentLoad.current = load;
  const currentRefresh = useRef(onRefresh);currentRefresh.current = onRefresh;
  useEffect(() => {
    setPage(null); void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.api.memoryCurator.onChanged(incoming => {
      if(incoming.workspaceId !== workspaceId || currentWorkspace.current !== workspaceId)return;
      acceptStatus(incoming); clearTimeout(timer);
      timer = setTimeout(() => { if(currentWorkspace.current !== workspaceId || !mounted.current)return;void currentLoad.current(); void currentRefresh.current().catch(() => undefined); },250);
    });
    const poll = setInterval(() => void currentLoad.current(),30_000);
    return () => { generation.current++; clearTimeout(timer); clearInterval(poll); if(typeof unsubscribe === 'function')unsubscribe(); };
  },[workspaceId,load,acceptStatus]);
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    if(acting)return;
    const token=++actionGeneration.current,scope=workspaceId;
    const current=():boolean=>mounted.current && token===actionGeneration.current && currentWorkspace.current===scope;
    setActing(true);setError('');
    try { await action(); if(current())await Promise.all([currentLoad.current(),currentRefresh.current()]); }
    catch(failure) { if(current())setError(String((failure as Error).message)); }
    finally { if(current())setActing(false); }
  };
  const setArchived = async (id:string,archived:boolean):Promise<void> => {
    await run(async()=>{
      const receipt=await window.api.memoryCurator.setArchived(workspaceId,id,archived);
      if(!receipt || typeof receipt.changed !== 'boolean')throw new Error(t('归档操作未返回有效回执，请刷新后核对。'));
    });
  };
  const pending = status?.pending ?? snapshot?.processing?.pending ?? 0, failed = status?.failed ?? snapshot?.processing?.failed ?? 0;
  const paused = status?.paused ?? snapshot?.processing?.paused ?? false, running = status?.running ?? snapshot?.processing?.running ?? false;
  const clock = (at: number): string => new Date(at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  return <section className="knowledge-panel memory-processing-view" aria-label={t('记忆整理记录')}>
    <header className="knowledge-header"><div><h2>{t('记忆整理记录')}</h2><p>{t('查看收到了什么、为什么保存或未保留，以及失败原因。')}</p></div>
      <button className="ui-btn" onClick={onOpenConversation}>{t('打开记忆子系统对话')}</button></header>
    <p className="hint-muted">{t('已完成记录7天后自动归档；失败记录不会自动归档。归档只影响记录展示，不删除记忆，也不会调用模型。')}</p>
    <div className="memory-processing-summary" aria-live="polite">
      <strong>{t(paused?'记忆整理已暂停':running?'正在整理记忆':'有候选时才整理')}</strong>
      <span>{t('待处理 {{pending}} · 失败 {{failed}}',{pending,failed})}</span>
      {status?.model ? <span className="hint-muted">{t('模型：{{model}}',{model:status.model.name || status.model.modelId || status.model.providerId})}</span> : null}
    </div>
    <div className="knowledge-actions">
      <button className="ui-btn" disabled={acting || !status} onClick={() => void run(() => window.api.memoryCurator.setPaused(workspaceId,!paused))}>{t(paused?'恢复整理':'暂停整理')}</button>
      <button className="ui-btn" disabled={acting || paused || running || failed===0} onClick={() => void run(() => window.api.knowledge.process(workspaceId))}>{t('重试失败项')}</button>
      <button className="ui-btn" disabled={loading || acting} onClick={() => void load()}>{t('刷新记录')}</button>
      {onOpenSettings ? <button className="ui-btn" onClick={onOpenSettings}>{t('模型与检索设置')}</button> : null}
    </div>
    {error ? <ErrorTip message={localizeKnowledgeHostText(error)} /> : null}
    {acting ? <p role="status">{t('正在更新整理记录…')}</p> : null}
    <div className="knowledge-toolbar" role="group" aria-label={t('整理记录筛选')}>
      {FILTERS.map(item => <button key={item.id} className={`memory-chip${filter===item.id?' is-active':''}`} aria-pressed={filter===item.id} onClick={() => { setFilter(item.id);setOffset(0); }}>{t(item.label)}</button>)}
      {page ? <span className="hint-muted">{t('共 {{n}} 条',{n:page.total})}</span> : null}
    </div>
    {loading && !page ? <p role="status">{t('正在读取整理记录…')}</p> : null}
    {page?.items.length===0 ? <p className="empty-hint">{t(filter==='attention'?'没有待关注的整理事务。已处理和已归档的记录仍可从上方筛选查看。':filter==='archived'?'暂无已归档的整理记录。归档只影响记录展示。':'当前筛选下没有整理记录。新候选只在发现有用内容时提交。')}</p> : null}
    <div className="memory-processing-list">{page?.items.map(item => <article key={item.id} className="knowledge-card">
      <div className="knowledge-meta"><strong>{t(entryStatus(item))}</strong>
        <span>{t(SCOPES[item.namespace])}</span><span>{t(item.correction?'记忆更正请求':item.kind==='user'?'用户请求':'记忆候选')}</span>{item.archived?<span>{t('已归档')}</span>:null}<time dateTime={new Date(item.createdAt).toISOString()}>{clock(item.createdAt)}</time></div>
      {!item.correction?<p className="memory-processing-text">{item.text}</p>:null}
      <CorrectionDetails item={item}/>
      {item.error ? <ErrorTipDetails message={localizeKnowledgeHostText(item.error)} /> : null}
      {item.result?.reason&&(!item.correction||item.state==='done') ? <p>{t('处理说明：{{reason}}',{reason:localizeKnowledgeHostText(item.result.reason)})}</p> : null}
      <p className="hint-muted">{t('依据 {{n}} 项 · 已尝试 {{attempts}} 次',{n:item.evidenceCount,attempts:item.attempts})}
        {item.state==='deferred' ? ` · ${t('最早重试 {{time}}',{time:clock(item.availableAt)})}` : ''}</p>
      {item.correction || item.result?.recordId || item.state==='done'||item.state==='failed'?<div className="knowledge-actions">{item.correction?<button className="ui-btn" onClick={()=>requestMemoryCenterTab('entries',{entryId:item.correction!.memoryId})}>{t('打开原记忆')}</button>:item.result?.recordId ? <button className="ui-btn" onClick={() => requestMemoryCenterTab(item.result?.disposition==='retained_ephemeral'?'history':'entries',{entryId:item.result!.recordId})}>{t('查看对应记忆')}</button> : null}
        {item.state==='done'||item.state==='failed'?<button className="ui-btn" disabled={acting || loading} onClick={()=>void setArchived(item.id,!item.archived)}>{t(item.archived?'移回记录':'归档记录')}</button>:null}</div>:null}
    </article>)}</div>
    {page && page.total>page.limit ? <div className="knowledge-actions">
      <button className="ui-btn" disabled={loading || offset===0} onClick={() => setOffset(Math.max(0,offset-30))}>{t('上一页')}</button>
      <span>{t('第 {{n}} 页',{n:Math.floor(offset/30)+1})}</span>
      <button className="ui-btn" disabled={loading || offset+page.limit>=page.total} onClick={() => setOffset(offset+30)}>{t('下一页')}</button>
    </div> : null}
  </section>;
}
