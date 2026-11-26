import {runKnowledgeStage,KNOWLEDGE_STAGE_POLICY,type KnowledgeStagePolicy,type KnowledgeStageTiming} from './knowledgeStage';
import { createHash, randomUUID } from 'node:crypto';
import type { KnowledgeDraft, KnowledgeEvidence, KnowledgeNamespace, KnowledgeRecord, KnowledgeWriteResult } from '../../shared/knowledge';
import { KnowledgeStore } from './knowledgeStore';
import { KNOWLEDGE_EXTRACT_PROMPT, parseKnowledgeExtraction } from './knowledgePolicy';
import { redactCredentialShapes } from './redact';
import { reviewKnowledgeDrafts } from './knowledgeReview';
import { assessKnowledge } from './knowledgePolicy';

/** Host event identity is stable across release, compaction and retry. */
export interface KnowledgeSourceEvent {
  id: string;
  text: string;
  namespace: KnowledgeNamespace;
  origin: KnowledgeRecord['origin'];
  evidence: KnowledgeEvidence;
  repoKey?: string;
  branch?: string;
  taskId?: string;
}
export type KnowledgeModelCall = (input: {system: string; user: string; signal?:AbortSignal}) => Promise<string>;
interface EventRow {id:string;payload:string;claim:string|null;prepared:string|null;extracted:string|null;timings:string|null}
export interface KnowledgePipelineResult {processed:number;proposed:number;history:number;duplicates:number;empty:number;errors:string[]}

export class KnowledgePipeline {
  private running: Promise<KnowledgePipelineResult>|null=null;
  private stopped=false;
  get isStopped():boolean { return this.stopped; }
  get isRunning():boolean { return this.running!==null; }
  private controllers=new Set<AbortController>();
  constructor(readonly store: KnowledgeStore,private readonly stagePolicy:KnowledgeStagePolicy=KNOWLEDGE_STAGE_POLICY) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS source_events(
      id TEXT PRIMARY KEY,payload TEXT NOT NULL,hash TEXT NOT NULL,state TEXT NOT NULL,
      claim TEXT,lease_until INTEGER,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,created_at INTEGER NOT NULL,prepared TEXT);`);
    const columns=store.db.prepare('PRAGMA table_info(source_events)').all() as Array<{name:string}>;
    for(const name of ['extracted','timings'])if(!columns.some(c=>c.name===name))store.db.exec(`ALTER TABLE source_events ADD COLUMN ${name} TEXT`);
  }
  private get leaseMs():number {return 2*this.stagePolicy.maxAttempts*(this.stagePolicy.timeoutMs+this.stagePolicy.backoffMs*this.stagePolicy.maxAttempts)+30_000;}
  enqueue(event:KnowledgeSourceEvent):boolean {
    if (!event.id || !event.text.trim() || !Number.isFinite(event.evidence.eventTime)) throw new Error('缺少稳定事件身份或时间');
    if (event.evidence.eventTime<this.store.startedAt) return false; // No historical re-ingestion after cutover.
    if (event.text.length>24000) throw new Error('记忆事件超过24K上限；宿主需按真实轮次分段');
    if (event.namespace==='profile') throw new Error('事件抽取不能扩大到全局画像');
    const safe={...event,text:redactCredentialShapes(event.text).text};
    const payload=JSON.stringify(safe),hash=createHash('sha256').update(payload).digest('hex');
    this.store.db.exec('BEGIN IMMEDIATE');
    try{
      const previous=this.store.db.prepare('SELECT hash FROM source_events WHERE id=?').get(event.id) as {hash:string}|undefined;
      if(previous&&previous.hash!==hash) throw new Error(`同一事件身份对应不同内容：${event.id}`);
      if(!previous)this.store.db.prepare("INSERT INTO source_events(id,payload,hash,state,created_at) VALUES(?,?,?,'pending',?)").run(event.id,payload,hash,Date.now());
      this.store.db.exec('COMMIT');return !previous;
    }catch(error){this.store.db.exec('ROLLBACK');throw error;}
  }
  pending():number {
    return Number((this.store.db.prepare("SELECT COUNT(*) n FROM source_events WHERE state='pending' OR (state='running' AND lease_until<?)").get(Date.now()) as {n:number}).n);
  }
  run(callModel:KnowledgeModelCall):Promise<KnowledgePipelineResult> {
    if(this.running) return this.running;
    const owner=randomUUID();
    const empty={processed:0,proposed:0,history:0,duplicates:0,empty:0,errors:[]};
    if(this.stopped||!this.store.lease('processor',owner,this.leaseMs)) return Promise.resolve(empty);
    this.running=this.process(callModel,owner).finally(()=>{if(!this.stopped)this.store.releaseLease('processor',owner);this.running=null;});
    return this.running;
  }
  private async process(callModel:KnowledgeModelCall,owner:string):Promise<KnowledgePipelineResult> {
    const result:KnowledgePipelineResult={processed:0,proposed:0,history:0,duplicates:0,empty:0,errors:[]};
    for(let n=0;n<1;n++) {
      if(this.stopped||!this.store.lease('processor',owner,this.leaseMs)) break;
      const token=randomUUID(),now=Date.now();
      const row=this.store.db.prepare(`UPDATE source_events SET state='running',claim=?,lease_until=?,attempts=attempts+1
        WHERE id=(SELECT id FROM source_events WHERE state='pending' OR (state='running' AND lease_until<?) ORDER BY created_at,id LIMIT 1)
        RETURNING id,payload,claim,prepared,extracted,timings`).get(token,now+this.leaseMs,now) as EventRow|undefined;
      if(!row) break;
      const event=JSON.parse(row.payload) as KnowledgeSourceEvent;
      const controller=new AbortController();
      this.controllers.add(controller);
      const timings:KnowledgeStageTiming[]=row.timings?JSON.parse(row.timings):[];
      const report=(timing:KnowledgeStageTiming)=>{
        timings.push(timing);if(timings.length>20)timings.shift();
        const update=this.store.db.prepare("UPDATE source_events SET timings=? WHERE id=? AND claim=?").run(JSON.stringify(timings),row.id,token);
        if(!update.changes)throw new Error('事件处理租约已失效');
      };
      try {
        // Exact recent records are references only. Model must not create new claims from them.
        const existing=this.store.references(event.text,event.namespace,event.repoKey,event.branch)
          .map(r=>({id:r.id,summary:r.summary,action:r.action,exceptions:r.exceptions,applicability:r.applicability,status:r.status}));
        const produce=async()=>{
          const drafts=row.extracted?parseKnowledgeExtraction(row.extracted):await runKnowledgeStage('记忆抽取',async signal=>
            parseKnowledgeExtraction(await callModel({system:KNOWLEDGE_EXTRACT_PROMPT,user:JSON.stringify({newEvent:event.text,existingReferences:existing}),signal})),controller.signal,report,this.stagePolicy);
          if(!row.extracted){
            const saved=this.store.db.prepare("UPDATE source_events SET extracted=? WHERE id=? AND claim=?").run(JSON.stringify({records:drafts}),row.id,token);
            if(!saved.changes)throw new Error('事件处理租约已失效');
          }
          const viable=drafts.filter(d=>assessKnowledge(d,[event.evidence],event.origin).eligible);
          if(!viable.length) return drafts.map(d=>({...d,kind:'task_fact' as const}));
          const decisions=await runKnowledgeStage('价值审查',signal=>reviewKnowledgeDrafts(input=>callModel({...input,signal}),{event:event.text,drafts:viable,existing}),controller.signal,report,this.stagePolicy);
          this.store.setCheckpoint(`review:${event.id}`,JSON.stringify(decisions));
          const selected:KnowledgeDraft[]=drafts.filter(d=>!viable.includes(d)).map(d=>({...d,kind:'task_fact' as const}));
          for(const decision of decisions){
            if(decision.verdict==='keep') selected.push(viable[decision.index]);
            if(decision.verdict==='history') selected.push({...viable[decision.index],kind:'task_fact'});
            // Duplicate/discard are terminal. No confidence-based promotion or re-proposal.
          }
          return selected;
        };
        const drafts=row.prepared?parseKnowledgeExtraction(row.prepared):await produce();
        controller.signal.throwIfAborted();
        if(!row.prepared) {
          const prepared=this.store.db.prepare("UPDATE source_events SET prepared=? WHERE id=? AND claim=?").run(JSON.stringify({records:drafts}),row.id,token);
          if(!prepared.changes) throw new Error('事件处理租约已失效');
        }
        for(const draft of drafts) {
          const outcome=this.store.submit({...draft,repoKey:event.repoKey,branch:event.branch,taskId:event.taskId}, {
            namespace:event.namespace,origin:event.origin,evidence:[event.evidence],eventClaim:{id:event.id,token}
          });
          this.count(result,outcome);
        }
        const settled=this.store.db.prepare("UPDATE source_events SET state='done',claim=NULL,lease_until=NULL,error=NULL WHERE id=? AND claim=?").run(row.id,token);
        if(!settled.changes) throw new Error('事件处理租约已失效');
        result.processed++; if(!drafts.length) result.empty++;
      } catch(error) {
        const message=String((error as Error)?.message??error);
        if(!this.stopped)this.store.db.prepare("UPDATE source_events SET state='failed',claim=NULL,lease_until=NULL,error=? WHERE id=? AND claim=?").run(message.slice(0,1000),row.id,token);
        result.errors.push(`${row.id}: ${message}`);
      } finally {this.controllers.delete(controller);}
    }
    return result;
  }
  retryFailed():number {
    if(this.running)throw new Error('记忆处理正在运行，请等待当前批次结束后重试。');
    if(this.stopped)throw new Error('记忆处理已停止，请重新打开工作区。');
    this.store.setCheckpoint('processing:error','');
    return Number(this.store.db.prepare("UPDATE source_events SET state='pending',error=NULL WHERE state='failed'").run().changes);
  }
  stop():void {this.stopped=true;for(const controller of this.controllers)controller.abort();}
  private count(result:KnowledgePipelineResult,outcome:KnowledgeWriteResult):void {
    if(outcome.disposition==='proposed') result.proposed++;
    if(outcome.disposition==='retained_ephemeral') result.history++;
    if(outcome.disposition==='duplicate') result.duplicates++;
  }
}
