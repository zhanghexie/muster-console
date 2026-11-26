import type {AppContext} from '../../context';
import {controlRootFor,requireWorkspace} from '../../workspacePaths';
import {getMemoryService} from '../../memory/serviceRef';
import {correctKnowledge,noteKnowledge,rememberKnowledge} from '../../memory/knowledgeTools';
import {isSchedulerInvocation,currentAgentWorkspaceId,currentAgentSessionId} from '../../agent/agentScope';
import {defaultCwdFor} from '../../../shared/workspaceRoots';
import {knowledgeVisible} from '../../memory/knowledgeSearch';
import {knowledgeBranchNotice} from '../../memory/knowledgeRecall';
import {knowledgeRepoKey} from '../../memory/knowledgePolicy';
import {readGitIdentity} from '../../git/identity';
import {bindMemoryCurator,memoryCurator} from '../../memory/curatorBindings';
import type {MemoryCorrectionInput} from '../../../shared/memoryCurator';
import {writeJournal,searchJournal,readJournalDay,type JournalInput} from '../../memory/journal';
import {boundedPage,boundedTextPage,boundedRawTextPage,compactKnowledge,pageInteger} from '../../memory/readProjection';
import type {KnowledgeNamespace,KnowledgeRecord} from '../../../shared/knowledge';
import {currentMemoryTurn,currentTurnUserText,isCurrentTurnNetworkTainted,isHeadlessTurn} from '../../agent/turnScope';

function context(ctx:AppContext,args:{workspaceId?:string;__actorSessionId?:string}){
  bindMemoryCurator(ctx);
  const svc=getMemoryService();if(!svc)throw new Error('记忆服务尚未就绪');
  // GUI/PTY executor binds the session scope; workspace ALS is scheduler-owned
  // and may be absent (or inherited from a different workspace).
  const actorId=currentAgentSessionId()??(isSchedulerInvocation()?undefined:args.__actorSessionId);
  const actor=actorId?ctx.sessions.get(actorId):undefined;
  if(actorId&&!actor?.workspaceId)throw new Error('记忆调用的宿主会话或所属工作区已不可用');
  const workspaceId=actorId?actor!.workspaceId:currentAgentWorkspaceId();
  if(!workspaceId)throw new Error('记忆调用缺少宿主绑定的工作区身份');
  const workspace=requireWorkspace(ctx.config.get(),workspaceId);
  return {svc,workspace,root:controlRootFor(workspace),sourceRoot:actor?.cwd||defaultCwdFor(workspace),namespace:isSchedulerInvocation()?'scheduler' as const:'worker' as const};
}
export const memoryHost={
  'memory.correct':async(ctx:AppContext,args:MemoryCorrectionInput)=>{
    const {svc,root,sourceRoot,namespace,workspace}=context(ctx,{});
    const requester=isSchedulerInvocation()?`scheduler:${workspace.id}`:currentAgentSessionId();
    if(!requester)throw new Error('纠错仅接受宿主绑定的会话身份');
    if(typeof args.memoryId!=='string'||!args.memoryId.trim()||args.memoryId.length>200||!Number.isSafeInteger(args.revision)||args.revision<1)throw new Error('纠错需要精确memoryId和revision');
    const repository=await readGitIdentity(sourceRoot);
    const targets=([namespace,'profile'] as const).flatMap(ns=>{
      const store=svc.knowledge(root,ns);
      return store.list().records.filter(record=>record.id===args.memoryId&&record.namespace===ns&&record.kind!=='task_fact'
        &&['active','needs_revalidation'].includes(record.status)
        &&(!record.repoKey||record.repoKey===knowledgeRepoKey(repository?.root??sourceRoot))
        &&(!record.branch||record.branch===repository?.branch));
    });
    if(targets.length!==1)throw new Error('当前会话范围不存在可纠正的目标知识');
    const target=targets[0];
    if(target.revision!==args.revision)throw new Error('目标知识版本已变化，请重新检索');
    return correctKnowledge(svc,root,args,target,requester);
  },
  'memory.correctionStatus':async(ctx:AppContext,args:{requestId:string})=>{
    const {workspace}=context(ctx,{});
    const requester=isSchedulerInvocation()?`scheduler:${workspace.id}`:currentAgentSessionId();
    if(!requester)throw new Error('纠错状态查询仅接受宿主绑定的会话身份');
    if(typeof args.requestId!=='string'||!args.requestId.trim()||args.requestId.length>300)throw new Error('requestId 不能为空且不能超过300字符');
    return memoryCurator(ctx,workspace.id).correctionStatus(args.requestId,requester);
  },
  'memory.journal':async(ctx:AppContext,args:JournalInput)=>{
    const {root,workspace}=context(ctx,{});
    const actor=currentAgentSessionId()??(isSchedulerInvocation()?`scheduler:${workspace.id}`:undefined);
    if(!actor)throw new Error('工作记录仅接受Muster宿主会话调用');
    return writeJournal(root,actor,args);
  },
  'memory.search':async(ctx:AppContext,args:{query?:string;mode?:'task'|'history'|'journal';date?:string;fromDate?:string;toDate?:string;cursor?:string;topicId?:string;limit?:number;offset?:number;workspaceId?:string})=>{
    const {svc,root,sourceRoot,namespace}=context(ctx,args),query=args.query?.trim()??'';if(!query&&!(args.mode==='journal'&&args.topicId))throw new Error('query 或日志 topicId 不能为空');
    const offset=pageInteger(args.offset,0,60),limit=Math.max(1,pageInteger(args.limit,5,10));
    if(args.mode==='journal')return searchJournal(root,query,limit,args.date,{fromDate:args.fromDate,toDate:args.toDate,cursor:args.cursor,topicId:args.topicId});
    const repository=await readGitIdentity(sourceRoot);
    const local=await svc.queryKnowledge(root,{query,namespace,mode:args.mode==='history'?'history':'task',repoKey:repository?.root??sourceRoot,branch:repository?.branch??undefined,limit:20});
    const profile=args.mode==='history'?[]:await svc.queryKnowledge(root,{query,namespace:'profile',mode:'task',limit:20});
    const host=args.mode==='history'?[]:await svc.queryKnowledge(root,{query,namespace:'host',mode:'task',limit:20});
    // Fair interleave keeps both the host-selected project scope and global preferences visible.
    const sources=[local.slice(0,20),profile.slice(0,20),host.slice(0,20)];
    const hits=Array.from({length:Math.max(...sources.map(items=>items.length))},(_,i)=>sources.map(items=>items[i])).flat().filter((hit):hit is NonNullable<typeof hit>=>!!hit);
    const integrityIssues=([namespace,...(args.mode==='history'?[]:['profile' as const,'host' as const])] as const).flatMap(ns=>svc.knowledge(root,ns).integrityIssues().map(issue=>({...issue,namespace:ns})));
    const projected=hits.map(h=>compactKnowledge(h.record,knowledgeBranchNotice(h.record,repository?.branch),h.reason));
    const journalResult=args.mode==='history'?searchJournal(root,query,1,args.date):undefined;
    const journal=journalResult?{...journalResult,hits:journalResult.hits.map(({day,topic,topicId,status})=>({day,topic,topicId,status,entryTruncated:true}))}:undefined;
    const page=boundedPage(projected,offset,limit,{scope:[namespace,...(args.mode==='history'?[]:['profile','host'])],
      queryLimitReached:local.length>=20||profile.length>=20||host.length>=20,
      ...(journal?{journal}:{}),
      ...(integrityIssues.length?{integrityIssues:integrityIssues.slice(0,5),integrityIssuesOmitted:Math.max(0,integrityIssues.length-5)}:{})});
    return {hits:page.entries,nextOffset:page.nextOffset,truncated:page.truncated,scope:page.scope,queryLimitReached:page.queryLimitReached,
      ...(page.integrityIssues?{integrityIssues:page.integrityIssues,integrityIssuesOmitted:page.integrityIssuesOmitted}:{}),
      ...(page.journal?{journal:page.journal}:{})};
  },
  'memory.list':async(ctx:AppContext,args:{limit?:number;offset?:number;workspaceId?:string})=>{
    const {svc,root,sourceRoot,namespace}=context(ctx,args),repository=await readGitIdentity(sourceRoot);
    const scopes:KnowledgeNamespace[]=[namespace,'profile','host'];
    const records:KnowledgeRecord[]=[],issues:Array<{id:string;reason:'missing'|'modified';namespace:KnowledgeNamespace}>=[];
    for(const ns of scopes){const store=svc.knowledge(root,ns);
      records.push(...store.list().records.filter(r=>store.policyAllows(r)&&knowledgeVisible(r,{query:'',namespace:ns,repoKey:repository?.root??sourceRoot,branch:repository?.branch??undefined})));
      issues.push(...store.integrityIssues().map(issue=>({...issue,namespace:ns})));}
    const limit=Math.max(1,pageInteger(args.limit,40,50)),offset=pageInteger(args.offset,0,100000);
    const entries=records.sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id)).map(r=>compactKnowledge(r,knowledgeBranchNotice(r,repository?.branch)));
    return boundedPage(entries,offset,limit,{total:records.length,scope:scopes,totals:Object.fromEntries(scopes.map(ns=>[ns,records.filter(r=>r.namespace===ns).length])),
      ...(issues.length?{integrityIssues:issues.slice(0,5),integrityIssuesOmitted:Math.max(0,issues.length-5)}:{})});
  },
  'memory.get':async(ctx:AppContext,args:{id?:string;namespace?:KnowledgeNamespace;revision?:number;section?:'details'|'evidence';offset?:number;maxChars?:number})=>{
    const {svc,root,sourceRoot,namespace}=context(ctx,{});
    if(typeof args.id!=='string'||!args.id.trim()||args.id.length>200)throw new Error('id 不能为空且不能超过200字符');
    const scopes:KnowledgeNamespace[]=[namespace,'profile','host'];
    if(args.namespace&&!scopes.includes(args.namespace))throw new Error('该记忆范围对当前会话不可见');
    const repository=await readGitIdentity(sourceRoot),found:KnowledgeRecord[]=[];
    for(const ns of args.namespace?[args.namespace]:scopes){const store=svc.knowledge(root,ns);
      found.push(...store.list().records.filter(r=>r.id===args.id&&store.policyAllows(r)&&knowledgeVisible(r,{query:'',namespace:ns,mode:'history',repoKey:repository?.root??sourceRoot,branch:repository?.branch??undefined})));}
    if(found.length!==1)throw new Error('当前会话范围不存在可读取的记忆，请检查 ID 和范围');
    const record=found[0]!;
    if(args.revision!==undefined&&args.revision!==record.revision)throw new Error('记忆版本已变化，请重新查询');
    const section=args.section??'details';if(section!=='details'&&section!=='evidence')throw new Error('未知详情类型');
    const offset=pageInteger(args.offset,0,1000000),maxChars=Math.max(1,pageInteger(args.maxChars,4000,5000));
    if(offset>0&&args.revision===undefined)throw new Error('继续读取详情时必须指定首次返回的 revision');
    return boundedTextPage(record,section,offset,maxChars);
  },
  'memory.journalGet':async(ctx:AppContext,args:{date?:string;offset?:number;maxChars?:number})=>{
    const {root}=context(ctx,{});if(typeof args.date!=='string')throw new Error('需要日志日期');
    const offset=pageInteger(args.offset,0,3000000),maxChars=Math.max(1,pageInteger(args.maxChars,4000,5000));
    return boundedRawTextPage(readJournalDay(root,args.date).content,{date:args.date},offset,maxChars);
  },
  'memory.confirm':async(ctx:AppContext,args:{id?:string;revision?:number})=>{
    const {svc,root,sourceRoot,namespace}=context(ctx,{});
    const turn=currentMemoryTurn(),raw=currentTurnUserText()?.trim();
    if(!turn||!raw||isHeadlessTurn()||isCurrentTurnNetworkTainted()!==false)throw new Error('确认需要可信的本轮用户原话');
    const actor=currentAgentSessionId();if(turn.sessionId&&actor!==turn.sessionId)throw new Error('确认来源会话不匹配');
    if(typeof args.id!=='string'||!args.id.trim()||!Number.isSafeInteger(args.revision)||Number(args.revision)<1)throw new Error('确认需要精确 ID 和 revision');
    // Require the user's own words to name the exact target; model-supplied arguments are not consent.
    const escaped=args.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    if(!new RegExp(`^(?:(?:我)?确认|同意|认可)\\s*(?:记忆|这条记忆)?\\s*${escaped}\\s*(?:正确|无误|可用)?[。.!！]?$|^confirm\\s+(?:memory\\s+)?${escaped}[.!]?$`,'i').test(raw))
      throw new Error('请由用户明确确认具体记忆 ID；模型参数不能代替用户确认');
    const repository=await readGitIdentity(sourceRoot),found:Array<{store:ReturnType<typeof svc.knowledge>;record:KnowledgeRecord}>=[];
    for(const ns of [namespace,'profile','host'] as KnowledgeNamespace[]){const store=svc.knowledge(root,ns);
      for(const record of store.list().records)if(record.id===args.id&&store.policyAllows(record)&&knowledgeVisible(record,{query:'',namespace:ns,repoKey:repository?.root??sourceRoot}))found.push({store,record});}
    if(found.length!==1)throw new Error('当前会话范围不存在可确认的记忆');
    return compactKnowledge(found[0]!.store.confirm(args.id,Number(args.revision),raw));
  },
  'memory.note':async(ctx:AppContext,args:{text?:string;searchKeys?:unknown;environmentKeys?:unknown;workspaceId?:string})=>{
    const {svc,root,sourceRoot}=context(ctx,args);if(!args.text?.trim()||args.text.length>4000)throw new Error('候选需为1到4000字符');
    const repo=await readGitIdentity(sourceRoot);
    return noteKnowledge(svc,root,args.text,{repoKey:repo?.root??sourceRoot,branch:repo?.branch??undefined},args.searchKeys,args.environmentKeys);
  },
  'memory.remember':async(ctx:AppContext,args:{text?:string;searchKeys?:unknown;workspaceId?:string})=>{
    const {svc,root,sourceRoot}=context(ctx,args);if(!args.text?.trim())throw new Error('text 不能为空');
    const repo=await readGitIdentity(sourceRoot);
    return rememberKnowledge(svc,root,args.text,undefined,{repoKey:repo?.root??sourceRoot,branch:repo?.branch??undefined},args.searchKeys);
  }
};
