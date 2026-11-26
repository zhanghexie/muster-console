import type {AppContext} from '../context';
import {handle as registerIpc, type IpcHandler} from '../ipc/handle';
import {resolveWorkspaceControlRoot} from '../ipc/helpers';
import type {KnowledgeDraft,KnowledgeListQuery,KnowledgeNamespace,KnowledgeQuery,KnowledgeSnapshot} from '../../shared/knowledge';
import {PROFILE_INJECTION_BUDGET} from '../../shared/knowledge';
import {getMemoryService} from './serviceRef';
import {sourceRootsFor,defaultCwdFor} from '../../shared/workspaceRoots';
import {turnChanges} from '../turnChanges/runtime';
import {readGitIdentity} from '../git/identity';
import {randomUUID} from 'node:crypto';
import {normalizeMemoryConsolidationConfig} from '../../shared/memoryConsolidation';
import {memoryCurator} from './curatorBindings';
import {knowledgeHistorySources,readKnowledgeHistory} from './knowledgeHistory';
import {knowledgeActivity} from './knowledgeActivity';
import type {KnowledgeMaintenanceInput,KnowledgeMaintenanceResult} from '../../shared/knowledge';
import {t} from '../../shared/i18n';
import {checkMemoryEnvironment} from './environment';
import {localizeKnowledgeUserError} from './knowledgeUserErrors';

/** Localize only known host errors returned to the user, retaining sync/async behavior. */
function handle<T extends IpcHandler>(channel:string,fn:T):void {
  registerIpc(channel,(event,...args)=>{
    try {
      const result=fn(event,...args);
      return result instanceof Promise?result.catch(localizeKnowledgeUserError):result;
    } catch(error) { return localizeKnowledgeUserError(error); }
  });
}

/** UI governance always supplies the workspace captured when its view was opened. */
export function registerKnowledgeIpc(ctx:AppContext):void {
  const project=(record:import('../../shared/knowledge').KnowledgeRecord)=>({...record,environmentCheck:checkMemoryEnvironment(record)});
  const service=()=>{const svc=getMemoryService();if(!svc) throw new Error(t('记忆服务尚未就绪'));return svc;};
  const root=(workspaceId:unknown)=>{
    if(typeof workspaceId!=='string'||!workspaceId) throw new Error(t('缺少工作区身份'));
    return resolveWorkspaceControlRoot(ctx,workspaceId);
  };
  const stores=(workspaceId:unknown)=>{
    const directory=root(workspaceId),svc=service();
    return (['worker','scheduler','profile','host'] as KnowledgeNamespace[]).map(namespace=>svc.knowledge(directory,namespace));
  };
  const decodeCursor=(value:unknown):{updatedAt:number;id:string}|undefined=>{
    if(value===undefined)return undefined;
    if(typeof value!=='string'||value.length>512)throw new Error(t('知识分页游标无效'));
    try {
      const parsed=JSON.parse(Buffer.from(value,'base64url').toString('utf8')) as {updatedAt?:unknown;id?:unknown};
      if(!Number.isSafeInteger(parsed.updatedAt)||typeof parsed.id!=='string'||!parsed.id)throw new Error(t('知识分页游标无效'));
      return {updatedAt:parsed.updatedAt as number,id:parsed.id};
    } catch { throw new Error(t('知识分页游标无效')); }
  };
  const encodeCursor=(record:{updatedAt:number;id:string}):string=>Buffer.from(JSON.stringify({updatedAt:record.updatedAt,id:record.id}),'utf8').toString('base64url');
  const listQuery=(raw:unknown):KnowledgeListQuery|undefined=>{
    if(raw===undefined)return undefined;
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error(t('知识列表参数无效'));
    const input=raw as Record<string,unknown>;
    const query:KnowledgeListQuery={};
    if(input.cursor!==undefined){if(typeof input.cursor!=='string')throw new Error(t('知识分页游标无效'));query.cursor=input.cursor;}
    if(input.limit!==undefined){if(!Number.isSafeInteger(input.limit)||Number(input.limit)<1||Number(input.limit)>500)throw new Error(t('知识列表条数必须在 1 到 500 之间'));query.limit=Number(input.limit);}
    if(input.namespace!==undefined){if(typeof input.namespace!=='string'||!['worker','scheduler','profile','host'].includes(input.namespace))throw new Error(t('知识列表范围无效'));query.namespace=input.namespace as KnowledgeNamespace;}
    for(const key of ['updatedAfter','updatedBefore'] as const)if(input[key]!==undefined){if(!Number.isSafeInteger(input[key]))throw new Error(t('知识更新时间无效'));query[key]=Number(input[key]);}
    if(query.updatedAfter!==undefined&&query.updatedBefore!==undefined&&query.updatedAfter>query.updatedBefore)throw new Error(t('知识更新时间范围无效'));
    if(input.maxBytes!==undefined){if(!Number.isSafeInteger(input.maxBytes)||Number(input.maxBytes)<16_384||Number(input.maxBytes)>2_000_000)throw new Error(t('知识列表响应大小必须在 16 KiB 到 2 MiB 之间'));query.maxBytes=Number(input.maxBytes);}
    decodeCursor(query.cursor);
    return query;
  };
  const locate=(workspaceId:unknown,id:unknown)=>{
    if(typeof id!=='string') throw new Error(t('无效记忆身份'));
    const store=stores(workspaceId).find(s=>s.list().records.some(r=>r.id===id));
    if(!store) throw new Error(t('该工作区不存在此记忆'));return store;
  };
  handle('knowledge:maintenance',async(_event,workspaceId:string,input:KnowledgeMaintenanceInput):Promise<KnowledgeMaintenanceResult>=>{
    const directory=root(workspaceId),runtime=memoryCurator(ctx,workspaceId);
    if(!input||!['prune_history','stop_policy','continue_policy'].includes(input.action))throw new Error(t('未知记忆维护操作'));
    if(input.action==='prune_history'){
      const results=runtime.withMaintenance(queue=>service().pruneKnowledgeHistory(directory,{guardDatabases:[queue],maxDurationMs:25}));
      return {action:input.action,processed:results.reduce((n,result)=>n+result.records.length+result.events.length,0),remaining:null,incomplete:0,blocked:results.flatMap(result=>result.blocked?[result.blocked]:[])};
    }
    if(!['worker','scheduler','profile'].includes(input.namespace)||typeof input.policyVersion!=='string'||!input.policyVersion.trim()||input.policyVersion.length>120)throw new Error(t('非法记忆维护范围或策略版本'));
    if(input.action==='stop_policy'&&(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>1000))throw new Error(t('停用记忆策略需要有界原因'));
    await runtime.setPaused(true);
    const result=input.action==='stop_policy'?service().stopKnowledgePolicy(directory,input.namespace,input.policyVersion,input.reason!)
      :service().continueKnowledgePolicyCompensation(directory,input.namespace,input.policyVersion);
    return {action:input.action,processed:result.processed,remaining:result.remaining,incomplete:result.incomplete};
  });
  handle('knowledge:historySources',(_event,workspaceId:string)=>{root(workspaceId);return knowledgeHistorySources(ctx,workspaceId);});
  handle('knowledge:history',(_event,workspaceId:string,input:{sessionId:string;query:string})=>{root(workspaceId);return readKnowledgeHistory(ctx,workspaceId,input);});
  handle('knowledge:list',(_event,workspaceId:unknown,rawQuery?:unknown):KnowledgeSnapshot=>{
    const query=listQuery(rawQuery),currentStores=stores(workspaceId),snapshots=query?currentStores.map(s=>typeof (s as any).summary==='function'?(s as any).summary():s.list()):currentStores.map(s=>s.list());
    const state=memoryCurator(ctx,String(workspaceId)).snapshot();
    const deletedIds=currentStores.flatMap(store=>store.deletedKnowledgeIds());
    const processing={pending:state.pending,failed:state.failed,errors:state.error?[state.error]:[],running:state.running,paused:state.paused};
    const bounded=!!query;
    const base={deletedIds:[...new Set(deletedIds)],integrityIssues:snapshots.flatMap(s=>s.integrityIssues??[]),policySuppressedIds:snapshots.flatMap(s=>s.policySuppressedIds??[]),profileInjectionChars:service().knowledge(root(workspaceId),'profile').core('profile',PROFILE_INJECTION_BUDGET).length,activity:knowledgeActivity(currentStores),governance:snapshots.flatMap(s=>s.governance??[]).sort((a,b)=>b.at-a.at),pending:snapshots.reduce((n,s)=>n+s.pending,0),active:snapshots.reduce((n,s)=>n+s.active,0),history:snapshots.reduce((n,s)=>n+s.history,0),startedAt:Math.min(...snapshots.map(s=>s.startedAt)),processing};
    if(!bounded)return {...base,records:snapshots.flatMap(s=>s.records).map(project)};
    const cursor=decodeCursor(query.cursor);
    const limit=query.limit??100;
    const maxBytes=query?.maxBytes??262_144;
    const candidates=currentStores.flatMap(store=>{
      const page=(store as any).listPage;
      if(typeof page==='function')return [page.call(store,{after:cursor,limit:limit+1,namespace:query.namespace,updatedAfter:query.updatedAfter,updatedBefore:query.updatedBefore})] as Array<{records:KnowledgeSnapshot['records'];totalCount:number}>;
      // Compatibility for test doubles and older in-process adapters; the
      // production KnowledgeStore always takes the SQLite path above.
      const records=store.list().records.filter(record=>!query.namespace||record.namespace===query.namespace)
        .filter(record=>query.updatedAfter===undefined||record.updatedAt>query.updatedAfter)
        .filter(record=>query.updatedBefore===undefined||record.updatedAt<=query.updatedBefore)
        .filter(record=>!cursor||record.updatedAt<cursor.updatedAt||(record.updatedAt===cursor.updatedAt&&record.id<cursor.id))
        .sort((a,b)=>b.updatedAt-a.updatedAt||(a.id<b.id?-1:a.id>b.id?1:0));
      return [{records:records.slice(0,limit+1),totalCount:records.length}];
    });
    const allRecords=candidates.flatMap(page=>page.records).sort((a,b)=>b.updatedAt-a.updatedAt||(a.id<b.id?-1:a.id>b.id?1:0));
    const totalCount=candidates.reduce((count,page)=>count+page.totalCount,0);
    const pageRecords=allRecords.slice(0,limit),hasMore=allRecords.length>limit;
    const records=[] as KnowledgeSnapshot['records'];let truncated=false;
    for(const record of pageRecords){
      const next=project(record),candidate={...base,records:[...records,next],totalCount,...(hasMore?{nextCursor:encodeCursor(record)}:{}),truncated:hasMore};
      if(Buffer.byteLength(JSON.stringify(candidate),'utf8')>maxBytes){truncated=true;break;}
      records.push(next);
    }
    const nextCursor=records.length&&((truncated&&records.length<pageRecords.length)||hasMore)?encodeCursor(records[records.length-1]):undefined;
    return {...base,records,totalCount,...(nextCursor?{nextCursor}:{}),truncated:truncated||hasMore};
  });
  handle('knowledge:govern',()=>{throw new Error(t('请在记忆会话提出更正，系统会核对依据后处理'));});
  handle('knowledge:undoGovernance',()=>{throw new Error(t('请在记忆会话明确提出恢复请求，系统会核对版本后处理'));});
  handle('knowledge:process',async(_event,workspaceId:unknown)=>{
    if(normalizeMemoryConsolidationConfig(ctx.config.get().memoryConsolidation).enabled===false)throw new Error(t('后台记忆处理已关闭，请先在记忆设置中启用。'));
    root(workspaceId);const runtime=memoryCurator(ctx,String(workspaceId));
    runtime.retryFailed();runtime.requestDrain();
  });
  handle('knowledge:create',(_event,workspaceId:unknown,input:{namespace:KnowledgeNamespace;draft:KnowledgeDraft})=>{
    if(!input||!['worker','scheduler','profile'].includes(input.namespace))throw new Error(t('无效记忆范围'));
    const directory=root(workspaceId),now=Date.now(),id=randomUUID();
    const sourceText=`用户在记忆中心提交的内容：${JSON.stringify(input.draft)}`;
    const receipt=memoryCurator(ctx,String(workspaceId)).enqueue({id,eventId:id,namespace:input.namespace,origin:'user',explicit:true,
      text:JSON.stringify(input.draft),sourceText,userText:sourceText,createdAt:now,
      repoKey:input.namespace==='profile'?undefined:directory,
      evidence:[{id,source:'memory-center',eventTime:now,verification:'user_confirmed'}]});
    return {disposition:receipt.queued?'proposed':'rejected',reason:receipt.reason};
  });
  handle('knowledge:search',async(_event,workspaceId:unknown,input:KnowledgeQuery)=>{
    if(!input||typeof input.query!=='string') throw new Error(t('缺少查询内容'));
    const directory=root(workspaceId),workspace=ctx.config.get().workspaces.find(w=>w.id===workspaceId)!;
    const source=defaultCwdFor(workspace),repo=await readGitIdentity(source);
    return (await service().queryKnowledge(directory,{...input,repoKey:repo?.root??source,branch:repo?.branch??undefined})).map(hit=>({...hit,record:project(hit.record)}));
  });
  handle('knowledge:decide',(_event,workspaceId:unknown,input:{id:string;revision:number;decision:'approve'|'reject'|'archive'|'revalidate'})=>{
    if(!input||!Number.isInteger(input.revision))throw new Error(t('无效记忆版本'));
    if(input.decision==='archive'||input.decision==='reject')return project(locate(workspaceId,input.id).deleteKnowledge(input.id,input.revision));
    if(input.decision==='revalidate')return project(locate(workspaceId,input.id).stopUsing(input.id,input.revision));
    throw new Error(t('知识由记忆会话自动判断，无需人工审批；可在记忆视图提出更正'));
  });
  handle('knowledge:revise',(_event,workspaceId:unknown,input:{id:string;revision:number;draft:KnowledgeDraft})=>{
    if(!input||!Number.isInteger(input.revision)) throw new Error(t('无效修订版本'));
    return project(locate(workspaceId,input.id).revise(input.id,input.revision,input.draft));
  });
  handle('knowledge:confirm',(_event,workspaceId:unknown,input:{id:string;revision:number})=>{
    if(!input||!Number.isInteger(input.revision))throw new Error(t('无效记忆版本'));
    return project(locate(workspaceId,input.id).confirm(input.id,input.revision,'用户在记忆中心确认当前版本'));
  });
  handle('knowledge:promoteHost',(_event,workspaceId:unknown,input:{id:string;revision:number;draft:KnowledgeDraft})=>{
    if(!input||!Number.isInteger(input.revision))throw new Error(t('无效记忆版本'));
    const source=locate(workspaceId,input.id),record=source.list().records.find(item=>item.id===input.id);
    if(!record||record.revision!==input.revision||record.status!=='active'||record.kind!=='reusable_lesson'||record.namespace==='host'||source.deletedKnowledgeIds().includes(record.id)||!source.policyAllows(record))throw new Error(t('原记忆不可用或版本已变化'));
    if(!input.draft||input.draft.kind!=='reusable_lesson'||input.draft.repoKey||input.draft.branch)throw new Error(t('通用经验必须移除仓库和分支范围'));
    // Hidden search keys from the source were not presented for user review.
    const reviewedDraft={...input.draft,searchKeys:[],environment:record.environment};
    const id=randomUUID(),result=service().knowledge(root(workspaceId),'host').submit(reviewedDraft,{namespace:'host',origin:'user',explicit:true,
      evidence:[{id,source:'user-host-promotion',eventTime:Date.now(),verification:'user_confirmed',observation:'user_input',excerpt:input.draft.summary}]});
    if(!result.record||result.disposition!=='active')throw new Error(result.reason);
    return project(result.record);
  });
  handle('knowledge:supersede',(_event,_workspaceId:unknown,input:{id:string;revision:number;targetId:string;targetRevision:number})=>{
    if(!input||!Number.isInteger(input.revision)||!Number.isInteger(input.targetRevision)) throw new Error(t('无效取代版本'));
    throw new Error(t('请在记忆会话提出更正，由系统核对依据与版本后自动取代'));
  });
  handle('knowledge:restore',(_event,workspaceId:unknown,input:{id:string;revision:number;fromRevision:number})=>{
    if(!input||!Number.isInteger(input.revision)||!Number.isInteger(input.fromRevision)) throw new Error(t('无效恢复版本'));
    return project(locate(workspaceId,input.id).restore(input.id,input.revision,input.fromRevision));
  });
  handle('knowledge:evidence',(_event,workspaceId:unknown,input:{id:string;evidenceId:string;file?:string})=>{
    const store=locate(workspaceId,input?.id),record=store.list().records.find(r=>r.id===input.id)!;
    const evidence=record.evidence.find(e=>e.id===input.evidenceId);
    if(!evidence?.snapshotId||!evidence.sessionId||!evidence.turnId||!evidence.repoKey||!evidence.branch) return {status:'unavailable',reason:t('没有完整的轮次快照或仓库/分支依据，不能还原代码证据')};
    const workspace=ctx.config.get().workspaces.find(w=>w.id===workspaceId);
    if(!workspace) throw new Error(t('工作区不存在'));
    const owner=evidence.source==='scheduler-session'?`dispatch:${String(workspaceId)}`:`gui:${evidence.sessionId}`;
    try {return turnChanges().evidence(evidence.snapshotId,owner,evidence.turnId,sourceRootsFor(workspace).map(r=>r.path),evidence.repoKey,evidence.branch,input.file);}
    catch(error){return {status:'unavailable',reason:String((error as Error).message??error)};}
  });
}
