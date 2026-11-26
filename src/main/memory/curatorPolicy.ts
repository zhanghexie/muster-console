import type {DatabaseSync} from 'node:sqlite';
import type {KnowledgeRecord} from '../../shared/knowledge';
import type {CuratorDecisionReceipt} from './curator/storageTypes';
import {createHash} from 'node:crypto';
import {redactCredentialShapes} from './redact';

export interface CuratorPolicyPort {
  db:DatabaseSync;
  transaction<T>(fn:()=>T):T;
  /** Must delegate to KnowledgeStore.persist so versions, projections and indexes stay coherent. */
  persist(record:KnowledgeRecord,event:string):void;
  drain():void;
}
export interface CuratorPolicyOperation {
  operationId:string;policyVersion:string;state:'complete'|'incomplete';at:number;
  affected:Array<{id:string;revision:number}>;reason:string;
}
export interface CuratorPolicyCompensation {
  policyVersion:string;processed:number;complete:number;incomplete:number;remaining:number;operations:CuratorPolicyOperation[];
}
interface ReceiptRow {receipt:string;before_json:string;after_json:string}
interface RevisionMapping {logical_hash:string;actual_hash:string;actual_revision:number}
const cache=new WeakMap<DatabaseSync,{stamp:string;available:(record:KnowledgeRecord)=>boolean}>();
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const validVersion=(version:string)=>{if(typeof version!=='string'||!version.trim()||version.length>120)throw new Error('非法记忆策略版本');};
const tableExists=(db:DatabaseSync,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

export function ensureCuratorPolicySchema(db:DatabaseSync):void {
  db.exec(`CREATE TABLE IF NOT EXISTS curator_disabled_policies(policy_version TEXT PRIMARY KEY,disabled_at INTEGER NOT NULL,reason TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS curator_policy_compensations(policy_version TEXT NOT NULL,operation_id TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(policy_version,operation_id));
    CREATE TABLE IF NOT EXISTS curator_policy_revision_map(policy_version TEXT NOT NULL,record_id TEXT NOT NULL,logical_revision INTEGER NOT NULL,logical_hash TEXT NOT NULL,actual_revision INTEGER NOT NULL,actual_hash TEXT NOT NULL,PRIMARY KEY(policy_version,record_id,logical_revision));
    CREATE TABLE IF NOT EXISTS curator_policy_safety(policy_version TEXT NOT NULL,record_id TEXT NOT NULL,revision INTEGER NOT NULL,usable INTEGER NOT NULL,PRIMARY KEY(policy_version,record_id,revision));`);
}
export function isCuratorPolicyDisabled(db:DatabaseSync,version:string):boolean {
  return tableExists(db,'curator_disabled_policies')&&!!db.prepare('SELECT 1 FROM curator_disabled_policies WHERE policy_version=?').get(version);
}
export const isVersionDisabled=isCuratorPolicyDisabled;
export function policyEnabled(db:DatabaseSync,version:string):boolean{return !isCuratorPolicyDisabled(db,version);}
/** Disabling is persistent and does not rewrite a record, projection or deletion tombstone. */
export function disableCuratorPolicy(db:DatabaseSync,version:string,reason:string,now=Date.now()):void {
  validVersion(version);if(typeof reason!=='string'||!reason.trim()||reason.length>1000||!Number.isFinite(now))throw new Error('策略停用需要有界原因和时间');
  ensureCuratorPolicySchema(db);
  db.prepare('INSERT OR IGNORE INTO curator_disabled_policies VALUES(?,?,?)').run(version,now,redactCredentialShapes(reason).text);cache.delete(db);
}

/** Cached per connection/data version, so batch recall can check every hit without rescanning receipts. */
export function curatorPolicyAvailable(db:DatabaseSync,record:KnowledgeRecord):boolean {
  if(record.userManaged)return true;
  if(!tableExists(db,'curator_disabled_policies'))return true;
  const version=(db.prepare('PRAGMA data_version').get() as {data_version:number}).data_version;
  const changes=(db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,stamp=`${version}:${changes}`;
  let entry=cache.get(db);
  if(!entry||entry.stamp!==stamp){entry={stamp,available:buildAvailability(db)};cache.set(db,entry);}
  return entry.available(record);
}
function buildAvailability(db:DatabaseSync):(record:KnowledgeRecord)=>boolean {
  const disabled=(db.prepare('SELECT policy_version FROM curator_disabled_policies').all() as Array<{policy_version:string}>).map(row=>row.policy_version);
  if(!disabled.length)return ()=>true;
  const roots=new Map<string,Map<string,number[]>>(),snapshots=new Map<string,KnowledgeRecord>(),current=new Map<string,KnowledgeRecord>();
  const key=(id:string,revision:number)=>`${id}:${revision}`;
  for(const row of db.prepare('SELECT payload FROM records').all() as Array<{payload:string}>){const record=JSON.parse(row.payload) as KnowledgeRecord;current.set(record.id,record);snapshots.set(key(record.id,record.revision),record);}
  if(tableExists(db,'versions'))for(const row of db.prepare('SELECT payload FROM versions').all() as Array<{payload:string}>){const record=JSON.parse(row.payload) as KnowledgeRecord;snapshots.set(key(record.id,record.revision),record);}
  for(const row of db.prepare('SELECT receipt,before_json,after_json FROM curator_receipts').all() as unknown as ReceiptRow[]){
    const receipt=JSON.parse(row.receipt) as CuratorDecisionReceipt;
    for(const record of [...JSON.parse(row.before_json),...JSON.parse(row.after_json)] as KnowledgeRecord[])snapshots.set(key(record.id,record.revision),record);
    if(!disabled.includes(receipt.policyVersion))continue;
    for(const record of JSON.parse(row.after_json) as KnowledgeRecord[]){const policies=roots.get(record.id)??new Map<string,number[]>();policies.set(receipt.policyVersion,[...(policies.get(receipt.policyVersion)??[]),record.revision]);roots.set(record.id,policies);}
  }
  const safety=db.prepare('SELECT policy_version,record_id,revision,usable FROM curator_policy_safety').all() as Array<{policy_version:string;record_id:string;revision:number;usable:number}>;
  const memo=new Map<string,boolean>(),visiting=new Set<string>();
  const blocked=(record:KnowledgeRecord):boolean=>{
    if(record.userManaged)return false;
    const identity=key(record.id,record.revision);if(memo.has(identity))return memo.get(identity)!;
    if(visiting.has(identity))return false;visiting.add(identity);
    let unsafe=false;
    for(const [policy,revisions] of roots.get(record.id)??[]){
      const latest=Math.max(...revisions.filter(revision=>revision<=record.revision));if(!Number.isFinite(latest))continue;
      const marker=safety.filter(item=>item.policy_version===policy&&item.record_id===record.id&&item.revision<=record.revision).sort((a,b)=>b.revision-a.revision)[0];
      if(!marker||marker.revision<=latest||!marker.usable){unsafe=true;break;}
    }
    if(!unsafe)for(const relation of record.relations??[]){
      if(!['derived_from','supports','revision_of'].includes(relation.kind))continue;
      const revision=relation.targetRevision??current.get(relation.targetId)?.revision;
      const source=revision==null?undefined:snapshots.get(key(relation.targetId,revision));
      if(source?blocked(source):roots.has(relation.targetId)){unsafe=true;break;}
    }
    visiting.delete(identity);memo.set(identity,unsafe);return unsafe;
  };
  return record=>!blocked(record);
}

/** Bounded reverse compensation. Every operation and its recovery metadata commit atomically. */
export function compensateCuratorPolicy(port:CuratorPolicyPort,policyVersion:string,options:{limit?:number;now?:number}={}):CuratorPolicyCompensation {
  validVersion(policyVersion);ensureCuratorPolicySchema(port.db);
  if(!isCuratorPolicyDisabled(port.db,policyVersion))throw new Error('必须先持久停用记忆策略，再补偿其操作');
  const limit=Math.max(1,Math.min(100,Math.floor(options.limit??20))),now=options.now??Date.now();
  if(!Number.isFinite(now)||!Number.isFinite(limit))throw new Error('非法策略补偿预算');
  port.transaction(()=>port.drain());
  const pending=port.db.prepare(`SELECT receipt,before_json,after_json FROM curator_receipts r
    WHERE json_extract(receipt,'$.policyVersion')=? AND NOT EXISTS(SELECT 1 FROM curator_policy_compensations c WHERE c.policy_version=? AND c.operation_id=r.operation_id)
    ORDER BY r.rowid DESC LIMIT ?`).all(policyVersion,policyVersion,limit) as unknown as ReceiptRow[];
  const operations:CuratorPolicyOperation[]=[];
  for(const row of pending){
    const operation=port.transaction(()=>{
      port.drain();const receipt=JSON.parse(row.receipt) as CuratorDecisionReceipt;
      const existing=port.db.prepare('SELECT result FROM curator_policy_compensations WHERE policy_version=? AND operation_id=?').get(policyVersion,receipt.operationId) as {result:string}|undefined;
      if(existing)return JSON.parse(existing.result) as CuratorPolicyOperation;
      const before=JSON.parse(row.before_json) as KnowledgeRecord[],after=JSON.parse(row.after_json) as KnowledgeRecord[];
      const current=new Map((port.db.prepare('SELECT payload FROM records').all() as Array<{payload:string}>).map(item=>{const record=JSON.parse(item.payload) as KnowledgeRecord;return [record.id,record] as const;}));
      const deleted=new Set((port.db.prepare('SELECT id FROM knowledge_deleted').all() as Array<{id:string}>).map(item=>item.id));
      const conflicts:string[]=[];
      for(const expected of after){
        const actual=current.get(expected.id);
        const mapping=port.db.prepare('SELECT logical_hash,actual_hash,actual_revision FROM curator_policy_revision_map WHERE policy_version=? AND record_id=? AND logical_revision=?').get(policyVersion,expected.id,expected.revision) as RevisionMapping|undefined;
        const exact=actual&&actual.revision===expected.revision&&hash(actual)===hash(expected);
        const mapped=actual&&mapping?.logical_hash===hash(expected)&&mapping.actual_revision===actual.revision&&mapping.actual_hash===hash(actual);
        if(deleted.has(expected.id)||!actual||!exact&&!mapped)conflicts.push(expected.id);
      }
      const affected:Array<{id:string;revision:number}>=[];
      const write=(record:KnowledgeRecord,usable:boolean,event:string)=>{port.persist(record,event);affected.push({id:record.id,revision:record.revision});port.db.prepare('INSERT OR REPLACE INTO curator_policy_safety VALUES(?,?,?,?)').run(policyVersion,record.id,record.revision,usable?1:0);};
      const history=(actual:KnowledgeRecord)=>[...actual.history,{revision:actual.revision,summary:actual.summary,status:actual.status,at:actual.updatedAt}].slice(-32);
      if(conflicts.length){
        for(const expected of after){const actual=current.get(expected.id);if(!actual||actual.userManaged||deleted.has(actual.id)||!['active','pending'].includes(actual.status))continue;
          write({...actual,status:'needs_revalidation',revision:actual.revision+1,updatedAt:now,decisionReason:`策略 ${policyVersion} 补偿存在后续更改，停止使用并保留新证据`,history:history(actual)},false,'policy_compensation_conflict');}
      }else{
        for(const expected of after){
          const actual=current.get(expected.id)!,original=before.find(record=>record.id===expected.id);
          const usable=!!original&&curatorPolicyAvailable(port.db,original);
          const restored:KnowledgeRecord=original?{...original,status:!usable&&original.status==='active'?'needs_revalidation':original.status,revision:actual.revision+1,updatedAt:now,decisionReason:`自动补偿策略 ${policyVersion} 操作 ${receipt.operationId}`,history:history(actual)}
            :{...actual,status:'needs_revalidation',revision:actual.revision+1,updatedAt:now,decisionReason:`策略 ${policyVersion} 新增产物已停止使用`,history:history(actual)};
          // Undoing a restore must reinstate its preceding deletion. Later user tombstones were
          // already treated as conflicts above and are never removed by compensation.
          if(original?.status==='rejected'){
            const {kind,summary,problem,action,rationale,applicability,exceptions,searchKeys,expectedFutureUse,repoKey,branch,taskId,expiresAt}=original;
            port.db.prepare('INSERT OR IGNORE INTO knowledge_deleted VALUES(?,?)').run(original.id,JSON.stringify({id:original.id,revision:restored.revision,namespace:original.namespace,deletedAt:original.updatedAt,kind,summary,problem,action,rationale,applicability,exceptions,searchKeys,expectedFutureUse,repoKey,branch,taskId,expiresAt}));
          }
          // A bounded pass may restore the output of an earlier bad operation. That historical
          // version is not safe merely because it appeared in before_json.
          write(restored,usable,'policy_compensated');
          if(original)port.db.prepare('INSERT OR REPLACE INTO curator_policy_revision_map VALUES(?,?,?,?,?,?)').run(policyVersion,original.id,original.revision,hash(original),restored.revision,hash(restored));
        }
      }
      const result:CuratorPolicyOperation={operationId:receipt.operationId,policyVersion,state:conflicts.length?'incomplete':'complete',at:now,affected,
        reason:conflicts.length?`后续删除、修订或证据不兼容：${conflicts.join(',')}；保留当前内容并停止使用受影响结果`:'按当前版本安全恢复兼容前版本；新增产物保留但不再使用'};
      port.db.prepare('INSERT INTO curator_policy_compensations VALUES(?,?,?)').run(policyVersion,receipt.operationId,JSON.stringify(result));cache.delete(port.db);return result;
    });
    operations.push(operation);port.transaction(()=>port.drain());
  }
  const results=(port.db.prepare('SELECT result FROM curator_policy_compensations WHERE policy_version=?').all(policyVersion) as Array<{result:string}>).map(row=>JSON.parse(row.result) as CuratorPolicyOperation);
  const remaining=Number((port.db.prepare(`SELECT COUNT(*) n FROM curator_receipts r WHERE json_extract(receipt,'$.policyVersion')=? AND NOT EXISTS(SELECT 1 FROM curator_policy_compensations c WHERE c.policy_version=? AND c.operation_id=r.operation_id)`).get(policyVersion,policyVersion) as {n:number}).n);
  return {policyVersion,processed:operations.length,complete:results.filter(result=>result.state==='complete').length,incomplete:results.filter(result=>result.state==='incomplete').length,remaining,operations};
}
