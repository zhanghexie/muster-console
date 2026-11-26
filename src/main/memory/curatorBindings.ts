import { findLatestSchedulerMessage } from '../agent/schedulerHistoryRead';
import {randomUUID,createHash} from 'node:crypto';
import type {AppContext} from '../context';
import type {MemoryCuratorCandidate} from '../../shared/memoryCurator';
import type {KnowledgeNamespace,KnowledgeRecord} from '../../shared/knowledge';
import type {CuratorScope,CuratorReferences} from './curator/storageTypes';
import type {GuiChatMessage} from '../../shared/guiWorker';
import {MemoryCuratorRuntime} from './curator/runtime';
import {curatorSourceInformation} from './curator/queue';
import {getMemoryService} from './serviceRef';
import {setMemoryCandidateSink} from './curatorRef';
import {currentAgentSessionId,currentAgentWorkspaceId,isSchedulerInvocation,runOutsideAgentScope} from '../agent/agentScope';
import {currentTurnUserText,currentMemoryTurn} from '../agent/turnScope';
import {stripAnsiForDisplay as ansiStrip} from '../detect/stripAnsi';
import {controlRootFor,defaultCwdFor,sourceRootsFor,requireWorkspace} from '../workspacePaths';
import {normalizeMemoryConsolidationConfig} from '../../shared/memoryConsolidation';
import {redactCredentialShapes} from './redact';
import {looksLikeUserProfileDirective} from './provenance';
import {pathKey} from '../pathKey';
import {turnChanges} from '../turnChanges/runtime';
import {curatorDirectory} from './layout';
import {findSourceQuote} from './curator/sourceQuote';
import {validateProfileSource} from './profileProvenance';
import {t} from '../../shared/i18n';
import {localizeKnowledgeHostText} from '../../shared/knowledgeDisplayText';

const runtimes=new WeakMap<AppContext,Map<string,MemoryCuratorRuntime>>();
const all=new Set<MemoryCuratorRuntime>();
let admissionClosed=false;
const persistentDirective=(text:string)=>looksLikeUserProfileDirective(text)||/以后(?:都|要|别|请|一律)|今后|始终|每次|一律|持续要求|always|from now on|for all future/i.test(text);
const safe=(text:string)=>redactCredentialShapes(text).text;
function comparisonScopes(namespace:KnowledgeNamespace,candidate:MemoryCuratorCandidate,records:KnowledgeRecord[]):CuratorScope[]{
  const scopes=new Map<string,CuratorScope>();
  for(const record of records)scopes.set(JSON.stringify([record.repoKey,record.branch]),{namespace,repoKey:record.repoKey,branch:record.branch});
  const current={namespace,repoKey:namespace==='profile'||namespace==='host'?undefined:candidate.repoKey,branch:namespace==='profile'||namespace==='host'?undefined:candidate.branch};
  scopes.set(JSON.stringify([current.repoKey,current.branch]),current);return [...scopes.values()];
}
/** Round-robin preserves each namespace's opportunity without multiplying the context budget. */
export function boundCuratorReferences(groups:CuratorReferences[],limit=12,maxCharacters=12000):CuratorReferences {
  const seen=new Set<string>(),lists=groups.map(group=>group.records.filter(record=>{
    const key=`${record.namespace}:${record.id}`;if(seen.has(key))return false;seen.add(key);return true;
  }));
  const records:KnowledgeRecord[]=[];let used=0;
  for(let index=0;lists.some(list=>index<list.length)&&records.length<limit;index++)for(const list of lists){
    const record=list[index];if(!record||records.length>=limit)continue;
    // A comparison keeps complete conclusions/conditions and source identities. Historical
    // versions and duplicated source excerpts are not extra claims or new authorization.
    const projected={...record,history:[],evidence:record.evidence.map(({excerpt:_,...evidence})=>evidence)};
    const size=JSON.stringify(projected).length;if(used+size>maxCharacters)continue;
    records.push(projected);used+=size;
  }
  const deleted=[...new Map(groups.flatMap(group=>group.deleted).map(record=>[`${record.namespace}:${record.id}`,record])).values()];
  const omittedRecords=seen.size-records.length;
  return {records,deleted,truncated:omittedRecords>0,omittedRecords,
    notice:`对照保留完整结论、适用条件、例外和来源身份；历史版本与重复依据摘录未随附。${omittedRecords?`受统一预算限制，另有${omittedRecords}条对照未返回；请收窄query补查，不能据此判断全库没有已有知识。`:''}删除禁用完整保留。`};
}

/** Capture only the current turn. A candidate is never its own evidence. */
export function bindCandidateEvidence(ctx:AppContext,workspaceId:string,candidate:MemoryCuratorCandidate):MemoryCuratorCandidate {
  const rawUser=safe(currentTurnUserText()??candidate.userText??candidate.sourceText);
  const sessionId=currentAgentSessionId();
  const chunks:string[]=[];
  const observations:MemoryCuratorCandidate['evidence']=[];
  const addObservation=(id:string,name:string,status:string,output:string)=>{
    const excerpt=safe(output).slice(0,2000);if(!excerpt)return;
    chunks.push(`工具 ${id} ${name} 状态=${status}\n原始结果：${excerpt}`);
    observations.push({id:`${candidate.eventId}:tool:${id}`,source:name,eventTime:candidate.createdAt,sessionId,
      verification:'unverified',observation:'tool_output',contentHash:createHash('sha256').update(safe(output)).digest('hex'),excerpt});
  };
  let assistant:GuiChatMessage|undefined;
  if(sessionId){
    const entry=ctx.agentSessions?.entries.get(sessionId);
    if(entry&&entry.workspaceId!==workspaceId)throw new Error('记忆来源会话与工作区不匹配');
    if(!entry){
      const meta=ctx.sessions.get(sessionId);
      if(meta?.workspaceId!==workspaceId||currentMemoryTurn()?.sessionId!==sessionId)throw new Error('记忆来源会话与工作区不匹配');
      const tail=ctx.pty.getBufferTail(sessionId,8000);
      if(tail)chunks.push(`CLI本机终端摘录（混合用户/助手与命令输出，均未核验，不能据此伪造测试验证）：\n${safe(ansiStrip(tail)).replaceAll(candidate.text,'[记忆候选文本不作自身依据]').slice(-8000)}`);
    }
    assistant=entry?.assistant??undefined;
    for(const part of candidate.correction?[...(assistant?.parts??[])].reverse():assistant?.parts??[]){
      if(part.kind!=='tool'||part.tool.name.startsWith('memory.')||part.tool.name.startsWith('memory_')||part.tool.status==='running'
        ||/memory[._](?:note|remember|correct|correctionStatus)/i.test(JSON.stringify(part.tool.input)))continue;
      if(chunks.length>=8)break;
      addObservation(part.tool.id,part.tool.name,part.tool.status,part.tool.output??'');
    }
  }else if(isSchedulerInvocation()){
    const message=ctx.orchestrator ? findLatestSchedulerMessage(ctx.orchestrator,workspaceId,m=>m.role==='assistant') : undefined;
    for(const call of candidate.correction?[...(message?.toolCalls??[])].reverse():message?.toolCalls??[]){
      if(call.name.startsWith('memory.')||call.name.startsWith('memory_')||call.status==='running'||/memory[._](?:note|remember|correct|correctionStatus)/i.test(call.arguments))continue;
      if(chunks.length>=8)break;
      addObservation(call.id,call.name,call.status,call.result??'');
    }
  }
  const sourceText=safe([rawUser&&`用户原话：\n${rawUser}`,chunks.length&&`本轮已经完成的工具结果（状态只代表工具执行，不能扩大验证结论）：\n${chunks.join('\n\n').slice(0,16384)}`].filter(Boolean).join('\n\n'));
  if(!sourceText.trim())throw new Error('当前候选没有可定位的原始材料，未受理');
  if(sourceText.length>24000)throw new Error('原始依据超过有界预算，请缩短本轮输入后再提交候选');
  const repo=assistant?.turnChanges?.repository;
  const userRule=candidate.origin!=='untrusted'&&persistentDirective(rawUser);
  const evidence=[...candidate.evidence.map(e=>({...e,sessionId:e.sessionId??sessionId,
    turnId:assistant?.id??e.turnId,snapshotId:assistant?.turnChanges?.state==='ready'?assistant.turnChanges.id:undefined,
    repoKey:repo?.scopeStable?repo.root:e.repoKey,branch:repo?.scopeStable?repo.branch??undefined:e.branch,
    ...(rawUser?{observation:'user_input' as const,verification:userRule?'user_confirmed' as const:e.verification,contentHash:createHash('sha256').update(rawUser).digest('hex'),excerpt:rawUser.slice(0,2000)}:{})})),...observations];
  // An ordinary note may carry a plainly enduring user rule. It is still checked against raw user text at commit.
  const bound:MemoryCuratorCandidate={...candidate,userText:rawUser,sourceText,evidence,origin:userRule?'user':candidate.origin};
  return {...bound,hostInformationHash:curatorSourceInformation(bound)};
}

export function memoryCurator(ctx:AppContext,workspaceId:string):MemoryCuratorRuntime {
  if(admissionClosed)throw new Error('Memory curator service is stopping');
  if(typeof workspaceId!=='string'||!workspaceId)throw new Error('缺少工作区身份');
  const workspace=requireWorkspace(ctx.config.get(),workspaceId),root=controlRootFor(workspace);
  let map=runtimes.get(ctx);if(!map){map=new Map();runtimes.set(ctx,map);}
  const current=map.get(workspaceId);if(current)return current;
  const svc=getMemoryService();if(!svc)throw new Error('记忆服务尚未就绪');
  const assertWorkspace=()=>{
    const active=requireWorkspace(ctx.config.get(),workspaceId);
    if(pathKey(controlRootFor(active))!==pathKey(root))throw new Error('工作区身份或控制目录已改变');
  };
  const notifiedErrors=new Set<string>();
  const runtime=runOutsideAgentScope(()=>new MemoryCuratorRuntime({
    workspaceId,root,directory:curatorDirectory(root,workspaceId),
    // The conversation picker is the single model source for this workspace;
    // legacy memoryConsolidation.providerId/modelId values are no longer used.
    pi:{config:()=>ctx.config.get(),targetModel:()=>ctx.orchestrator?.schedulerModelFor(workspaceId)},
    enabled:()=>normalizeMemoryConsolidationConfig(ctx.config.get().memoryConsolidation).enabled!==false,
    mode:()=>normalizeMemoryConsolidationConfig(ctx.config.get().memoryConsolidation).admissionMode??'automatic',
    receipt(candidate){
      assertWorkspace();
      const namespaces=candidate.evidence.some(e=>e.source==='memory-curator-user')?['worker','scheduler','profile'] as const:[...new Set([candidate.namespace,'profile' as const])];
      const receipts=namespaces.flatMap(namespace=>{const receipt=svc.knowledge(root,namespace).curatorReceipt(candidate.id);return receipt?[receipt]:[];});
      if(receipts.length>1)throw new Error('同一记忆候选存在跨范围重复回执，拒绝重放');
      return receipts[0];
    },
    async references(candidate,query){
      assertWorkspace();
      // This capability belongs only to the dedicated curator. The root remains host-bound;
      // global user preferences retain their existing profile store, without opening other workspaces.
      const refs=await Promise.all((['worker','scheduler','profile','host'] as const).map(async namespace=>{
        const store=svc.knowledge(root,namespace);
        const current={namespace,repoKey:namespace==='profile'||namespace==='host'?undefined:candidate.repoKey,branch:namespace==='profile'||namespace==='host'?undefined:candidate.branch};
        const semantic=await svc.curatorReferences(root,query,current);
        assertWorkspace();
        const snapshot=store.list().records,local=comparisonScopes(namespace,candidate,snapshot).map(scope=>store.curatorReferences(query,scope));
        return {records:[...new Map([...semantic.records,...local.flatMap(r=>r.records)].map(r=>[r.id,r])).values()],
          deleted:[...new Map([...semantic.deleted,...local.flatMap(r=>r.deleted)].map(r=>[r.id,r])).values()]};
      }));
      assertWorkspace();
      // The report names a precise target; lexical ranking must not hide it behind
      // unrelated matches. Keep the current version, so stale reports fail CAS.
      const target=candidate.correction?svc.knowledge(root,candidate.namespace).list().records.find(r=>r.id===candidate.correction!.memoryId):undefined;
      const result=boundCuratorReferences(target?[{records:[target],deleted:[]},...refs]:refs);
      const issues=(['worker','scheduler','profile'] as const).flatMap(namespace=>svc.knowledge(root,namespace).integrityIssues().map(issue=>`${namespace}:${issue.id}`));
      if(issues.length)result.notice=(result.notice??'')+` 存在投影异常（${issues.join('、')}）；对照使用账本最后提交的内容，异常条目不会自动召回或被覆盖。`;
      if(target&&!result.records.some(r=>r.id===target.id))throw new Error('纠错目标超出完整对照预算，不能省略目标后审核');
      return result;
    },
    commit(candidate,decision,assertCurrent){
      assertWorkspace();assertCurrent();
      const profileDraft=!candidate.correction&&decision.draft&&['user_preference','user_profile'].includes(decision.draft.kind)
        &&['save','duplicate','suspend','supersede'].includes(decision.decision)?decision.draft:undefined;
      let boundCandidate=candidate;
      if(profileDraft){
        validateProfileSource(candidate.userText,decision.sourceQuote,profileDraft,decision.decision!=='suspend');
        if(!findSourceQuote(candidate.sourceText,decision.sourceQuote))throw new Error('用户画像依据不在宿主绑定材料中');
        const userHash=createHash('sha256').update(candidate.userText!).digest('hex');
        const observed=candidate.evidence.some(e=>e.observation==='user_input'&&e.contentHash===userHash);
        const direct=candidate.origin==='user'&&candidate.evidence.some(e=>e.source==='memory-curator-user'||e.source==='memory-center');
        if(!observed&&!direct)throw new Error('用户画像缺少宿主绑定的用户输入来源');
        boundCandidate={...candidate,origin:'user',evidence:candidate.evidence.map(e=>e.observation==='user_input'&&e.contentHash===userHash
          ?{...e,verification:candidate.explicit||direct?e.verification:'user_stated'}:e)};
      }
      if(!candidate.correction&&!profileDraft&&decision.draft&&['user_preference','stable_constraint'].includes(decision.draft.kind)){
        if(candidate.origin!=='user'||!candidate.userText?.includes(decision.sourceQuote))throw new Error('用户偏好与持续约束必须直接依据原始用户输入');
      }
      let scope=profileDraft?{namespace:'profile' as const,repoKey:undefined,branch:undefined}:{namespace:candidate.namespace,repoKey:candidate.repoKey,branch:candidate.branch};
      if(candidate.evidence.some(e=>e.source==='memory-curator-user')&&decision.targetId){
        const targets=(['worker','scheduler','profile'] as const).flatMap(ns=>svc.knowledge(root,ns).list().records).filter(r=>r.id===decision.targetId);
        if(targets.length!==1)throw new Error('当前工作区不存在唯一目标知识');
        const target=targets[0];
        scope={namespace:target.namespace,repoKey:target.repoKey,branch:target.branch};
      }
      if(['save','duplicate','suspend','supersede','restore','correct'].includes(decision.decision)){
        const currentDeleted=(['worker','scheduler','profile','host'] as const).flatMap(namespace=>{
          const store=svc.knowledge(root,namespace);
          return comparisonScopes(namespace,candidate,store.list().records).flatMap(scope=>store.deletedKnowledge(scope));
        });
        const compared=new Set(decision.reviewedDeletionIds??[]),comparisons=decision.deletionComparisons??[];
        if(currentDeleted.some(item=>!compared.has(item.id)||!comparisons.some(c=>c.id===item.id)))throw new Error('工作区删除记录已变化或尚未比较，请重新检索后提交');
        if(comparisons.some(item=>item.equivalent&&(decision.decision!=='restore'||item.id!==decision.targetId)))throw new Error('该同义知识已被用户删除，不能换范围重新保存；仅可明确恢复选中的原条目');
      }
      const store=svc.knowledge(root,scope.namespace),deletions=new Set(store.deletedKnowledge(scope).map(r=>r.id));
      return store.commitCuratorDecision({...decision,reviewedDeletionIds:decision.reviewedDeletionIds?.filter(id=>deletions.has(id)),
        deletionComparisons:decision.deletionComparisons?.filter(item=>deletions.has(item.id))},{...boundCandidate,...scope,assertCurrent});
    },
    readEvidence(candidate,evidenceId){
      assertWorkspace();const evidence=candidate.evidence.find(e=>e.id===evidenceId);
      if(!evidence)return {status:'unavailable',reason:'依据不属于当前候选'};
      // Bound excerpts remain readable after the working session is closed or compacted.
      const result={status:'available' as const,text:candidate.sourceText};
      if(!evidence.snapshotId||!evidence.turnId||!evidence.sessionId||!evidence.repoKey||!evidence.branch)return result;
      try{
        const owner=candidate.namespace==='scheduler'?`dispatch:${workspaceId}`:`gui:${evidence.sessionId}`;
        const snapshot=turnChanges().evidence(evidence.snapshotId,owner,evidence.turnId,sourceRootsFor(workspace).map(r=>r.path),evidence.repoKey,evidence.branch);
        return {status:'available',text:`${candidate.sourceText}\n轮次快照（只证明文件变化）：${JSON.stringify(snapshot)}`};
      }catch{return result;}
    },
    userCandidate(text){
      assertWorkspace();const now=Date.now(),id=`user:${randomUUID()}`,userText=safe(text);
      return {id,eventId:id,namespace:looksLikeUserProfileDirective(userText)?'profile':'worker',origin:'user',text:userText,
        sourceText:userText,userText,explicit:true,createdAt:now,repoKey:looksLikeUserProfileDirective(userText)?undefined:defaultCwdFor(workspace),
        evidence:[{id,source:'memory-curator-user',eventTime:now,verification:'user_confirmed'}]};
    },
    onChanged(snapshot){
      const win=ctx.getWindow();if(win&&!win.isDestroyed())win.webContents.send('memoryCurator:changed',snapshot);
      if(!snapshot.failed)notifiedErrors.clear();
      if(snapshot.failed&&snapshot.error&&!snapshot.running&&!notifiedErrors.has(snapshot.error)){
        notifiedErrors.add(snapshot.error);
        ctx.ui.notify(t('记忆服务需要处理'),t('后台整理已保留失败状态；请在记忆设置检查模型配置或重试。无需审核知识内容。'),
          {workspaceId,openPanel:{panel:'memory',tab:'index'}});
      }
    }
  }));
  map.set(workspaceId,runtime);all.add(runtime);return runtime;
}

/** Bind producer authority once per service; model arguments cannot choose another workspace. */
export function bindMemoryCurator(ctx:AppContext):void {
  const svc=getMemoryService();if(!svc)return;
  setMemoryCandidateSink(svc,(root,candidate)=>{
    const sessionId=currentAgentSessionId();
    const workspaceId=sessionId?ctx.sessions.get(sessionId)?.workspaceId:currentAgentWorkspaceId();
    if(!workspaceId)throw new Error('候选缺少宿主绑定的工作区身份');
    const workspace=requireWorkspace(ctx.config.get(),workspaceId);
    if(pathKey(controlRootFor(workspace))!==pathKey(root))throw new Error('记忆候选越过当前工作区');
    if(candidate.origin==='untrusted'||candidate.origin==='system')return {queued:false,candidateId:candidate.id,reason:'不可信或自动来源不能创建长期记忆候选'};
    const bound=bindCandidateEvidence(ctx,workspaceId,candidate);
    return runOutsideAgentScope(()=>memoryCurator(ctx,workspaceId).enqueue(bound));
  });
}

/** Boot resumes only durable explicit candidates, never scans transcripts or journals. */
export function restoreMemoryCurators(ctx:AppContext):void {
  if(admissionClosed)throw new Error('Memory curator service is stopping');
  bindMemoryCurator(ctx);
  for(const workspace of ctx.config.get().workspaces){
    if(workspace.rootsError)continue;
    try{
      const runtime=memoryCurator(ctx,workspace.id);
      runtime.requestDrain();
    }catch(error){
      console.error('[memory-curator] 队列恢复失败',workspace.id,error);
      const message=error instanceof Error?error.message:String(error),translated=localizeKnowledgeHostText(message);
      ctx.notify?.push({workspaceId:workspace.id,sessionId:'memory',sessionName:t('工作台'),text:t('记忆初始化失败，数据未清理：{{error}}',{error:translated===message?String(error):translated}),toast:true});
    }
  }
}
export async function closeMemoryCurator(ctx:AppContext,workspaceId:string):Promise<void>{
  const runtime=runtimes.get(ctx)?.get(workspaceId);if(!runtime)return;
  await runtime.stop();runtimes.get(ctx)?.delete(workspaceId);all.delete(runtime);
}
export async function stopMemoryCuratorsAndWait():Promise<void>{
  stopMemoryCuratorAdmission();
  const results=await Promise.allSettled([...all].map(async runtime=>{await runtime.stop();all.delete(runtime);}));
  const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);
  if(errors.length)throw new AggregateError(errors,'Memory curator shutdown failed');
}
export function stopMemoryCuratorAdmission():void{admissionClosed=true;for(const runtime of all)runtime.stopAdmission();}
export function stopMemoryCurators():void{void stopMemoryCuratorsAndWait().catch(error=>console.error('[memory-curator] stop failed',error));}
/** A settings write can resume existing candidates, but cannot create any. */
export async function refreshMemoryCurators(ctx:AppContext):Promise<void>{
  for(const runtime of runtimes.get(ctx)?.values()??[]){
    await runtime.refreshPolicy();
  }
}
