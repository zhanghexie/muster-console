import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { sqliteFilePath } from '../sqliteFilePath';
import type { KnowledgeEvidence, KnowledgeHit, KnowledgeNamespace, KnowledgeQuery, KnowledgeRecord, KnowledgeSnapshot, KnowledgeWriteResult } from '../../shared/knowledge';
import { assessKnowledge, knowledgeIdentity, knowledgeSimilarity, knowledgeTokens, sameKnowledge, validateKnowledgeDraft,knowledgeRepoKey } from './knowledgePolicy';
import { writeTextAtomicSync } from '../atomicJson';
import { redactCredentialShapes } from './redact';
import { ftsColumnText, ftsMatchExprAny } from './tokenize';
import type {KnowledgeGovernanceInput,KnowledgeGovernanceReceipt} from '../../shared/knowledge';
import type {CuratorDecisionContext,CuratorDecisionInput,CuratorDecisionReceipt,CuratorDeletion,CuratorReferences,CuratorScope} from './curator/storageTypes';
import {disableCuratorPolicy,isCuratorPolicyDisabled,curatorPolicyAvailable,compensateCuratorPolicy} from './curatorPolicy';
import {findSourceQuote,normalizeQuoteFormatting} from './curator/sourceQuote';
import {validateCuratorDraft} from './curator/draftDiagnostics';
import {checkMemoryEnvironment} from './environment';
import {validateProfileSource} from './profileProvenance';

const digest = (s: string) => createHash('sha256').update(s).digest('hex');
type ProjectionStorage={mode:string};
const scopeTerm=(kind:string,value:string|undefined)=>`scope${kind}${digest(value??'*')}`;
export function knowledgeFtsText(record:KnowledgeRecord):string {
  return [scopeTerm('namespace',record.namespace),scopeTerm('repo',record.repoKey),scopeTerm('branch',record.branch),ftsColumnText([record.summary,record.problem,record.action,record.rationale,...record.applicability,...(record.searchKeys??[])].filter(Boolean).join(' ').toLowerCase())].join(' ');
}
/** Stable identity for the derived FTS body. The ledger payload remains canonical. */
export function knowledgeFtsContentHash(record:KnowledgeRecord):string {
  return digest(knowledgeFtsText(record));
}
const PREFIX = '<!-- muster-knowledge:1\n';
export function encodeKnowledge(record: KnowledgeRecord): string {
  // JSON stays inside a comment, including adversarial comment delimiters in tool data.
  return PREFIX + JSON.stringify(record).replace(/</g,'\\u003c').replace(/>/g,'\\u003e') + '\n-->\n\n' + record.summary + '\n';
}
export function decodeKnowledge(text: string): KnowledgeRecord {
  if (!text.startsWith(PREFIX)) throw new Error('未知记忆资产格式');
  const end = text.indexOf('\n-->\n', PREFIX.length);
  if (end < 0) throw new Error('记忆资产不完整');
  const record = JSON.parse(text.slice(PREFIX.length,end)) as KnowledgeRecord;
  validateKnowledgeDraft(record);
  if (record.schema !== 1 || !/^[a-f0-9-]{36}$/.test(record.id) || !Number.isInteger(record.revision) || record.revision < 1
    || !['worker','scheduler','profile','host'].includes(record.namespace) || !['pending','active','needs_revalidation','superseded','archived','rejected'].includes(record.status)
    || !['user','worker','scheduler','untrusted','system'].includes(record.origin)
    || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)
    || typeof record.decisionReason!=='string'
    || record.userManaged!==undefined&&typeof record.userManaged!=='boolean'
    || !Array.isArray(record.evidence) || !Array.isArray(record.history)) throw new Error('记忆资产元数据损坏');
  validateEvidence(record.evidence);
  return record;
}

function validateEvidence(evidence: KnowledgeEvidence[]): void {
  if(!Array.isArray(evidence)||!evidence.length||evidence.length>32)throw new Error('evidence: 记忆证据必须由宿主提供1至32条可追溯事件');
  const ids=new Set<string>(),errors:string[]=[];
  for(const [index,item] of evidence.entries()){
    const field=(name:string)=>`evidence[${index}].${name}`;
    if(!item||typeof item!=='object'){errors.push(`evidence[${index}]: 记忆证据必须由宿主提供可追溯事件对象`);continue;}
    for(const key of ['id','source','sessionId','turnId','snapshotId','path','repoKey','branch'] as const){
      const value=item[key],required=key==='id'||key==='source';
      if(required&&!value||value!=null&&(typeof value!=='string'||value.length>1000))errors.push(`${field(key)}: 必须为${required?'非空':''}宿主来源文本，最多1000字符`);
    }
    if(!Number.isFinite(item.eventTime))errors.push(`${field('eventTime')}: 必须为有限数值事件时间`);
    if(!['unverified','test','integration','runtime','user_stated','user_confirmed'].includes(item.verification))errors.push(`${field('verification')}: 必须为宿主绑定的unverified/test/integration/runtime/user_stated/user_confirmed等级`);
    if(ids.has(item.id))errors.push(`${field('id')}: 证据身份不能重复`);ids.add(item.id);
    if(item.contentHash!=null&&(typeof item.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(item.contentHash)))errors.push(`${field('contentHash')}: 证据内容签名必须为64位小写十六进制哈希`);
    if(item.excerpt!=null&&(typeof item.excerpt!=='string'||item.excerpt.length>4000))errors.push(`${field('excerpt')}: 证据摘录必须为文本，最多4000字符`);
    if(item.observation!=null&&!['tool_output','user_input'].includes(item.observation))errors.push(`${field('observation')}: 宿主观察类型仅允许tool_output或user_input`);
  }
  if(errors.length)throw new Error(errors.join('\n'));
}
type ObservedEvidence=KnowledgeEvidence&{contentHash?:string;excerpt?:string;observation?:'tool_output'|'user_input'};
function hostObservedEvidence(evidence:KnowledgeEvidence,quote:string):boolean {
  const observed=evidence as ObservedEvidence;
  return observed.observation==='tool_output'&&typeof observed.contentHash==='string'&&/^[a-f0-9]{64}$/.test(observed.contentHash)
    &&typeof observed.excerpt==='string'&&!!findSourceQuote(observed.excerpt,quote);
}
function mergeEvidence(existing:KnowledgeEvidence[],incoming:KnowledgeEvidence[]):KnowledgeEvidence[] {
  const result=new Map(existing.map(item=>[item.id,item]));
  for(const item of incoming){
    const previous=result.get(item.id);
    if(!previous){result.set(item.id,item);continue;}
    if(JSON.stringify(previous)===JSON.stringify(item))continue;
    const {excerpt:before,...previousIdentity}=previous,{excerpt:after,...incomingIdentity}=item;
    // Selected excerpts can differ for the same observation. Only a matching host
    // content hash and identical provenance permit merging them; never splice text.
    if(!previous.contentHash||JSON.stringify(previousIdentity)!==JSON.stringify(incomingIdentity))throw new Error('相同证据身份对应不同来源');
    const excerpt=!before?after:after?.includes(before)?after:before;
    result.set(item.id,excerpt?{...previousIdentity,excerpt}:previousIdentity);
  }
  if(result.size>32)throw new Error('合并后超过32条证据上限，不能丢弃已有依据');
  return [...result.values()];
}
/** Retain provenance for every observation, but only keep excerpts that contain the selected source quote. */
function evidenceForQuote(evidence:KnowledgeEvidence[],quote:string,userText?:string):KnowledgeEvidence[] {
  if(!quote.trim())return evidence;
  const matches=evidence.map(item=>{
    const source=item.observation==='user_input'&&userText?userText:item.excerpt;
    if(!source)return undefined;
    const found=findSourceQuote(source,quote);
    if(!found||found.text.length>4000)return undefined;
    const context=Math.min(180,Math.floor((4000-found.text.length)/2));
    return source.slice(Math.max(0,found.offset-context),Math.min(source.length,found.end+context));
  });
  // If a quote spans host wrappers or is otherwise not attributable, retain the original evidence.
  if(!matches.some(Boolean))return evidence;
  return evidence.map((item,index)=>{
    const {excerpt:_,...identity}=item;
    return matches[index]?{...identity,excerpt:matches[index]}:identity;
  });
}
/** Inspect the quoted instruction's original clause, not unrelated negative clauses elsewhere. */
function authorizesUserAction(userText:string,quote:string,action:RegExp):boolean {
  const core=quote.trim().replace(/^[，,。.!！?？;；\s]+|[，,。.!！?？;；\s]+$/g,'');
  if(!core)return false;
  const verb=action.exec(core);if(!verb)return false;
  const boundaries=[...userText.matchAll(/[，,。.!！?？;；\n]|但是|不过|然而|而是|但|\b(?:but|however|yet)\b/gi)];
  for(let offset=userText.indexOf(core);offset>=0;offset=userText.indexOf(core,offset+1)){
    const previous=boundaries.filter(item=>item.index!<offset).at(-1),next=boundaries.find(item=>item.index!>=offset);
    const start=previous?previous.index!+previous[0].length:0,end=next?.index??userText.length;
    if(offset+core.length>end)continue;
    const prefix=normalizeQuoteFormatting(userText.slice(start,offset+verb.index));
    if(/(?:不要|勿|别|不能|不准|禁止|不得|不可|不应|避免|取消|撤销|不再).{0,8}$/.test(prefix)
      ||/\b(?:do not|don't|never|must not|cannot|can't|should not|shouldn't|cancel|undo)(?:\s+\w+){0,3}\s*$/i.test(prefix))continue;
    return true;
  }
  return false;
}

export interface KnowledgeWriteContext {
  namespace: KnowledgeNamespace;
  origin: KnowledgeRecord['origin'];
  evidence: KnowledgeEvidence[];
  /** Host-only: authenticated explicit remember, never a model-supplied flag. */
  explicit?: boolean;
  derivedFrom?: Array<{id:string;revision:number}>;
  now?: number;
  eventClaim?: {id:string;token:string};
}

/**
 * New-format assets only. SQLite holds the recoverable commit journal and derived lookup.
 * A commit becomes readable only after its atomic Markdown projection has drained.
 * The outbox retains both old and new hashes, so a crash cannot overwrite external edits.
 */
export class KnowledgeStore {
  readonly db: DatabaseSync;
  readonly assetsDir: string;
  readonly startedAt: number;
  private transactionDepth=0;
  private curatorAdmission=false;
  private curatorReason?:string;
  private readonly projectionIssues=new Map<string,'missing'|'modified'>();
  constructor(readonly directory: string, readonly ledgerDirectory = directory) {
    fs.mkdirSync(directory,{recursive:true});
    this.assetsDir = path.join(directory,'entries');
    fs.mkdirSync(this.assetsDir,{recursive:true});
    fs.mkdirSync(ledgerDirectory,{recursive:true});
    this.db = new DatabaseSync(sqliteFilePath(path.join(ledgerDirectory,'knowledge.sqlite')));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, payload TEXT NOT NULL, old_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,record_id TEXT,kind TEXT,at INTEGER,detail TEXT);
      CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS versions(id TEXT,revision INTEGER,payload TEXT NOT NULL,PRIMARY KEY(id,revision))');
    this.db.exec('CREATE TABLE IF NOT EXISTS governance(id TEXT PRIMARY KEY,receipt TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS leases(name TEXT PRIMARY KEY,owner TEXT,expires INTEGER)');
    this.db.exec(`CREATE TABLE IF NOT EXISTS knowledge_deleted(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS curator_receipts(operation_id TEXT PRIMARY KEY,signature TEXT NOT NULL,receipt TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS record_storage(id TEXT PRIMARY KEY,mode TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_fts_meta(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,content_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_hot(
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        repo_key TEXT,
        branch TEXT,
        task_id TEXT
      );
      CREATE INDEX IF NOT EXISTS knowledge_hot_updated ON knowledge_hot(updated_at DESC,id ASC);
      CREATE INDEX IF NOT EXISTS knowledge_hot_namespace_updated ON knowledge_hot(namespace,updated_at DESC,id ASC);`);
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS curator_candidate_receipt ON curator_receipts(json_extract(receipt,'$.candidateId'))");
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(id UNINDEXED,body);
      CREATE TABLE IF NOT EXISTS relations(source_id TEXT,target_id TEXT,kind TEXT,inferred INTEGER,PRIMARY KEY(source_id,target_id,kind));`);
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES('startedAt',?)").run(String(Date.now()));
    this.startedAt = Number((this.db.prepare("SELECT value FROM meta WHERE key='startedAt'").get() as {value:string}).value);
    try { this.transaction(()=> {
      this.drain();
      for (const file of fs.readdirSync(this.assetsDir)) {
        if (!file.endsWith('.md')) continue;
        if(fs.lstatSync(path.join(this.assetsDir,file)).isSymbolicLink()) throw new Error('记忆资产不能是符号链接');
        const fileId=file.slice(0,-3);
        const existing=this.db.prepare('SELECT payload FROM records WHERE id=?').get(fileId) as {payload:string}|undefined;
        // Ledger-backed projections are verified below, including malformed external edits.
        if(existing){
          if(this.isLedgerOnly(fileId))throw new Error(`仅账本历史出现非预期投影：${fileId}`);
          continue;
        }
        const record = decodeKnowledge(fs.readFileSync(path.join(this.assetsDir,file),'utf8'));
        if (`${record.id}.md` !== file) throw new Error('记忆资产身份与文件名不一致');
        const storage=this.storage(record.id);
        if(storage?.mode==='ledger-only') throw new Error(`仅账本历史出现非预期投影：${record.id}`);
        const row = this.db.prepare('SELECT payload FROM records WHERE id=?').get(record.id) as {payload:string}|undefined;
        if (row && row.payload !== JSON.stringify(record)) throw new Error(`记忆资产存在外部修改，请先核对：${record.id}`);
        this.db.prepare('INSERT OR IGNORE INTO records VALUES(?,?)').run(record.id,JSON.stringify(record));
      }
      // Indexes are disposable; identities, decisions and event ledger are not.
      this.db.exec('DELETE FROM relations;');
      const records=this.rows();
      // FTS is disposable. Remove stale derived rows while retaining valid rows
      // whose content hash and revision still match the ledger.
      this.db.exec(`DELETE FROM knowledge_fts_meta WHERE id NOT IN (SELECT id FROM records);
        DELETE FROM knowledge_fts WHERE id NOT IN (SELECT id FROM records);`);
      // The hot projection is disposable as well. Reconcile it from the
      // canonical ledger on every open so old databases and partial writes are
      // repaired without changing records or Markdown projections.
      this.db.exec('DELETE FROM knowledge_hot WHERE id NOT IN (SELECT id FROM records)');
      for(const record of records) {
        if(!this.isLedgerOnly(record.id)){
          // A missing or edited projection must not make an invalid ledger trustworthy.
          decodeKnowledge(encodeKnowledge(record));
          const actual=this.readFile(record.id);
          if(actual!==encodeKnowledge(record))this.projectionIssues.set(record.id,fs.existsSync(this.file(record.id))?'modified':'missing');
        }
        this.index(record);
      }
    }); } catch(error) {this.db.close();throw error;}
    for(const issue of this.integrityIssues())console.warn(`[knowledge] 记忆资产${issue.reason==='missing'?'缺失':'与账本不一致'}，已隔离：${issue.id}`);
  }
  private transaction<T>(fn:()=>T):T {
    if(this.transactionDepth){this.transactionDepth++;try{return fn();}finally{this.transactionDepth--;}}
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth=1;
    try { const result=fn(); this.db.exec('COMMIT'); return result; }
    catch(error) { this.db.exec('ROLLBACK'); throw error; }
    finally{this.transactionDepth=0;}
  }
  private file(id:string):string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('非法记忆ID');
    return path.join(this.assetsDir,`${id}.md`);
  }
  private readFile(id:string):string {
    try { return fs.readFileSync(this.file(id),'utf8'); }
    catch(error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  }
  private storage(id:string):ProjectionStorage|undefined {return this.db.prepare('SELECT mode FROM record_storage WHERE id=?').get(id) as ProjectionStorage|undefined;}
  private isLedgerOnly(id:string):boolean {return this.storage(id)?.mode==='ledger-only';}
  private deletedById(id:string):CuratorDeletion|undefined {
    const row=this.db.prepare('SELECT payload FROM knowledge_deleted WHERE id=?').get(id) as {payload:string}|undefined;
    return row?JSON.parse(row.payload) as CuratorDeletion:undefined;
  }
  private rememberDeletion(record:KnowledgeRecord,revision:number,now:number):void {
    const {kind,summary,problem,action,rationale,applicability,exceptions,searchKeys,expectedFutureUse,repoKey,branch,taskId,expiresAt}=record;
    const deleted:CuratorDeletion={id:record.id,revision,namespace:record.namespace,deletedAt:now,
      kind,summary,problem,action,rationale,applicability,exceptions,searchKeys,expectedFutureUse,repoKey,branch,taskId,expiresAt};
    this.db.prepare('INSERT OR REPLACE INTO knowledge_deleted VALUES(?,?)').run(record.id,JSON.stringify(deleted));
  }
  private scopeMatches(record:{namespace:KnowledgeNamespace;repoKey?:string;branch?:string},scope:CuratorScope):boolean {
    return record.namespace===scope.namespace&&(!record.repoKey||record.repoKey===knowledgeRepoKey(scope.repoKey))&&(!record.branch||record.branch===scope.branch);
  }
  private sameBoundary(a:{applicability:string[];exceptions?:string[];environment?:KnowledgeRecord['environment']},b:{applicability:string[];exceptions?:string[];environment?:KnowledgeRecord['environment']}):boolean {
    const normalized=(v:string[])=>[...new Set(v.map(knowledgeIdentity))].sort();
    const dependencies=(v:typeof a)=>[...(v.environment??[])].sort((x,y)=>x.key.localeCompare(y.key));
    return JSON.stringify([normalized(a.applicability),normalized(a.exceptions??[]),dependencies(a)])===JSON.stringify([normalized(b.applicability),normalized(b.exceptions??[]),dependencies(b)]);
  }
  /** Receipt identity survives later user deletion; recovery acknowledges it without replaying writes. */
  curatorReceipt(candidateId:string):CuratorDecisionReceipt|undefined {
    if(typeof candidateId!=='string'||!candidateId||candidateId.length>240)throw new Error('非法记忆候选身份');
    const row=this.db.prepare("SELECT receipt FROM curator_receipts WHERE json_extract(receipt,'$.candidateId')=?").get(candidateId) as {receipt:string}|undefined;
    return row?JSON.parse(row.receipt) as CuratorDecisionReceipt:undefined;
  }
  /** Host maintenance APIs are never exposed to the memory model's closed tool set. */
  disablePolicy(version:string,reason:string):void {this.transaction(()=>disableCuratorPolicy(this.db,version,reason));}
  compensatePolicy(version:string,options:{limit?:number;now?:number}={}) {
    return compensateCuratorPolicy({db:this.db,transaction:fn=>this.transaction(fn),persist:(record,event)=>this.persist(record,event),drain:()=>this.drain()},version,options);
  }
  /** Keep the committed ledger for comparison, but never recall an unverified projection. */
  integrityIssues():Array<{id:string;reason:'missing'|'modified'}> {
    for(const id of this.projectionIssues.keys()){
      const row=this.db.prepare('SELECT payload FROM records WHERE id=?').get(id) as {payload:string}|undefined;
      if(!row||this.isLedgerOnly(id)){this.projectionIssues.delete(id);continue;}
      const actual=this.readFile(id);
      if(actual===encodeKnowledge(JSON.parse(row.payload) as KnowledgeRecord))this.projectionIssues.delete(id);
      else this.projectionIssues.set(id,fs.existsSync(this.file(id))?'modified':'missing');
    }
    return [...this.projectionIssues].map(([id,reason])=>({id,reason}));
  }
  policyAllows(record:KnowledgeRecord):boolean {return !this.projectionIssues.has(record.id)&&curatorPolicyAvailable(this.db,record);}
  /** Includes retired knowledge solely for the curator's comparison tool, never task injection. */
  curatorReferences(query:string,scope:CuratorScope):CuratorReferences {
    if(typeof query!=='string'||!['worker','scheduler','profile','host'].includes(scope.namespace))throw new Error('非法记忆查询范围');
    this.transaction(()=>this.drain());
    const text=knowledgeIdentity(query).slice(0,6000);
    const indexed=this.references(text,scope.namespace,scope.repoKey,scope.branch),rank=new Map(indexed.map((record,index)=>[record.id,indexed.length-index]));
    const records=this.rows().filter(record=>record.kind!=='task_fact'&&this.scopeMatches(record,scope))
      .map(record=>({record,score:(rank.get(record.id)??0)+knowledgeSimilarity(text,[record.summary,record.action,...record.applicability].filter(Boolean).join(' '))}))
      .filter(item=>item.score>0).sort((a,b)=>b.score-a.score||b.record.updatedAt-a.record.updatedAt).slice(0,48).map(item=>item.record);
    return {records,deleted:this.deletedKnowledge(scope)};
  }
  deletedKnowledge(scope:CuratorScope):CuratorDeletion[] {
    return (this.db.prepare('SELECT payload FROM knowledge_deleted ORDER BY id').all() as Array<{payload:string}>)
      .map(row=>JSON.parse(row.payload) as CuratorDeletion).filter(record=>this.scopeMatches(record,scope));
  }
  /** Whole-store deletion identity for the host knowledge center; never broadens curator mutation scope. */
  deletedKnowledgeIds():string[] {
    return (this.db.prepare('SELECT id FROM knowledge_deleted ORDER BY id').all() as Array<{id:string}>).map(row=>row.id);
  }
  /** Host-only API: the specialized role supplies a verdict; source and capabilities are host bound. */
  commitCuratorDecision(input:CuratorDecisionInput,ctx:CuratorDecisionContext):CuratorDecisionReceipt {
    const short=(value:unknown,cap:number)=>typeof value==='string'&&value.trim().length>0&&value.length<=cap;
    if(!input)throw new Error('decision: 必须提供记忆决策对象');
    const inputErrors:string[]=[];
    for(const [field,cap] of [['operationId',240],['candidateId',240],['policyVersion',120],['reason',1000]] as const){
      if(!short(input[field],cap))inputErrors.push(`${field}: 必须为非空文本，最多${cap}字符`);
    }
    if(!['save','duplicate','discard','history','suspend','supersede','delete','restore','correct'].includes(input.decision))inputErrors.push('decision: 未知记忆决策');
    if(typeof input.sourceQuote!=='string'||input.sourceQuote.length>6000)inputErrors.push('sourceQuote: 必须为原文引用字符串，最多6000字符');
    if(inputErrors.length)throw new Error(inputErrors.join('\n'));
    if(!ctx||!['worker','scheduler','profile'].includes(ctx.namespace)||!['user','worker','scheduler','untrusted','system'].includes(ctx.origin)
      ||typeof ctx.sourceText!=='string'||ctx.sourceText.length>128000||(ctx.userText!=null&&(typeof ctx.userText!=='string'||ctx.userText.length>24000))
      ||!Number.isFinite(ctx.now??Date.now()))throw new Error('缺少宿主记忆来源');
    validateEvidence(ctx.evidence);
    if(input.decision==='correct'&&!ctx.correction)throw new Error('correct: 仅允许宿主绑定的纠错请求');
    if(ctx.correction){
      const correction=ctx.correction;
      if(typeof correction.memoryId!=='string'||!correction.memoryId||!Number.isInteger(correction.revision)||correction.revision<1)throw new Error('纠错请求目标版本无效');
      if(!['correct','suspend','discard'].includes(input.decision))throw new Error('纠错请求只能更正、暂停原目标或不收录，不能转为其他写入');
      if(input.targetId!=null&&input.targetId!==correction.memoryId||input.targetRevision!=null&&input.targetRevision!==correction.revision
        ||input.decision!=='discard'&&(input.targetId!==correction.memoryId||input.targetRevision!==correction.revision))throw new Error('纠错目标必须匹配宿主绑定的原始ID和版本');
    }
    const now=ctx.now??Date.now(),scope:CuratorScope={namespace:ctx.namespace,repoKey:knowledgeRepoKey(ctx.repoKey),branch:ctx.branch};
    const signature=digest(JSON.stringify({input:{...input,operationId:undefined},namespace:ctx.namespace,origin:ctx.origin,evidence:ctx.evidence,source:digest(ctx.sourceText),user:ctx.userText==null?undefined:digest(ctx.userText),repoKey:scope.repoKey,branch:scope.branch,taskId:ctx.taskId,explicit:ctx.explicit??false,correction:ctx.correction,environment:ctx.environment}));
    const result=this.transaction(()=>{
      this.drain();
      const prior=this.db.prepare('SELECT signature,receipt FROM curator_receipts WHERE operation_id=?').get(input.operationId) as {signature:string;receipt:string}|undefined;
      if(prior){if(prior.signature!==signature)throw new Error('相同操作身份对应不同记忆决策');return {...JSON.parse(prior.receipt) as CuratorDecisionReceipt,replayed:true};}
      const priorCandidate=this.db.prepare("SELECT signature,receipt FROM curator_receipts WHERE json_extract(receipt,'$.candidateId')=?").get(input.candidateId) as {signature:string;receipt:string}|undefined;
      if(priorCandidate){if(priorCandidate.signature!==signature)throw new Error('同一候选已有不同决策，不得再次提交');return {...JSON.parse(priorCandidate.receipt) as CuratorDecisionReceipt,replayed:true};}
      ctx.assertCurrent?.();
      if(!['delete','discard','history'].includes(input.decision)&&isCuratorPolicyDisabled(this.db,input.policyVersion))throw new Error('该记忆策略已停用，拒绝迟到写入');
      const before=this.rows();
      let record:KnowledgeRecord|undefined;
      let disposition:CuratorDecisionReceipt['disposition']='discarded';
      const cleaned=input.draft?validateCuratorDraft(JSON.parse(redactCredentialShapes(JSON.stringify(input.draft)).text),input.decision==='correct'?'save':input.decision):undefined;
      if(cleaned&&(cleaned.repoKey&&cleaned.repoKey!==scope.repoKey||cleaned.branch&&cleaned.branch!==scope.branch))throw new Error('候选不能修改宿主确定的仓库或分支');
      const environment=ctx.environment??(ctx.correction?before.find(item=>item.id===ctx.correction!.memoryId)?.environment:undefined);
      const draft=cleaned?{...cleaned,environment,repoKey:scope.repoKey,branch:scope.branch,taskId:ctx.taskId}:undefined;
      if(!['discard','delete','restore'].includes(input.decision)&&!draft)throw new Error('draft: 该决策需要kind、summary和applicability等完整结构化记忆字段');
      const sourceQuote=findSourceQuote(ctx.sourceText,input.sourceQuote)?.text??'';
      const retainedEvidence=evidenceForQuote(ctx.evidence,sourceQuote,ctx.userText);
      // A task model's evidence hint is a locator, never proof or user authorization.
      const correctionUserQuote=!!ctx.correction&&!!ctx.userText&&!!sourceQuote&&!!findSourceQuote(ctx.userText,sourceQuote)
        &&sourceQuote.split(/[，,。.!！?？;；\n]/).some(clause=>authorizesUserAction(ctx.userText!,clause,/(?:更正|纠正|改为|改成|应改|换成|换为|变成|更新为|错了|错误|\b(?:correct|correction|change|wrong|instead)\b)/i));
      const correctionOrigin=ctx.correction&&draft&&['user_preference','user_profile','stable_constraint'].includes(draft.kind)&&correctionUserQuote?'user':ctx.origin;
      const checkDeletions=(candidate:Parameters<typeof sameKnowledge>[0],restoringId?:string)=>{
        const deleted=this.deletedKnowledge(scope),checked=new Set(input.reviewedDeletionIds??[]);
        if(!Array.isArray(input.reviewedDeletionIds??[])||(input.reviewedDeletionIds??[]).some(id=>typeof id!=='string')
          ||deleted.some(item=>!checked.has(item.id))||[...checked].some(id=>!deleted.some(item=>item.id===id)))throw new Error('删除记录已变化或尚未比较，请重新检索后提交');
        const comparisons=input.deletionComparisons??[];
        if(!Array.isArray(comparisons)||comparisons.some(item=>!item||typeof item.id!=='string'||typeof item.equivalent!=='boolean')
          ||new Set(comparisons.map(item=>item.id)).size!==comparisons.length||comparisons.length!==deleted.length
          ||deleted.some(item=>!comparisons.some(comparison=>comparison.id===item.id)))throw new Error('必须明确比较全部删除记录的含义和适用条件');
        if(comparisons.some(item=>item.equivalent&&item.id!==restoringId))throw new Error('该同义知识已被用户删除，不会自动复活');
        if(deleted.some(item=>item.id!==restoringId&&sameKnowledge(item,candidate)))throw new Error('该知识已被用户删除，不会自动复活');
      };
      if(!['discard','history','delete','restore'].includes(input.decision)){
        const minimum=draft!.kind==='reusable_lesson'?12:3;
        if(sourceQuote.trim().length<minimum||sourceQuote.length>6000)throw new Error(`sourceQuote: 记忆依据不能在宿主原始事件中定位；需要至少${minimum}字符的连续原文，仅容忍等价空白、换行和引号`);
        if(['user_preference','stable_constraint'].includes(draft!.kind)&&ctx.userText!=null&&!findSourceQuote(ctx.userText,sourceQuote))throw new Error('sourceQuote: 用户偏好与持续约束必须直接来自原始用户输入');
        if(draft!.kind==='user_profile')validateProfileSource(ctx.userText,sourceQuote,draft!,input.decision!=='suspend');
        const assessment=assessKnowledge(draft!,ctx.evidence,correctionOrigin);
        if(!assessment.eligible)throw new Error(assessment.reason);
        checkDeletions(draft!);
      }
      const hostContext:KnowledgeWriteContext={namespace:ctx.namespace,origin:ctx.origin,evidence:retainedEvidence,explicit:ctx.explicit,now};
      const submit=()=>{const previous=this.curatorAdmission,previousReason=this.curatorReason;this.curatorAdmission=true;this.curatorReason=input.reason;
        try{return this.submit(draft!,hostContext);}finally{this.curatorAdmission=previous;this.curatorReason=previousReason;}};
      const target=()=>{
        const found=this.rows().find(item=>item.id===input.targetId);
        if(!found||found.revision!==input.targetRevision)throw new Error('对照记忆已变化，请重新检索');
        if(found.namespace!==ctx.namespace||found.repoKey!==scope.repoKey||found.branch!==scope.branch||found.kind!==draft!.kind)throw new Error('不能跨范围或类型更新记忆');
        if(!['active','pending','needs_revalidation'].includes(found.status)||this.deletedById(found.id))throw new Error('对照记忆已退场或被删除');
        if(found.userManaged)throw new Error('该版本已由用户确认，请在记忆中心修改');
        if(!this.policyAllows(found))throw new Error('对照记忆受已停用策略影响，不能通过关联依据重新启用');
        if(!this.sameBoundary(found,draft!))throw new Error('适用条件或例外不同，不能合并或暂停整个旧结论');
        return found;
      };
      let proposedCorrection:CuratorDecisionReceipt['proposedCorrection'];
      if(ctx.correction&&input.decision!=='discard'){
        const old=this.rows().find(item=>item.id===ctx.correction!.memoryId);
        if(!old||old.revision!==ctx.correction.revision)throw new Error('纠错目标记忆已变化，请重新读取当前版本后提交');
        if(old.namespace!==scope.namespace||old.repoKey!==scope.repoKey||old.branch!==scope.branch||old.kind!==draft!.kind)throw new Error('不能跨范围或类型更正记忆');
        if(!['active','pending','needs_revalidation'].includes(old.status)||this.deletedById(old.id))throw new Error('纠错目标已退场或被删除');
        const located=ctx.evidence.some(item=>hostObservedEvidence(item,sourceQuote)
          ||item.observation==='user_input'&&item.verification==='user_confirmed'&&!!ctx.userText&&!!findSourceQuote(ctx.userText,sourceQuote));
        if(!located&&!(correctionUserQuote&&['user_preference','user_profile','stable_constraint'].includes(old.kind)))throw new Error('纠错缺少宿主可核对的原始反证；候选问题与依据线索不能作为证明');
        if(old.userManaged){
          record=old;disposition='needs_user';proposedCorrection={decision:input.decision as 'correct'|'suspend',draft:draft!};
        }else{
          if(!this.policyAllows(old))throw new Error('纠错目标受已停用策略影响，请先完成补偿');
          if(old.origin==='user'&&['user_preference','user_profile','stable_constraint'].includes(old.kind)&&correctionOrigin!=='user')throw new Error('助手经验不能更改用户明确要求');
          if(input.decision==='suspend'&&!this.sameBoundary(old,draft!))throw new Error('暂停须针对原条目的完整条件；缩窄条件请使用correct');
          if(input.decision==='correct'&&before.some(item=>item.id!==old.id&&item.namespace===old.namespace&&sameKnowledge(item,draft!)))throw new Error('更正内容与其他条目重复，请拒绝本请求并说明对照条目');
          record={...old,...(input.decision==='correct'?draft:{}),userManaged:false,
            origin:correctionOrigin,revision:old.revision+1,status:input.decision==='suspend'?'needs_revalidation':'active',updatedAt:now,decisionReason:input.reason,
            evidence:mergeEvidence(old.evidence,retainedEvidence),history:[...old.history,{revision:old.revision,summary:old.summary,status:old.status,at:old.updatedAt}].slice(-32)};
          this.persist(record,input.decision==='correct'?'auto_corrected':'conflict_suspended');
          disposition=input.decision==='correct'?'updated':'suspended';
        }
      }else if(input.decision==='delete'){
        const userText=ctx.userText??ctx.sourceText;
        const userQuote=findSourceQuote(userText,input.sourceQuote)?.text??'';
        if(ctx.origin!=='user'||userQuote.trim().length<3||userQuote.length>6000||!sourceQuote
          ||!authorizesUserAction(userText,userQuote,/(?:删除|删掉|删去|忘掉|忘记|停止使用|不再使用|不要再用|\b(?:forget|delete|remove)\b)/i))throw new Error('sourceQuote: 只有用户原文明确要求删除时才能执行');
        const old=this.rows().find(item=>item.id===input.targetId);
        if(!old||old.revision!==input.targetRevision)throw new Error('记忆已变化，请重新读取后删除');
        if(old.namespace!==scope.namespace||old.repoKey!==scope.repoKey||old.branch!==scope.branch)throw new Error('不能跨范围删除记忆');
        record=this.deleteKnowledge(old.id,old.revision);disposition='rejected';
      }else if(input.decision==='restore'){
        const userText=ctx.userText??ctx.sourceText;
        const userQuote=findSourceQuote(userText,input.sourceQuote)?.text??'';
        if(ctx.origin!=='user'||userQuote.trim().length<3||userQuote.length>6000||!sourceQuote
          ||!authorizesUserAction(userText,userQuote,/(?:恢复|重新保存|重新启用|再次保存|取消删除|撤销删除|\b(?:restore|reinstate|re-enable)\b)/i))throw new Error('sourceQuote: 只有用户原文明确要求恢复时才能执行');
        if(input.draft)throw new Error('恢复仅使用原条目正文；修改请另外提交有据候选');
        const old=this.rows().find(item=>item.id===input.targetId),deleted=old&&this.deletedById(old.id);
        if(!old||old.revision!==input.targetRevision||!deleted)throw new Error('被删除记忆已变化，请重新读取后恢复');
        if(!this.policyAllows(old))throw new Error('该记忆受已停用策略影响，需先完成系统补偿，不能直接恢复');
        if(old.namespace!==scope.namespace||old.repoKey!==scope.repoKey||old.branch!==scope.branch)throw new Error('不能跨范围恢复记忆');
        if(old.kind==='task_fact'||old.kind!==deleted.kind)throw new Error('任务历史不能借恢复标签晋升为长期知识');
        const assessment=assessKnowledge(old,old.evidence,old.origin);
        if(!assessment.eligible)throw new Error(assessment.reason);
        checkDeletions(old,old.id);
        const evidence=mergeEvidence(old.evidence,retainedEvidence);
        this.db.prepare('DELETE FROM knowledge_deleted WHERE id=?').run(old.id);
        const pending:KnowledgeRecord={...old,revision:old.revision+1,status:'pending',updatedAt:now,decisionReason:input.reason,
          evidence,history:[...old.history,{revision:old.revision,summary:old.summary,status:old.status,at:old.updatedAt}].slice(-32)};
        this.persist(pending,'restore_requested');
        record={...pending,revision:pending.revision+1,status:'active',
          history:[...pending.history,{revision:pending.revision,summary:pending.summary,status:pending.status,at:pending.updatedAt}].slice(-32)};
        this.persist(record,'user_restored');disposition='active';
      }else if(input.decision==='history'){
        if(ctx.namespace==='profile')disposition='rejected';
        else{const outcome=this.submit({...draft!,kind:'task_fact'},hostContext);record=outcome.record;disposition=outcome.disposition==='rejected'?'rejected':'retained_ephemeral';}
      }else if(input.decision==='save'){
        if(input.targetId)target();
        const exact=before.find(item=>item.namespace===ctx.namespace&&item.status!=='superseded'&&sameKnowledge(item,draft!));
        if(exact&&!this.policyAllows(exact))throw new Error('已有记忆受已停用策略影响，需先完成系统补偿');
        if(exact&&(exact.id!==input.targetId||exact.revision!==input.targetRevision))throw new Error('已有相同记忆，请提交其当前ID和版本后保存');
        if(exact?.userManaged)throw new Error('该版本已由用户确认，请在记忆中心修改');
        const outcome=submit();record=outcome.record;
        disposition=outcome.disposition==='proposed'?'rejected':outcome.disposition;
        if(record?.status==='pending'||record?.status==='needs_revalidation'&&ctx.evidence.some(item=>item.verification!=='unverified'||hostObservedEvidence(item,sourceQuote))){
          record={...record,status:'active',revision:record.revision+1,updatedAt:now,decisionReason:input.reason,
            history:[...record.history,{revision:record.revision,summary:record.summary,status:record.status,at:record.updatedAt}].slice(-32)};
          this.persist(record,'auto_admitted');disposition='active';
        }
      }else if(input.decision==='duplicate'){
        const old=target(),evidence=mergeEvidence(old.evidence,retainedEvidence);
        const searchKeys=[...new Set([...(draft?.searchKeys??[]),...(old.searchKeys??[])])].slice(0,12);
        if(old.status!=='active')throw new Error('对照条目尚未生效；请用save核对后自动准入，不能把待处理候选当作已生效知识去重');
        record=old;
        if(JSON.stringify(evidence)!==JSON.stringify(old.evidence)||JSON.stringify(searchKeys)!==JSON.stringify(old.searchKeys??[])){record={...old,evidence,searchKeys,revision:old.revision+1,updatedAt:now,decisionReason:input.reason};this.persist(record,'evidence_linked');}
        disposition='duplicate';
      }else if(input.decision==='suspend'||input.decision==='supersede'){
        const old=target();
        if(!ctx.evidence.some(item=>item.verification!=='unverified'||hostObservedEvidence(item,sourceQuote)))throw new Error('缺少宿主可核对的反证，不能暂停旧知识');
        if(old.origin==='user'&&['user_preference','user_profile','stable_constraint'].includes(old.kind)&&ctx.origin!=='user')throw new Error('助手经验不能修改用户明确要求');
        if(input.decision==='supersede'){
          const outcome=submit();record=outcome.record;
          if(record?.userManaged)throw new Error('该版本已由用户确认，请在记忆中心修改');
          if(!record||!['active','pending'].includes(record.status)||record.id===old.id)throw new Error('替代知识未通过准入或与旧条目相同');
          const current=this.rows().find(item=>item.id===record!.id)!;
          record={...current,status:'active',revision:current.revision+1,updatedAt:now,supersedes:old.id,decisionReason:input.reason,
            relations:[...(current.relations??[]),{targetId:old.id,targetRevision:old.revision,kind:'supersedes',inferred:true}]};
          this.persist(record,'auto_superseded_source');
        }
        const retired:KnowledgeRecord={...old,status:input.decision==='suspend'?'needs_revalidation':'superseded',revision:old.revision+1,updatedAt:now,decisionReason:input.reason,evidence:mergeEvidence(old.evidence,retainedEvidence),
          history:[...old.history,{revision:old.revision,summary:old.summary,status:old.status,at:old.updatedAt}].slice(-32)};
        this.persist(retired,input.decision==='suspend'?'conflict_suspended':'auto_superseded_target');
        if(input.decision==='suspend')record=retired;
        disposition=input.decision==='suspend'?'suspended':'superseded';
      }
      ctx.assertCurrent?.();
      const oldPayloads=new Map(before.map(item=>[item.id,JSON.stringify(item)]));
      const after=this.rows().filter(item=>oldPayloads.get(item.id)!==JSON.stringify(item));
      const receipt:CuratorDecisionReceipt={operationId:input.operationId,candidateId:input.candidateId,policyVersion:input.policyVersion,decision:input.decision,
        disposition,record,affected:after.map(item=>({id:item.id,revision:item.revision})),reason:input.reason,at:now,
        ...(ctx.correction?{targetId:ctx.correction.memoryId,targetRevision:ctx.correction.revision,proposedCorrection}: {})};
      this.db.prepare('INSERT INTO curator_receipts VALUES(?,?,?,?,?)').run(input.operationId,signature,JSON.stringify(receipt),
        JSON.stringify(before.filter(item=>after.some(next=>next.id===item.id))),JSON.stringify(after));
      return receipt;
    });this.transaction(()=>this.drain());return result;
  }
  /** User action, separate from automatic archival. A tombstone survives index rebuilding and retries. */
  deleteKnowledge(id:string,revision:number):KnowledgeRecord {
    const result=this.transaction(()=>{
      this.drain();const source=this.rows().find(record=>record.id===id);
      if(!source||source.revision!==revision)throw new Error('记忆已变化，请刷新后删除');
      const now=Date.now();let deleted:KnowledgeRecord|undefined;
      for(const old of this.rows().filter(record=>record.namespace===source.namespace&&sameKnowledge(record,source))){
        const updated:KnowledgeRecord={...old,status:'rejected',revision:old.revision+1,updatedAt:now,decisionReason:'用户删除：停止使用并阻止同义内容自动复活',
          history:[...old.history,{revision:old.revision,summary:old.summary,status:old.status,at:old.updatedAt}].slice(-32)};
        this.rememberDeletion(old,updated.revision,now);this.persist(updated,'user_deleted');if(old.id===id)deleted=updated;
      }
      return deleted!;
    });this.transaction(()=>this.drain());return result;
  }
  private drain():void {
    // Nested curator operations share one commit; never project uncommitted payloads.
    if(this.transactionDepth>1)return;
    const rows=this.db.prepare('SELECT id,payload,old_hash FROM outbox').all() as Array<{id:string;payload:string;old_hash:string}>;
    for (const row of rows) {
      if(this.isLedgerOnly(row.id)){this.db.prepare('DELETE FROM outbox WHERE id=?').run(row.id);continue;}
      const fresh=this.readFile(row.id);
      const desired=encodeKnowledge(JSON.parse(row.payload) as KnowledgeRecord);
      if (fresh !== desired) {
        if (digest(fresh) !== row.old_hash) throw new Error(`记忆写入冲突：${row.id}`);
        writeTextAtomicSync(this.file(row.id),desired);
      }
      this.db.prepare('DELETE FROM outbox WHERE id=?').run(row.id);
    }
  }
  private rows():KnowledgeRecord[] {
    return (this.db.prepare('SELECT payload FROM records ORDER BY id').all() as Array<{payload:string}>).map(r=>JSON.parse(r.payload) as KnowledgeRecord);
  }
  /**
   * Read a bounded page directly from SQLite. The knowledge-center IPC merges
   * the per-namespace pages, so large stores do not have to materialize every
   * payload before applying the caller's filters.
   */
  listPage(input:{after?:{updatedAt:number;id:string};limit:number;namespace?:KnowledgeNamespace;updatedAfter?:number;updatedBefore?:number}):{records:KnowledgeRecord[];totalCount:number} {
    this.transaction(()=>this.drain());
    const filters:string[]=[];const filterParams:Array<string|number|null>=[];
    if(input.namespace){filters.push('h.namespace=?');filterParams.push(input.namespace);}
    if(input.updatedAfter!==undefined){filters.push('h.updated_at>?');filterParams.push(input.updatedAfter);}
    if(input.updatedBefore!==undefined){filters.push('h.updated_at<=?');filterParams.push(input.updatedBefore);}
    const where=[...filters],params=[...filterParams];
    if(input.after){
      // Keep the keyset predicate explicit so the cursor never turns into an
      // offset scan as the ledger grows.
      where.push('(h.updated_at<? OR (h.updated_at=? AND h.id<?))');
      params.push(input.after.updatedAt,input.after.updatedAt,input.after.id);
    }
    const filterPredicate=filters.length?` WHERE ${filters.join(' AND ')}`:'';
    const total=Number((this.db.prepare(`SELECT COUNT(*) AS n FROM knowledge_hot h${filterPredicate}`).get(...filterParams) as {n:number}).n);
    const predicate=where.length?` WHERE ${where.join(' AND ')}`:'';
    const rows=this.db.prepare(`SELECT r.payload FROM knowledge_hot h JOIN records r ON r.id=h.id${predicate} ORDER BY h.updated_at DESC,h.id ASC LIMIT ?`).all(...params,input.limit) as Array<{payload:string}>;
    return {records:rows.map(row=>JSON.parse(row.payload) as KnowledgeRecord),totalCount:total};
  }
  /** Metadata-only snapshot used by bounded IPC reads. */
  summary():Omit<KnowledgeSnapshot,'records'> & {records:[]} {
    this.transaction(()=>this.drain());
    const integrityIssues=this.integrityIssues();
    const rows=this.db.prepare('SELECT id,payload FROM records ORDER BY id').all() as Array<{id:string;payload:string}>;
    const policySuppressedIds:string[]=[];let pending=0,active=0,history=0;
    for(const row of rows){
      const record=JSON.parse(row.payload) as KnowledgeRecord;
      if(record.status==='pending')pending++;
      if(record.kind==='task_fact')history++;
      if(!this.policyAllows(record))policySuppressedIds.push(record.id);
      else if(record.status==='active'&&record.kind!=='task_fact')active++;
    }
    return {records:[],integrityIssues,pending,
      policySuppressedIds,active,history,startedAt:this.startedAt,
      governance:(this.db.prepare('SELECT receipt FROM governance ORDER BY rowid DESC LIMIT 50').all() as Array<{receipt:string}>).map(r=>JSON.parse(r.receipt))};
  }
  private persist(record:KnowledgeRecord,kind:string):void {
    const prior=this.db.prepare('SELECT payload FROM records WHERE id=?').get(record.id) as {payload:string}|undefined;
    const fresh=this.readFile(record.id);
    if (prior&&!this.isLedgerOnly(record.id)&&fresh !== encodeKnowledge(JSON.parse(prior.payload) as KnowledgeRecord)) {
      const pending=this.db.prepare('SELECT payload,old_hash FROM outbox WHERE id=?').get(record.id) as {payload:string;old_hash:string}|undefined;
      if(!pending||pending.payload!==prior.payload||pending.old_hash!==digest(fresh)){
        this.projectionIssues.set(record.id,fs.existsSync(this.file(record.id))?'modified':'missing');
        throw new Error(`记忆资产缺失或已被外部修改：${record.id}`);
      }
    }
    if(record.status==='active'&&this.deletedById(record.id))throw new Error('该记忆已被用户删除，必须显式恢复后才能使用');
    const payload=JSON.stringify(record);
    if(prior) {
      const previous=JSON.parse(prior.payload) as KnowledgeRecord;
      this.db.prepare('INSERT OR IGNORE INTO versions VALUES(?,?,?)').run(record.id,previous.revision,prior.payload);
    }
    this.db.prepare('INSERT OR REPLACE INTO records VALUES(?,?)').run(record.id,payload);
    this.index(record);
    if(!prior&&record.kind==='task_fact')this.db.prepare("INSERT OR REPLACE INTO record_storage(id,mode) VALUES(?,'ledger-only')").run(record.id);
    if(this.isLedgerOnly(record.id))this.db.prepare('DELETE FROM outbox WHERE id=?').run(record.id);
    else this.db.prepare('INSERT OR REPLACE INTO outbox VALUES(?,?,?)').run(record.id,payload,digest(fresh));
    this.db.prepare('INSERT INTO events(record_id,kind,at,detail) VALUES(?,?,?,?)').run(record.id,kind,record.updatedAt,record.decisionReason);
  }
  private index(record:KnowledgeRecord):void {
    this.db.prepare(`INSERT OR REPLACE INTO knowledge_hot
      (id,namespace,kind,status,updated_at,created_at,expires_at,repo_key,branch,task_id)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(record.id,record.namespace,record.kind,record.status,
      record.updatedAt,record.createdAt,record.expiresAt??null,record.repoKey??null,record.branch??null,record.taskId??null);
    const body=knowledgeFtsText(record),contentHash=digest(body);
    const indexed=this.db.prepare(`SELECT m.revision,m.content_hash,f.body
      FROM knowledge_fts_meta m LEFT JOIN knowledge_fts f ON f.id=m.id WHERE m.id=?`).get(record.id) as
      {revision:number;content_hash:string;body:string|null}|undefined;
    if(!(indexed?.revision===record.revision&&indexed.content_hash===contentHash&&indexed.body===body)) {
      this.db.prepare('DELETE FROM knowledge_fts WHERE id=?').run(record.id);
      this.db.prepare('INSERT INTO knowledge_fts(id,body) VALUES(?,?)').run(record.id,body);
      this.db.prepare('INSERT OR REPLACE INTO knowledge_fts_meta(id,revision,content_hash) VALUES(?,?,?)').run(record.id,record.revision,contentHash);
    }
    this.db.prepare('DELETE FROM relations WHERE source_id=?').run(record.id);
    for(const relation of record.relations??[]) this.db.prepare('INSERT OR IGNORE INTO relations VALUES(?,?,?,?)')
      .run(record.id,relation.targetId,relation.kind,relation.inferred?1:0);
  }
  list():KnowledgeSnapshot {
    this.transaction(()=>this.drain());
    const integrityIssues=this.integrityIssues();
    const records=this.rows(),policySuppressedIds=records.filter(record=>!this.policyAllows(record)).map(record=>record.id);
    return {records,integrityIssues,pending:records.filter(r=>r.status==='pending').length,
      policySuppressedIds,active:records.filter(r=>r.status==='active'&&r.kind!=='task_fact'&&!policySuppressedIds.includes(r.id)).length,
      history:records.filter(r=>r.kind==='task_fact').length,startedAt:this.startedAt,
      governance:(this.db.prepare('SELECT receipt FROM governance ORDER BY rowid DESC LIMIT 50').all() as Array<{receipt:string}>).map(r=>JSON.parse(r.receipt))};
  }
  references(text:string,namespace:KnowledgeNamespace,repoKey?:string,branch?:string):KnowledgeRecord[] {
    const match=ftsMatchExprAny(text.slice(-3000).toLowerCase());if(!match) return [];
    const rows=this.db.prepare(`SELECT r.payload FROM knowledge_fts JOIN records r ON r.id=knowledge_fts.id
      WHERE knowledge_fts MATCH ? AND json_extract(r.payload,'$.namespace')=? AND json_extract(r.payload,'$.kind')!='task_fact'
      AND (json_extract(r.payload,'$.repoKey') IS NULL OR json_extract(r.payload,'$.repoKey')=?)
      AND (json_extract(r.payload,'$.branch') IS NULL OR json_extract(r.payload,'$.branch')=?) ORDER BY bm25(knowledge_fts) LIMIT 24`)
      .all(match,namespace,knowledgeRepoKey(repoKey)??null,branch??null) as Array<{payload:string}>;
    return rows.map(row=>JSON.parse(row.payload) as KnowledgeRecord);
  }
  submit(raw:unknown,ctx:KnowledgeWriteContext):KnowledgeWriteResult {
    const cleaned=JSON.parse(redactCredentialShapes(JSON.stringify(raw)).text) as unknown;
    let draft=validateKnowledgeDraft(cleaned);
    const now=ctx.now??Date.now();
    validateEvidence(ctx.evidence);
    if (!Number.isFinite(now) || !['user','worker','scheduler','untrusted','system'].includes(ctx.origin)) throw new Error('非法宿主来源');
    if (!['worker','scheduler','profile','host'].includes(ctx.namespace)) throw new Error('非法记忆范围');
    if (ctx.namespace==='profile' && !['user_preference','user_profile'].includes(draft.kind)) throw new Error('用户画像范围仅允许用户信息和偏好');
    if (draft.kind==='user_profile' && ctx.namespace!=='profile') throw new Error('用户信息必须保存在全局画像范围');
    if (ctx.namespace==='host' && (draft.kind!=='reusable_lesson'||ctx.origin!=='user'||!ctx.explicit||draft.repoKey||draft.branch)) throw new Error('工作台通用经验只能由用户明确提交，且不能绑定仓库或分支');
    const assessment=assessKnowledge(draft,ctx.evidence,ctx.origin);
    const history=draft.kind==='task_fact'||!assessment.eligible;
    if ((ctx.namespace==='profile'||ctx.namespace==='host')&&history) return {disposition:'rejected',reason:assessment.reason};
    if (history) draft={...draft,kind:'task_fact',expiresAt:draft.expiresAt??now+90*24*3600000};
    const result=this.transaction(()=> {
      this.drain();
      if(ctx.derivedFrom){
        const rows=this.rows(),sources=ctx.derivedFrom.map(s=>rows.find(r=>r.id===s.id&&r.revision===s.revision));
        if(history||draft.kind!=='reusable_lesson'||ctx.explicit||new Set(ctx.derivedFrom.map(s=>s.id)).size<2||sources.some(r=>!r||r.kind!=='reusable_lesson'||r.namespace!==ctx.namespace||r.repoKey!==draft.repoKey||r.branch!==draft.branch||!['active','pending'].includes(r.status))) throw new Error('归纳来源已变化或不在同一范围');
      }
      if(ctx.eventClaim) {
        const claim=this.db.prepare("SELECT claim FROM source_events WHERE id=? AND state='running'").get(ctx.eventClaim.id) as {claim:string}|undefined;
        if(claim?.claim!==ctx.eventClaim.token) throw new Error('事件处理租约已失效');
      }
      const rows=this.rows();
      if(this.deletedKnowledge({namespace:ctx.namespace,repoKey:draft.repoKey,branch:draft.branch}).some(item=>sameKnowledge(item,draft)))return {disposition:'rejected',reason:'该知识已被用户删除，不会重新收录'} as KnowledgeWriteResult;
      const decisions=this.db.prepare('SELECT receipt,before_json,after_json FROM governance ORDER BY rowid DESC').all() as Array<{receipt:string;before_json:string;after_json:string}>;
      let redirected:KnowledgeRecord|undefined;
      for(const decision of decisions){
        const receipt=JSON.parse(decision.receipt) as KnowledgeGovernanceReceipt;
        if(receipt.undone||receipt.action==='distinct')continue;
        const original=(JSON.parse(decision.before_json) as KnowledgeRecord[])[0];
        const applied=JSON.parse(decision.after_json) as KnowledgeRecord[];
        const current=rows.find(r=>r.id===original.id);
        if(original.namespace!==ctx.namespace||!sameKnowledge(original,draft)||current?.kind!==applied[0].kind||current?.status!==applied[0].status)continue;
        if(receipt.action==='history')return {disposition:'rejected',record:current,reason:'用户已选择仅留历史，不再重复提案'} as KnowledgeWriteResult;
        redirected=rows.find(r=>r.id===applied[1]?.id);
        if(!redirected||!sameKnowledge(redirected,applied[1])||!['pending','active','needs_revalidation'].includes(redirected.status))return {disposition:'rejected',record:current,reason:'原合并目标已修订或退场，需要重新核对，不自动转移依据'} as KnowledgeWriteResult;
        break;
      }
      const existing=redirected??rows.find(r=>r.namespace===ctx.namespace && r.status!=='superseded' && sameKnowledge(r,draft));
      if (existing) {
        if(existing.userManaged)return {disposition:'duplicate',record:existing,reason:'用户已确认此版本，自动候选不更改内容或状态'} as KnowledgeWriteResult;
        // Rejected/archived records stay retired; new evidence never rearms them implicitly.
        if (existing.status==='rejected'||(existing.status==='archived'&&existing.kind!=='task_fact')) return {disposition:'rejected',record:existing,reason:'该记忆已被用户退场，不会再次提案'} as KnowledgeWriteResult;
        const ids=new Set(existing.evidence.map(e=>e.id));
        for(const incoming of ctx.evidence){const previous=existing.evidence.find(e=>e.id===incoming.id);if(previous&&JSON.stringify(previous)!==JSON.stringify(incoming))throw new Error('相同证据身份对应不同来源');}
        const additional=ctx.evidence.filter(e=>!ids.has(e.id));
        const searchKeys=[...new Set([...(draft.searchKeys??[]),...(existing.searchKeys??[])])].slice(0,12);
        if (additional.length||JSON.stringify(searchKeys)!==JSON.stringify(existing.searchKeys??[])) {
          if(existing.evidence.length+additional.length>32)throw new Error('关联后超过32条证据上限，不会截断已有依据');
          const updated={...existing,searchKeys,evidence:[...existing.evidence,...additional],revision:existing.revision+1,updatedAt:now};
          this.persist(updated,'evidence_linked');
          return {disposition:'duplicate',record:updated,reason:'已有相同知识，仅关联新增证据'} as KnowledgeWriteResult;
        }
        return {disposition:'duplicate',record:existing,reason:'相同事件和内容已记录'} as KnowledgeWriteResult;
      }
      const status=history?'archived':this.curatorAdmission||ctx.explicit&&ctx.origin==='user'?'active':'pending';
      const record:KnowledgeRecord={...draft,kind:history?'task_fact':draft.kind,schema:1,id:randomUUID(),revision:1,
        namespace:ctx.namespace,status,origin:ctx.origin,...(ctx.namespace==='host'?{userManaged:true}:{}),evidence:[...ctx.evidence],createdAt:now,updatedAt:now,
        decisionReason:history?assessment.reason:this.curatorAdmission?this.curatorReason??assessment.reason:ctx.explicit?'用户明确要求保存':assessment.reason,history:[]};
      if(ctx.derivedFrom){record.relations=ctx.derivedFrom.map(s=>({targetId:s.id,targetRevision:s.revision,kind:'derived_from',inferred:true}));record.decisionReason='基于独立事件归纳，等待核对条件；来源未被自动取代';}
      if (ctx.namespace==='profile'&&history) return {disposition:'rejected',reason:assessment.reason} as KnowledgeWriteResult;
      this.persist(record,history?'history_saved':status==='active'?this.curatorAdmission?'auto_admitted':'remembered':'proposed');
      return {disposition:history?'retained_ephemeral':status==='active'?'active':'proposed',record,reason:record.decisionReason} as KnowledgeWriteResult;
    });
    this.transaction(()=>this.drain());
    return result;
  }
  decide(id:string,revision:number,decision:'approve'|'reject'|'archive'|'revalidate'):KnowledgeRecord {
    const result=this.transaction(()=> {
      this.drain();
      const old=this.rows().find(r=>r.id===id);
      if (!old||old.revision!==revision) throw new Error('记忆已变化，请刷新后操作');
      if (decision==='approve'&&(old.status!=='pending'||!assessKnowledge(old,old.evidence,old.origin).eligible)) throw new Error('该内容不具备长期记忆准入条件');
      if (decision==='reject'&&old.status!=='pending') throw new Error('仅待审记忆可驳回');
      if ((decision==='archive'||decision==='revalidate') && !['active','needs_revalidation'].includes(old.status)) throw new Error('仅生效知识可退场或标记复核');
      const status=decision==='approve'?'active':decision==='reject'?'rejected':decision==='archive'?'archived':'needs_revalidation';
      const updated:KnowledgeRecord={...old,revision:old.revision+1,status,updatedAt:Date.now(),decisionReason:`用户操作：${decision}`,
        history:[...old.history,{revision:old.revision,summary:old.summary,status:old.status,at:old.updatedAt}].slice(-32)};
      if(decision==='archive'||decision==='reject')this.rememberDeletion(old,updated.revision,updated.updatedAt);
      this.persist(updated,decision);
      return updated;
    });
    this.transaction(()=>this.drain());
    return result;
  }
  search(input:KnowledgeQuery):KnowledgeHit[] {
    input={...input,repoKey:knowledgeRepoKey(input.repoKey)};
    const query=knowledgeIdentity(input.query??'');
    if (!query) return [];
    const now=input.now??Date.now(), tokens=knowledgeTokens(query);
    const hits:KnowledgeHit[]=[];
    const match=ftsMatchExprAny(query.toLowerCase());
    if(!match) return [];
    // Indexed scope terms reduce candidates; SQL below remains the authorization gate.
    const scopedMatch=`(${match}) AND ${scopeTerm('namespace',input.namespace??'worker')} AND (${scopeTerm('repo',undefined)} OR ${scopeTerm('repo',input.repoKey)})`;
    this.transaction(()=>this.drain());
    // Permission and scope filters happen before candidate limits, not after Top-K.
    const candidates=this.db.prepare(`SELECT r.payload,bm25(knowledge_fts) lexical FROM knowledge_fts
      JOIN records r ON r.id=knowledge_fts.id WHERE knowledge_fts MATCH ?
      AND json_extract(r.payload,'$.namespace')=?
      AND (NOT EXISTS(SELECT 1 FROM knowledge_deleted d WHERE d.id=r.id) OR (?='history' AND json_extract(r.payload,'$.kind')='task_fact' AND json_extract(r.payload,'$.status')='archived'))
      AND (json_extract(r.payload,'$.status')='active' OR (?='history' AND json_extract(r.payload,'$.kind')='task_fact' AND json_extract(r.payload,'$.status')='archived'))
      AND (?='history' OR json_extract(r.payload,'$.kind')!='task_fact')
      AND (json_extract(r.payload,'$.repoKey') IS NULL OR json_extract(r.payload,'$.repoKey')=?)
      AND (json_extract(r.payload,'$.expiresAt') IS NULL OR json_extract(r.payload,'$.expiresAt')>?)
      AND (? IS NULL OR json_extract(r.payload,'$.kind')!='task_fact' OR json_extract(r.payload,'$.taskId')=?)
      AND NOT EXISTS(SELECT 1 FROM json_each(r.payload,'$.evidence') e WHERE ?!='[]' AND json_extract(e.value,'$.source') NOT IN(SELECT value FROM json_each(?)))
      ORDER BY lexical LIMIT 80`).all(scopedMatch,input.namespace??'worker',input.mode??'task',input.mode??'task',input.mode??'task',input.repoKey??null,now,
      input.taskId??null,input.taskId??null,JSON.stringify(input.sources??[]),JSON.stringify(input.sources??[])) as Array<{payload:string;lexical:number}>;
    for (const candidate of candidates) {
      const record=JSON.parse(candidate.payload) as KnowledgeRecord;
      if(!this.policyAllows(record))continue;
      if (record.namespace !== (input.namespace??'worker')) continue;
      if (record.status!=='active' && !(input.mode==='history'&&record.kind==='task_fact'&&record.status==='archived')) continue;
      if (record.expiresAt!=null && record.expiresAt<=now) continue;
      if (record.repoKey && record.repoKey!==input.repoKey) continue;
      if (record.kind==='task_fact' && input.mode!=='history') continue;
      if (input.taskId && record.kind==='task_fact' && record.taskId!==input.taskId) continue;
      if (input.sources?.length && record.evidence.some(e=>!input.sources!.includes(e.source))) continue;
      const text=[record.summary,record.problem,record.action,record.rationale,...record.applicability,...(record.searchKeys??[])].join(' ');
      const found=knowledgeTokens(text);
      let overlap=0; for(const token of tokens) if(found.has(token)) overlap++;
      if (!overlap) continue;
      const conditions=new Set(input.conditions??[]);
      const matched=record.applicability.every(c=>conditions.has(c));
      // Unknown conditions remain qualified references, never authoritative instructions.
      const lexical=1/(1+Math.exp(candidate.lexical));
      const score=(overlap/tokens.size+knowledgeSimilarity(query,text)+lexical)*(matched?1:0.7);
      hits.push({record,score,applicability:matched?'matched':'needs_check',reason:matched?'关键词与适用条件匹配':'内容相关；适用条件尚未核实'});
    }
    return hits.sort((a,b)=>b.score-a.score||b.record.updatedAt-a.record.updatedAt).slice(0,Math.max(1,Math.min(input.limit??5,20)));
  }
  /** Desktop user action: durable immediately, independent of curator availability. */
  private userVersion(id:string,revision:number,raw:unknown,status:KnowledgeRecord['status'],event:string):KnowledgeRecord {
    const draft=validateKnowledgeDraft(JSON.parse(redactCredentialShapes(JSON.stringify(raw)).text));
    const result=this.transaction(()=>{
      this.drain();const old=this.rows().find(r=>r.id===id);
      if(!old||old.revision!==revision)throw new Error('记忆已变化，请刷新后操作');
      if(draft.kind!==old.kind)throw new Error('用户修订不能改变记忆类型；任务事实不能晋升为长期知识');
      if(old.namespace==='profile'&&!['user_preference','user_profile'].includes(draft.kind))throw new Error('用户画像范围仅允许用户信息和偏好');
      if(old.namespace==='host'&&(draft.kind!=='reusable_lesson'||draft.repoKey||draft.branch))throw new Error('工作台通用经验不能绑定仓库或分支');
      if(status==='active'&&draft.kind==='task_fact')throw new Error('任务历史不能恢复为有效知识');
      if(status==='active'&&this.rows().some(r=>r.id!==id&&r.namespace===old.namespace&&r.status==='active'&&sameKnowledge(r,draft)))throw new Error('已有相同生效知识，请先处理重复条目');
      if(status==='active'&&this.deletedKnowledge({namespace:old.namespace,repoKey:draft.repoKey,branch:draft.branch}).some(r=>r.id!==id&&sameKnowledge(r,draft)))throw new Error('存在另一条已删除的同义知识，请先核对删除记录');
      const now=Date.now();
      const evidence:KnowledgeEvidence={id:randomUUID(),source:'memory-center-user',eventTime:now,verification:'user_confirmed',observation:'user_input',excerpt:draft.summary};
      const updated:KnowledgeRecord={...old,...draft,userManaged:true,origin:'user',status,revision:old.revision+1,updatedAt:now,
        decisionReason:event==='user_stopped'?'用户停止使用':event==='user_restored'?'用户恢复历史版本':'用户修订并生效',
        evidence:[...old.evidence,evidence].slice(-32),history:[...old.history,{revision:old.revision,summary:old.summary,status:old.status,at:old.updatedAt}].slice(-32)};
      if(status==='rejected')this.rememberDeletion(updated,updated.revision,now);
      else this.db.prepare('DELETE FROM knowledge_deleted WHERE id=?').run(id);
      this.persist(updated,status==='active'||event==='user_stopped'?event:`${event}_inactive`);return updated;
    });
    this.transaction(()=>this.drain());return result;
  }
  revise(id:string,revision:number,raw:unknown):KnowledgeRecord {
    const old=this.rows().find(r=>r.id===id);
    if(!old||old.revision!==revision)throw new Error('记忆已变化，请刷新后操作');
    return this.userVersion(id,revision,raw,old.kind==='task_fact'?'archived':'active','user_revised');
  }
  /** Confirm this exact active version without replacing its earlier evidence. */
  confirm(id:string,revision:number,sourceText:string):KnowledgeRecord {
    const source=redactCredentialShapes(sourceText).text.trim();
    if(!source||source.length>2000)throw new Error('确认依据需为1到2000字符');
    const result=this.transaction(()=>{
      this.drain();const old=this.rows().find(r=>r.id===id);
      if(!old||old.revision!==revision)throw new Error('记忆已变化，请刷新后确认');
      if(old.status!=='active'||old.kind==='task_fact'||this.deletedById(id)||!this.policyAllows(old))throw new Error('只能确认当前生效且可用的长期记忆');
      if(old.evidence.length>=32)throw new Error('证据已达32条上限，请先核对已有依据');
      const now=Date.now();
      const evidence:KnowledgeEvidence={id:randomUUID(),source:'memory-user-confirmation',eventTime:now,verification:'user_confirmed',observation:'user_input',excerpt:source};
      const updated:KnowledgeRecord={...old,userManaged:true,revision:old.revision+1,updatedAt:now,decisionReason:'用户确认当前版本',
        evidence:[...old.evidence,evidence],history:[...old.history,{revision:old.revision,summary:old.summary,status:old.status,at:old.updatedAt}].slice(-32)};
      this.persist(updated,'user_confirmed');return updated;
    });
    this.transaction(()=>this.drain());return result;
  }
  stopUsing(id:string,revision:number):KnowledgeRecord {
    const old=this.rows().find(r=>r.id===id);
    if(!old||old.revision!==revision||old.kind==='task_fact'||old.status!=='active')throw new Error('仅当前生效知识可以停止使用');
    return this.userVersion(id,revision,old,'needs_revalidation','user_stopped');
  }
  supersede(id:string,revision:number,targetId:string,targetRevision:number):KnowledgeRecord {
    const result=this.transaction(()=>{
      this.drain();const rows=this.rows();const source=rows.find(r=>r.id===id),target=rows.find(r=>r.id===targetId);
      if(!source||!target||source.revision!==revision||target.revision!==targetRevision||source.id===target.id) throw new Error('记忆已变化或取代目标无效');
      if(source.namespace!==target.namespace||source.repoKey!==target.repoKey||source.branch!==target.branch||source.kind!==target.kind||source.kind==='task_fact') throw new Error('不同范围或类型的知识不能互相取代');
      if(!['pending','active'].includes(source.status)||!['active','needs_revalidation'].includes(target.status)) throw new Error('取代操作不适用于当前状态');
      const assessment=assessKnowledge(source,source.evidence,source.origin);if(!assessment.eligible) throw new Error(assessment.reason);
      const now=Date.now();
      const updated:KnowledgeRecord={...source,revision:source.revision+1,status:'active',updatedAt:now,supersedes:target.id,
        relations:[...(source.relations??[]),{targetId:target.id,targetRevision:target.revision,kind:'supersedes',inferred:false}],decisionReason:'用户确认取代旧结论；旧条目退出默认召回',
        history:[...source.history,{revision:source.revision,summary:source.summary,status:source.status,at:source.updatedAt}].slice(-32)};
      const retired:KnowledgeRecord={...target,revision:target.revision+1,status:'superseded',updatedAt:now,decisionReason:`已被 ${source.id} 取代`,
        history:[...target.history,{revision:target.revision,summary:target.summary,status:target.status,at:target.updatedAt}].slice(-32)};
      this.persist(updated,'superseded_source');this.persist(retired,'superseded_target');return updated;
    });this.transaction(()=>this.drain());return result;
  }
  restore(id:string,revision:number,fromRevision:number):KnowledgeRecord {
    const row=this.db.prepare('SELECT payload FROM versions WHERE id=? AND revision=?').get(id,fromRevision) as {payload:string}|undefined;
    if(!row)throw new Error('该历史版本不存在，无法恢复');
    const prior=JSON.parse(row.payload) as KnowledgeRecord;
    return this.userVersion(id,revision,prior,prior.status,'user_restored');
  }
  /** Review decisions and their inverse are atomic across every affected record. */
  govern(input:KnowledgeGovernanceInput):KnowledgeGovernanceReceipt {
    if(!input||!['history','merge','distinct'].includes(input.action)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>500) throw new Error('请填写治理理由（最多500字）');
    const receipt=this.transaction(()=>{
      this.drain();const rows=this.rows(),source=rows.find(r=>r.id===input.id);
      if(!source||source.revision!==input.revision)throw new Error('记忆已变化，请刷新后操作');
      if(source.kind==='task_fact'||!['pending','active','needs_revalidation'].includes(source.status))throw new Error('当前条目不能执行此治理操作');
      const before=[source],now=Date.now();
      const update=(r:KnowledgeRecord,patch:Partial<KnowledgeRecord>):KnowledgeRecord=>({...r,...patch,revision:r.revision+1,updatedAt:now,
        history:[...r.history,{revision:r.revision,summary:r.summary,status:r.status,at:r.updatedAt}].slice(-32)});
      const reason=redactCredentialShapes(input.reason.trim()).text;
      let after:KnowledgeRecord[];
      if(input.action==='history'){
        if(source.namespace==='profile')throw new Error('用户画像不存任务历史，请停止使用该条画像');
        after=[update(source,{kind:'task_fact',status:'archived',expiresAt:now+90*86400000,decisionReason:`仅留历史：${reason}`})];
        this.rememberDeletion(source,after[0].revision,now);
      }else{
        const target=rows.find(r=>r.id===input.targetId);
        if(!target||target.id===source.id||target.revision!==input.targetRevision)throw new Error('对照条目已变化，请刷新后操作');
        if(target.namespace!==source.namespace||target.kind!==source.kind||target.repoKey!==source.repoKey||target.branch!==source.branch)throw new Error('不能跨范围或类型治理');
        if(!['pending','active','needs_revalidation'].includes(target.status))throw new Error('对照条目已退场');
        before.push(target);
        if(input.action==='merge'){
          // A broad conclusion must never inherit evidence from different boundaries.
          const boundaries=(r:KnowledgeRecord)=>JSON.stringify([[...r.applicability].sort(),[...(r.exceptions??[])].sort()]);
          if(boundaries(source)!==boundaries(target))throw new Error('适用条件或例外不同，请保留差异，不能合并证据');
          const evidence=[...new Map([...target.evidence,...source.evidence].map(e=>[e.id,e])).values()];
          if(evidence.length>32)throw new Error('合并后超过32条证据上限，请保留差异；不会静默丢弃依据');
          after=[update(source,{status:'superseded',decisionReason:`证据合并至 ${target.id}：${reason}`}),
            update(target,{evidence,decisionReason:`合并证据，结论与条件保持原样：${reason}`})];
        }else{
          if(sameKnowledge(source,target))throw new Error('两条内容与边界完全相同，请合并证据');
          const assessment=assessKnowledge(source,source.evidence,source.origin);if(!assessment.eligible)throw new Error(assessment.reason);
          after=[update(source,{status:'active',decisionReason:`保留差异（对照 ${target.id}）：${reason}`}),
            update(target,{decisionReason:`已核对差异（对照 ${source.id}）：${reason}`})];
        }
      }
      const result:KnowledgeGovernanceReceipt={id:randomUUID(),recordId:source.id,action:input.action,reason,at:now,undone:false};
      for(const record of after)this.persist(record,`governance_${input.action}`);
      this.db.prepare('INSERT INTO governance VALUES(?,?,?,?)').run(result.id,JSON.stringify(result),JSON.stringify(before),JSON.stringify(after));
      return result;
    });this.transaction(()=>this.drain());return receipt;
  }
  undoGovernance(recordId:string,operationId:string):void {
    this.transaction(()=>{
      this.drain();const row=this.db.prepare('SELECT * FROM governance WHERE id=?').get(operationId) as {receipt:string;before_json:string;after_json:string}|undefined;
      if(!row)throw new Error('治理记录不存在');
      const receipt=JSON.parse(row.receipt) as KnowledgeGovernanceReceipt;
      if(receipt.recordId!==recordId)throw new Error('治理记录不属于此条目');
      if(receipt.undone)return;
      const before=JSON.parse(row.before_json) as KnowledgeRecord[],after=JSON.parse(row.after_json) as KnowledgeRecord[],rows=this.rows();
      if(after.some(expected=>rows.find(r=>r.id===expected.id)?.revision!==expected.revision))throw new Error('治理后内容已变化，不能撤销覆盖后续修改');
      for(const old of before){const current=after.find(r=>r.id===old.id)!;
        if(receipt.action==='history')this.db.prepare('DELETE FROM knowledge_deleted WHERE id=?').run(old.id);
        this.persist({...old,revision:current.revision+1,updatedAt:Date.now(),decisionReason:`撤销治理：${receipt.reason}`,
          history:[...current.history,{revision:current.revision,summary:current.summary,status:current.status,at:current.updatedAt}].slice(-32)},'governance_undone');
      }
      this.db.prepare('UPDATE governance SET receipt=? WHERE id=?').run(JSON.stringify({...receipt,undone:true}),operationId);
    });this.transaction(()=>this.drain());
  }
  linkDerived(id:string,revision:number,sources:Array<{id:string;revision:number}>):KnowledgeRecord {
    const result=this.transaction(()=>{
      this.drain();const rows=this.rows(),record=rows.find(r=>r.id===id);
      if(!record||record.revision!==revision||record.status!=='pending') throw new Error('归纳条目已变化');
      const originals=sources.map(source=>rows.find(r=>r.id===source.id&&r.revision===source.revision));
      if(originals.length<2||originals.some(r=>!r||r.id===id||r.kind!=='reusable_lesson'||r.namespace!==record.namespace||r.repoKey!==record.repoKey||r.branch!==record.branch||!['active','pending'].includes(r.status))) throw new Error('归纳来源已变化或不在同一范围');
      const updated:KnowledgeRecord={...record,revision:record.revision+1,updatedAt:Date.now(),relations:[...sources.map(source=>({targetId:source.id,targetRevision:source.revision,kind:'derived_from' as const,inferred:true}))],decisionReason:'基于独立事件归纳，等待核对条件；来源未被自动取代'};
      this.persist(updated,'derived');return updated;
    });this.transaction(()=>this.drain());return result;
  }
  core(namespace:KnowledgeNamespace,budget=2000,scope:{repoKey?:string;branch?:string}={}):string {
    let used=0; const out:string[]=[];
    for(const r of this.list().records) {
      if(this.deletedById(r.id))continue;
      if(!this.policyAllows(r))continue;
      if(r.namespace!==namespace||r.status!=='active'||!['stable_constraint','user_preference','user_profile'].includes(r.kind)||r.applicability.length) continue;
      if(r.repoKey&&r.repoKey!==knowledgeRepoKey(scope.repoKey)||r.branch&&r.branch!==scope.branch) continue;
      if(r.expiresAt!=null&&r.expiresAt<=Date.now()) continue;
      const environment=checkMemoryEnvironment(r);if(environment&&environment.state!=='current')continue;
      // 例外是条目语义的一部分（memory-system F-01②/架构审计 P1-5）：注入行必须携带
      // 否定边界，不得让约束比用户原意更强；整行超预算仍整条省略（不截断半句）。
      const exceptions=r.exceptions?.length?`（例外：${r.exceptions.join('；')}）`:'';
      const line=`- ${r.summary}${exceptions} [记忆 ${r.id}]`;
      if(used+line.length+1>budget) continue;
      out.push(line); used+=line.length+1;
    }
    return out.join('\n');
  }
  checkpoint(id:string):string|undefined { return (this.db.prepare('SELECT value FROM checkpoints WHERE id=?').get(id) as {value:string}|undefined)?.value; }
  claimMaintenance(id:string,now:number,interval:number):boolean {
    return this.transaction(()=>{
      if(now-Number(this.checkpoint(id)??0)<interval) return false;
      this.setCheckpoint(id,String(now));return true;
    });
  }
  lease(name:string,owner:string,ttl:number):boolean {
    return this.transaction(()=>{
      const now=Date.now();
      this.db.prepare('INSERT OR IGNORE INTO leases VALUES(?,?,?)').run(name,owner,now+ttl);
      return this.db.prepare('UPDATE leases SET owner=?,expires=? WHERE name=? AND (owner=? OR expires<=?)').run(owner,now+ttl,name,owner,now).changes>0;
    });
  }
  releaseLease(name:string,owner:string):void {this.db.prepare('DELETE FROM leases WHERE name=? AND owner=?').run(name,owner);}
  setCheckpoint(id:string,value:string):void { this.db.prepare('INSERT OR REPLACE INTO checkpoints VALUES(?,?)').run(id,value); }
  close():void { this.db.close(); }
}
