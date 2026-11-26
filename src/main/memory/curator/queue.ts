import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { sqliteFilePath } from '../../sqliteFilePath';
import type { GuiChatMessage } from '../../../shared/guiWorker';
import type { MemoryCuratorCandidate, MemoryCuratorReceipt, MemoryCorrectionStatus } from '../../../shared/memoryCurator';
import type {CuratorDecisionReceipt} from './storageTypes';
import { assertKnowledgeDirectory } from '../layout';
import { redactCredentialShapes } from '../redact';
import { knowledgeRepoKey } from '../knowledgePolicy';
import {t} from '../../../shared/i18n';

export interface CuratorClaim { candidate: MemoryCuratorCandidate; token: string; attempts: number; kind: 'candidate' | 'user' }
export interface CuratorQueueState { generation:number;version:number;sessionId?:string;sessionFile?:string;contextCharacters:number;error?:string;messages:GuiChatMessage[] }
interface QueueRow { id: string; payload: string; claim: string; attempts: number; kind: 'candidate' | 'user'; defer_single:number }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const DONE_VISIBLE_MS=7*24*60*60*1000;
const ARCHIVED_SQL="(archived_at IS NOT NULL OR (state='done' AND COALESCE(visible_since,completed_at,created_at)<=?))";
/** Preserve source changes while removing only host-generated tool-call labels. */
export function curatorSourceInformation(candidate: MemoryCuratorCandidate): string {
  let source = candidate.sourceText;
  for (const evidence of candidate.evidence) {
    const prefix = `${candidate.eventId}:tool:`;
    if (evidence.observation === 'tool_output' && evidence.id.startsWith(prefix)) {
      const callId = evidence.id.slice(prefix.length);
      source = source.replaceAll(`工具 ${callId} ${evidence.source} 状态=`, `工具 [host-call] ${evidence.source} 状态=`);
    }
  }
  return digest(JSON.stringify({ source, user: candidate.userText }));
}
function informationKey(candidate: MemoryCuratorCandidate, kind: 'candidate' | 'user', policyIdentity: string): string | undefined {
  // Each explicit human action keeps its own authorization, including a repeated restore request.
  if (kind === 'user' || candidate.explicit || candidate.evidence.some(e => /^memory-(?:curator-user|center(?:-revision)?)$/.test(e.source))) return undefined;
  const evidence = candidate.evidence.filter(e => !(['memory.note','memory.correct'].includes(e.source) && !e.contentHash && !e.excerpt && !e.observation))
    .map(e => JSON.stringify({ source: e.source, verification: e.verification, observation: e.observation,
      content: e.contentHash || (e.excerpt ? digest(e.excerpt) : e.id), excerpt: e.excerpt,
      repoKey: knowledgeRepoKey(e.repoKey), branch: e.branch, path: e.path })).sort();
  return digest(JSON.stringify({ version: 1, policyIdentity, namespace: candidate.namespace, origin: candidate.origin,
    repoKey: knowledgeRepoKey(candidate.repoKey), branch: candidate.branch, text: candidate.text,searchKeys:candidate.searchKeys,environment:candidate.environment,
    source: candidate.hostInformationHash ?? curatorSourceInformation(candidate), evidence: [...new Set(evidence)],
    correction:candidate.correction,requesterSessionId:candidate.correction?candidate.requesterSessionId:undefined }));
}
export class CuratorQueue {
  readonly db: DatabaseSync;
  constructor(root: string, readonly directory: string, private readonly now = Date.now) {
    assertKnowledgeDirectory(root, directory);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'curator.sqlite');
    for (const target of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(target) && (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink())) throw new Error('记忆队列账本不能使用目录或符号链接');
    this.db = new DatabaseSync(sqliteFilePath(file));
    try { this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL,
        state TEXT NOT NULL,claim TEXT,lease_until INTEGER,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,result TEXT,
        created_at INTEGER NOT NULL,available_at INTEGER NOT NULL,kind TEXT NOT NULL DEFAULT 'candidate');
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,payload TEXT NOT NULL,seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS leases(name TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS candidate_information(information_key TEXT PRIMARY KEY,candidate_id TEXT NOT NULL);`);
    this.transaction(()=>{
      const columns=new Set((this.db.prepare('PRAGMA table_info(candidates)').all() as Array<{name:string}>).map(column=>column.name));
      for(const [name,type] of [['completed_at','INTEGER'],['archived_at','INTEGER'],['visible_since','INTEGER'],['defer_single','INTEGER NOT NULL DEFAULT 0']]){
        if(!columns.has(name))this.db.exec(`ALTER TABLE candidates ADD COLUMN ${name} ${type}`);
      }
      // Historical receipts provide completion time when available. Never restart their
      // seven-day window merely because the app/database has been reopened or upgraded.
      this.db.exec(`UPDATE candidates SET completed_at=COALESCE(CASE WHEN json_valid(result) THEN
        CASE WHEN json_type(result,'$.at') IN ('integer','real') AND json_extract(result,'$.at') BETWEEN 0 AND 8640000000000000
          THEN json_extract(result,'$.at') END END,created_at) WHERE state='done' AND completed_at IS NULL`);
    });
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES('generation','1')").run();
    this.transaction(() => {
      if (this.get('informationIndexVersion') === '1') return;
      const insert = this.db.prepare('INSERT OR IGNORE INTO candidate_information VALUES(?,?)');
      const rows = this.db.prepare('SELECT id,payload,kind,result FROM candidates ORDER BY created_at,id').all() as Array<{id:string;payload:string;kind:'candidate'|'user';result:string|null}>;
      for (const row of rows) {
        const receipt = row.result ? JSON.parse(row.result) as {policyVersion?:string;reason?:string} : undefined;
        const policy = `${receipt?.policyVersion ?? 'memory-curator-v1'}:${receipt?.reason?.startsWith('观察模式：') ? 'observe' : 'automatic'}`;
        const key = informationKey(JSON.parse(row.payload) as MemoryCuratorCandidate, row.kind, policy);
        if (key) insert.run(key, row.id);
      }
      this.set('informationIndexVersion', '1');
    });
    } catch (error) { this.db.close(); throw error; }
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(key: string): string | undefined { return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value; }
  set(key: string, value: string): void { this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key, value); }
  get generation(): number { return Number(this.get('generation') ?? 1); }
  get paused(): boolean { return this.get('paused') === 'true'; }
  private isCurrent(generation:number,owner?:string):boolean {
    if(this.generation!==generation)return false;
    if(!owner)return true;
    const lease=this.db.prepare("SELECT owner,expires FROM leases WHERE name='processor'").get() as {owner:string;expires:number}|undefined;
    return lease?.owner===owner&&lease.expires>this.now();
  }
  sessionState():CuratorQueueState {
    return this.transaction(()=>({generation:this.generation,version:Number(this.get('transcriptVersion')||0),sessionId:this.get('sessionId')||undefined,
      sessionFile:this.get('sessionFile')||undefined,contextCharacters:Number(this.get('contextCharacters')||0),error:this.get('error')||undefined,messages:this.messages()}));
  }
  setIfCurrent(key:string,value:string,generation:number,owner?:string):boolean {
    return this.transaction(()=>{if(!this.isCurrent(generation,owner))return false;this.set(key,value);return true;});
  }
  publishSession(owner:string,generation:number,sessionId:string,sessionFile?:string):boolean {
    return this.transaction(()=>{if(!this.isCurrent(generation,owner))return false;this.set('sessionId',sessionId);this.set('sessionFile',sessionFile??'');return true;});
  }
  enqueue(candidate: MemoryCuratorCandidate, kind: 'candidate' | 'user' = 'candidate', policyIdentity = 'memory-curator-v1:automatic'): MemoryCuratorReceipt {
    if (candidate && ['untrusted','system'].includes(candidate.origin)) return { queued: false, candidateId: candidate.id, reason: '不可信或系统输出不能成为自动记忆候选' };
    if (!candidate || !candidate.id || candidate.id.length > 500 || !candidate.eventId || candidate.eventId.length > 500
      || !['worker','scheduler','profile'].includes(candidate.namespace)
      || !['user','worker','scheduler'].includes(candidate.origin)
      || typeof candidate.text !== 'string' || !candidate.text.trim() || candidate.text.length > 6000
      || typeof candidate.sourceText !== 'string' || !candidate.sourceText.trim() || candidate.sourceText.length > 24000
      || candidate.hostInformationHash != null && !/^[a-f0-9]{64}$/.test(candidate.hostInformationHash)
      || !Number.isFinite(candidate.createdAt) || !Array.isArray(candidate.evidence) || !candidate.evidence.length || candidate.evidence.length > 32
      || candidate.evidence.some(e => !e.id || !e.source || !Number.isFinite(e.eventTime))) throw new Error('记忆候选缺少可信身份、原始依据或超出长度范围');
    if (candidate.hostInformationHash && candidate.hostInformationHash !== curatorSourceInformation(candidate)) throw new Error('宿主原始材料身份与内容不匹配，请重新绑定依据');
    if(candidate.searchKeys!=null&&(!Array.isArray(candidate.searchKeys)||candidate.searchKeys.length<1||candidate.searchKeys.length>12||candidate.searchKeys.some(key=>typeof key!=='string'||!key.trim()||key.length>300)))throw new Error(t('记忆候选 searchKeys 无效'));
    if(candidate.correction){
      const c=candidate.correction;
      if(typeof c.memoryId!=='string'||!c.memoryId.trim()||c.memoryId.length>1000||!Number.isInteger(c.revision)||c.revision<1
        ||typeof c.problem!=='string'||!c.problem.trim()||c.problem.length>1500||typeof c.evidence!=='string'||!c.evidence.trim()||c.evidence.length>3000
        ||c.suggestion!=null&&(typeof c.suggestion!=='string'||!c.suggestion.trim()||c.suggestion.length>1500)
        ||typeof candidate.requesterSessionId!=='string'||!candidate.requesterSessionId.trim()||candidate.requesterSessionId.length>500)throw new Error('纠错请求缺少目标版本、问题、依据线索或宿主会话身份');
    }
    const payload = redactCredentialShapes(JSON.stringify(candidate)).text;
    // Evidence is a first-write snapshot: later tool completions must not create a second job.
    const identity = { kind, eventId: candidate.eventId, namespace: candidate.namespace, origin: candidate.origin,
      text: candidate.text, searchKeys:candidate.searchKeys, repoKey: candidate.repoKey, branch: candidate.branch, explicit: !!candidate.explicit,
      correction:candidate.correction,requesterSessionId:candidate.correction?candidate.requesterSessionId:undefined };
    const hash = createHash('sha256').update(redactCredentialShapes(JSON.stringify(identity)).text).digest('hex');
    return this.transaction(() => {
      const old = this.db.prepare('SELECT hash,state FROM candidates WHERE id=?').get(candidate.id) as { hash: string; state: string } | undefined;
      if (old && old.hash !== hash) throw new Error('同一记忆候选身份对应不同内容');
      if (old) return { queued: false, candidateId: candidate.id, reason: `候选已存在：${old.state}` };
      const key = informationKey(candidate, kind, policyIdentity);
      if (key) {
        const previous = this.db.prepare('SELECT c.id,c.state FROM candidate_information i JOIN candidates c ON c.id=i.candidate_id WHERE i.information_key=?').get(key) as {id:string;state:string}|undefined;
        if (previous) return {queued:false,candidateId:previous.id,reason:`原始依据、适用内容和策略未变化：${previous.state}；沿用原候选，不重复复评`};
        // Defensive seam for a future/explicit maintenance deletion. Only this orphaned key
        // is repaired under the enqueue write transaction; a live original always wins above.
        this.db.prepare(`DELETE FROM candidate_information WHERE information_key=?
          AND NOT EXISTS(SELECT 1 FROM candidates WHERE id=candidate_information.candidate_id)`).run(key);
      }
      this.db.prepare("INSERT INTO candidates(id,event_id,hash,payload,state,created_at,available_at,kind) VALUES(?,?,?,?,'pending',?,?,?)")
        .run(candidate.id, candidate.eventId, hash, payload, this.now(), this.now(), kind);
      if (key) this.db.prepare('INSERT INTO candidate_information VALUES(?,?)').run(key, candidate.id);
      return { queued: true, candidateId: candidate.id, reason: '候选已可靠入队，尚未作为长期知识生效' };
    });
  }
  acquire(owner: string, leaseMs: number): boolean {
    return this.transaction(() => {
      const old = this.db.prepare("SELECT owner,expires FROM leases WHERE name='processor'").get() as { owner: string; expires: number } | undefined;
      if (old && old.owner !== owner && old.expires > this.now()) return false;
      this.db.prepare("INSERT OR REPLACE INTO leases VALUES('processor',?,?)").run(owner, this.now() + leaseMs);
      return true;
    });
  }
  release(owner: string): void { this.db.prepare("DELETE FROM leases WHERE name='processor' AND owner=?").run(owner); }
  claim(limit: number, leaseMs: number, recoverCommitted = false): CuratorClaim[] {
    return this.transaction(() => {
      if (this.paused) return [];
      if(!recoverCommitted)this.db.prepare("UPDATE candidates SET state='failed',error='处理进程中断，有限重试已用尽',claim=NULL,lease_until=NULL WHERE state='running' AND lease_until<=? AND attempts>=3").run(this.now());
      const rows = this.db.prepare(`SELECT id,payload,claim,attempts,kind,defer_single FROM candidates
        WHERE ((state IN ('pending','deferred') AND available_at<=? AND attempts<3) OR (state='running' AND lease_until<? AND (attempts<3 OR ?=1)))
        ORDER BY created_at,id LIMIT ?`).all(this.now(), this.now(), recoverCommitted?1:0, Math.max(1, Math.min(3, limit))) as unknown as QueueRow[];
      const selected = rows[0]?.kind === 'user'||rows[0]?.defer_single ? rows.slice(0, 1) : rows.filter(row => row.kind === 'candidate'&&!row.defer_single);
      return selected.map(row => {
        const token = randomUUID();
        this.db.prepare("UPDATE candidates SET state='running',claim=?,lease_until=?,attempts=attempts+1,error=NULL WHERE id=?")
          .run(token, this.now() + leaseMs, row.id);
        return { candidate: JSON.parse(row.payload) as MemoryCuratorCandidate, token, attempts: row.attempts + 1, kind: row.kind };
      });
    });
  }
  assertClaim(claim: CuratorClaim, generation: number): void {
    const row = this.db.prepare("SELECT claim,lease_until FROM candidates WHERE id=? AND state='running'").get(claim.candidate.id) as { claim: string; lease_until: number } | undefined;
    if (this.paused || this.generation !== generation || !row || row.claim !== claim.token || row.lease_until < this.now()) throw new Error('记忆候选处理已暂停、过期或会话已换代');
  }
  settle(claim: CuratorClaim, result: unknown): void {
    const saved = this.db.prepare("UPDATE candidates SET state='done',result=?,completed_at=?,claim=NULL,lease_until=NULL,error=NULL WHERE id=? AND claim=? AND state='running'")
      .run(JSON.stringify(result), this.now(), claim.candidate.id, claim.token);
    if (!saved.changes) throw new Error('记忆候选处理回执已过期');
  }
  defer(claim: CuratorClaim, reason: string, retryAt?:number, single=false): void {
    if(retryAt!=null&&(!Number.isFinite(retryAt)||retryAt<0||retryAt>8.64e15))throw new Error('宿主重试时间无效');
    if(typeof single!=='boolean')throw new Error('宿主单条补试状态无效');
    const available=retryAt==null?this.now()+Math.min(900_000,30_000*2**Math.max(0,Math.min(claim.attempts-1,10))):Math.max(this.now(),retryAt);
    this.db.prepare("UPDATE candidates SET state=?,error=?,claim=NULL,lease_until=NULL,available_at=?,defer_single=MAX(defer_single,?) WHERE id=? AND claim=? AND state='running'")
      .run(claim.attempts >= 3 ? 'failed' : 'deferred', reason.slice(0, 1000), available, single?1:0, claim.candidate.id, claim.token);
  }
  requeue(claim: CuratorClaim): void {
    this.db.prepare("UPDATE candidates SET state='pending',claim=NULL,lease_until=NULL,attempts=MAX(0,attempts-1),available_at=? WHERE id=? AND claim=? AND state='running'")
      .run(this.now(), claim.candidate.id, claim.token);
  }
  fail(claim: CuratorClaim, reason: string): void {
    this.db.prepare("UPDATE candidates SET state='failed',error=?,claim=NULL,lease_until=NULL WHERE id=? AND claim=? AND state='running'").run(reason.slice(0, 1000), claim.candidate.id, claim.token);
  }
  retryFailed(): number {
    return Number(this.db.prepare("UPDATE candidates SET state='pending',attempts=0,error=NULL,available_at=MAX(available_at,?) WHERE state='failed' AND archived_at IS NULL").run(this.now()).changes);
  }
  counts(): { pending: number; failed: number } {
    const row = this.db.prepare("SELECT SUM(CASE WHEN state IN ('pending','running','deferred') THEN 1 ELSE 0 END) pending,SUM(CASE WHEN state='failed' AND archived_at IS NULL THEN 1 ELSE 0 END) failed FROM candidates").get() as { pending: number | null; failed: number | null };
    return { pending: Number(row.pending ?? 0), failed: Number(row.failed ?? 0) };
  }
  nextWakeAt(): number | undefined {
    const row = this.db.prepare("SELECT MIN(CASE WHEN state='running' THEN lease_until ELSE available_at END) next FROM candidates WHERE (state IN ('pending','deferred') AND attempts<3) OR state='running'").get() as { next: number | null };
    return row.next ?? undefined;
  }
  /** Read-only, session-owned receipt lookup. Never starts Pi or returns source payloads. */
  correctionStatus(requestId:string,requesterSessionId:string):MemoryCorrectionStatus {
    if(typeof requestId!=='string'||!requestId.trim()||requestId.length>500||typeof requesterSessionId!=='string'||!requesterSessionId.trim()||requesterSessionId.length>500)throw new Error('无效纠错请求身份');
    const row=this.db.prepare('SELECT payload,state,error,result FROM candidates WHERE id=?').get(requestId) as {payload:string;state:string;error:string|null;result:string|null}|undefined;
    const candidate=row?JSON.parse(row.payload) as MemoryCuratorCandidate:undefined;
    if(!candidate?.correction||candidate.requesterSessionId!==requesterSessionId)throw new Error('纠错请求不存在或不属于当前会话');
    const base={requestId,targetId:candidate.correction.memoryId,targetRevision:candidate.correction.revision,suggestion:candidate.correction.suggestion};
    if(row!.state!=='done'){
      if(!['pending','running','deferred','failed'].includes(row!.state))throw new Error('纠错请求状态损坏');
      return {...base,status:row!.state as 'pending'|'running'|'deferred'|'failed',completed:false,
        reason:redactCredentialShapes(row!.error??(row!.state==='running'?'纠错正在审核，尚未改变记忆':'纠错尚未完成')).text.slice(0,1000)};
    }
    const result=row!.result?JSON.parse(row!.result) as CuratorDecisionReceipt:undefined;
    if(!result||result.candidateId!==requestId||result.targetId!==base.targetId||result.targetRevision!==base.targetRevision
      ||!['updated','suspended','discarded','rejected','needs_user'].includes(result.disposition))throw new Error('纠错持久回执无效');
    return {...base,status:result.disposition==='discarded'?'rejected':result.disposition as 'updated'|'suspended'|'rejected'|'needs_user',completed:true,
      reason:redactCredentialShapes(result.reason).text.slice(0,1000),recordId:result.record?.id,recordRevision:result.record?.revision,proposedCorrection:result.proposedCorrection};
  }
  inspect(input: import('../../../shared/memoryCurator').MemoryCuratorQueueQuery = {}): import('../../../shared/memoryCurator').MemoryCuratorQueuePage {
    if (!input || typeof input!=='object'||Array.isArray(input)||!['all','queued','attention','pending','running','deferred','failed','done'].includes(input.state ?? 'all')) throw new Error('无效记忆队列状态');
    if(!['visible','archived','all'].includes(input.visibility??'visible'))throw new Error('无效整理记录可见范围');
    const offset = input.offset ?? 0, limit = input.limit ?? 30;
    if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('无效记忆队列分页');
    const conditions:string[]=[],params:Array<string|number>=[],cutoff=this.now()-DONE_VISIBLE_MS;
    if(input.state==='queued')conditions.push("state IN ('pending','running','deferred')");
    else if(input.state==='attention')conditions.push("(state IN ('pending','running','deferred','failed') OR (state='done' AND json_extract(result,'$.disposition')='needs_user'))");
    else if(input.state&&input.state!=='all'){conditions.push('state=?');params.push(input.state);}
    if(input.visibility!=='all'){conditions.push(`${input.visibility==='archived'?'':'NOT '}${ARCHIVED_SQL}`);params.push(cutoff);}
    const filter=conditions.length?` WHERE ${conditions.join(' AND ')}`:'';
    const total = Number((this.db.prepare(`SELECT COUNT(*) total FROM candidates${filter}`).get(...params) as {total:number}).total);
    const rows = this.db.prepare(`SELECT id,kind,payload,state,created_at,available_at,attempts,error,result,${ARCHIVED_SQL} archived FROM candidates${filter}
      ORDER BY CASE state WHEN 'failed' THEN 0 WHEN 'running' THEN 1 WHEN 'pending' THEN 2 WHEN 'deferred' THEN 3 ELSE 4 END,created_at DESC,id DESC LIMIT ? OFFSET ?`).all(cutoff,...params, limit, offset) as Array<{
        id:string;kind:'candidate'|'user';payload:string;state:import('../../../shared/memoryCurator').MemoryCuratorQueueState;created_at:number;available_at:number;attempts:number;error:string|null;result:string|null;archived:number
      }>;
    return { total, offset, limit, items: rows.map(row => {
      const candidate = JSON.parse(row.payload) as MemoryCuratorCandidate;
      const result = row.result ? JSON.parse(row.result) as CuratorDecisionReceipt : undefined;
      return { id:row.id,kind:row.kind,text:candidate.text,namespace:candidate.namespace,state:row.state,archived:!!row.archived,createdAt:row.created_at,availableAt:row.available_at,attempts:row.attempts,
        evidenceCount:candidate.evidence.length,correction:candidate.correction,error:row.error??undefined,
        result:result?{disposition:result.disposition,reason:result.reason,recordId:result.record?.id,recordRevision:result.record?.revision,proposedCorrection:result.proposedCorrection,targetId:result.targetId,targetRevision:result.targetRevision}:undefined };
    }) };
  }
  /** Presentation-only mutation: no candidate processing, receipt or knowledge changes. */
  setArchived(candidateId:string,archived:boolean):boolean {
    if(typeof candidateId!=='string'||!candidateId.trim()||candidateId.length>500)throw new Error('无效整理记录ID');
    if(typeof archived!=='boolean')throw new Error('无效整理记录归档状态');
    return this.transaction(()=>{
      const now=this.now(),row=this.db.prepare(`SELECT state,${ARCHIVED_SQL} archived FROM candidates WHERE id=?`).get(now-DONE_VISIBLE_MS,candidateId) as {state:string;archived:number}|undefined;
      if(!row)throw new Error('整理记录不存在，请刷新后重试');
      if(!['done','failed'].includes(row.state))throw new Error('正在处理的整理记录不能归档或恢复');
      if(!!row.archived===archived)return false;
      if(archived)this.db.prepare('UPDATE candidates SET archived_at=? WHERE id=?').run(now,candidateId);
      else this.db.prepare("UPDATE candidates SET archived_at=NULL,visible_since=CASE WHEN state='done' THEN ? ELSE visible_since END WHERE id=?").run(now,candidateId);
      return true;
    });
  }
  messages(): GuiChatMessage[] {
    return (this.db.prepare('SELECT payload FROM messages ORDER BY seq').all() as Array<{ payload: string }>).map(r => JSON.parse(r.payload) as GuiChatMessage);
  }
  recordRun(id: string, metrics: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO runs VALUES(?,?)').run(id, JSON.stringify(metrics));
  }
  saveMessages(messages: GuiChatMessage[],generation:number,owner:string): number|undefined {
    return this.transaction(() => {
      if(!this.isCurrent(generation,owner))return undefined;
      this.db.exec('DELETE FROM messages');
      const insert = this.db.prepare('INSERT INTO messages VALUES(?,?,?)');
      messages.forEach((message, index) => insert.run(message.id, redactCredentialShapes(JSON.stringify(message)).text, index));
      const version=Number(this.get('transcriptVersion')||0)+1;this.set('transcriptVersion',String(version));return version;
    });
  }
  clearTranscript(): void {
    this.transaction(() => {
      this.rotateSessionInside(); this.set('error', '');
      this.db.exec('DELETE FROM messages');
      this.set('transcriptVersion',String(Number(this.get('transcriptVersion')||0)+1));
    });
  }
  private rotateSessionInside():void {
    this.set('generation', String(this.generation + 1));
    this.set('sessionFile', ''); this.set('sessionId', ''); this.set('contextCharacters', '0');
  }
  rotateSession(generation:number,owner:string):boolean {
    return this.transaction(()=>{if(!this.isCurrent(generation,owner))return false;this.rotateSessionInside();return true;});
  }
  close(): void { this.db.close(); }
}
