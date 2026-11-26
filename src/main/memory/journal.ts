/** One host writer for model journals, exit summaries and daily-report reads. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {sqliteFilePath} from '../sqliteFilePath';
import {serializeJournalEntry,parseJournalEntries,JOURNAL_STATUSES,type JournalEntry} from '../../shared/journalFormat';
import {writeTextAtomicSync} from '../atomicJson';
import {ensureMemoryLayout,memoryPath,JOURNAL_HOME_REL,RUNTIME_HOME_REL} from './layout';
import {redactCredentialShapes} from './redact';

export interface JournalInput extends JournalEntry {entryId?:string;revision?:number}
export interface JournalReceipt {saved:true;entryId:string;revision:number;day:string;path:string;unchanged:boolean}
type Row={id:string;actor:string;day:string;revision:number;payload:string};
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const dayOf=(now:Date)=>`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
function dateKey(value:string):string {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||new Date(`${value}T12:00:00Z`).toISOString().slice(0,10)!==value)throw new Error('日志日期必须为有效的YYYY-MM-DD');
  return value;
}
function text(value:unknown,max:number):string {
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\r\n\u0000]/.test(value)||value.includes('<!--'))throw new Error('日志字段需为有界单行文本');
  return redactCredentialShapes(value.trim()).text;
}
function validate(input:JournalInput):JournalEntry {
  if(!input||!JOURNAL_STATUSES.includes(input.status)||!Array.isArray(input.points)||!input.points.length||input.points.length>12)throw new Error('日志需要状态、问题和1到12条要点');
  if(input.entryId!=null&&!/^[a-f0-9-]{36}$/.test(input.entryId))throw new Error('日志条目身份无效');
  if(input.entryId&&(!Number.isInteger(input.revision)||input.revision!<1))throw new Error('更新日志需要当前revision');
  return {topic:text(input.topic,20),...(input.topicId?{topicId:text(input.topicId,100)}:{}),status:input.status,problem:text(input.problem,1500),points:input.points.map(point=>text(point,1500))};
}
function block(row:Row):string {return `<!-- muster-journal:${row.id}:${row.revision} -->\n${serializeJournalEntry(JSON.parse(row.payload) as JournalEntry)}\n<!-- /muster-journal:${row.id} -->`;}
function dayPath(root:string,day:string):string {return memoryPath(root,path.join(JOURNAL_HOME_REL,`${dateKey(day)}.md`));}
function readFile(file:string):string {
  try{if(fs.statSync(file).size>2*1024*1024)throw new Error('单日日志超过2MiB，请导出归档后再处理');return fs.readFileSync(file,'utf8');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return '';throw error;}
}
function open(root:string):DatabaseSync {
  ensureMemoryLayout(root);
  const file=memoryPath(root,path.join(RUNTIME_HOME_REL,'journal.sqlite'));
  fs.mkdirSync(path.dirname(file),{recursive:true});
  for(const suffix of ['','-wal','-shm'])memoryPath(root,path.relative(root,file+suffix));
  const db=new DatabaseSync(sqliteFilePath(file));
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS journal_entries(id TEXT PRIMARY KEY,actor TEXT,day TEXT,revision INTEGER,payload TEXT);
    CREATE TABLE IF NOT EXISTS journal_outbox(day TEXT PRIMARY KEY,old_hash TEXT,content TEXT);`);
  return db;
}
function drain(db:DatabaseSync,root:string):void {
  for(const row of db.prepare('SELECT * FROM journal_outbox').all() as {day:string;old_hash:string;content:string}[]){
    const file=dayPath(root,row.day),current=readFile(file);
    if(current!==row.content){
      if(digest(current)!==row.old_hash)throw new Error('日志存在外部修改，保留原件，未覆盖');
      writeTextAtomicSync(file,row.content);
    }
    db.prepare('DELETE FROM journal_outbox WHERE day=?').run(row.day);
  }
}
export function writeJournal(root:string,actor:string,input:JournalInput,now=new Date()):JournalReceipt {
  if(!actor?.trim())throw new Error('日志缺少宿主会话身份');
  const entry=validate(input),payload=JSON.stringify(entry),db=open(root);
  try{
    db.exec('BEGIN IMMEDIATE');drain(db,root);
    let old:Row|undefined;
    if(input.entryId){
      old=db.prepare('SELECT * FROM journal_entries WHERE id=?').get(input.entryId) as Row|undefined;
      if(!old||old.actor!==actor)throw new Error('日志不属于当前会话');
      if(old.revision!==input.revision&&old.payload!==payload)throw new Error(`日志版本已变化，当前revision=${old.revision}`);
    }else{
      old=db.prepare('SELECT * FROM journal_entries WHERE actor=? AND day=? AND payload=? LIMIT 1').get(actor,dayOf(now),payload) as Row|undefined;
    }
    const row:Row=old?.payload===payload?old:{id:old?.id??randomUUID(),actor,day:old?.day??dayOf(now),revision:(old?.revision??0)+1,payload};
    if(old&&!readFile(dayPath(root,old.day)).includes(block(old)))throw new Error('原日志段已被外部更改，未覆盖');
    if(row!==old){
      const file=dayPath(root,row.day),current=readFile(file);
      const next=old?current.replace(block(old),block(row)):`${current.trimEnd()||`# ${row.day} 工作日志`}\n\n${block(row)}\n`;
      db.prepare('INSERT OR REPLACE INTO journal_entries VALUES(?,?,?,?,?)').run(row.id,row.actor,row.day,row.revision,row.payload);
      db.prepare('INSERT OR REPLACE INTO journal_outbox VALUES(?,?,?)').run(row.day,digest(current),next);
    }
    db.exec('COMMIT');
    db.exec('BEGIN IMMEDIATE');drain(db,root);db.exec('COMMIT');
    return {saved:true,entryId:row.id,revision:row.revision,day:row.day,path:path.join(JOURNAL_HOME_REL,`${row.day}.md`),unchanged:row===old};
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
}
export function listJournalDays(root:string):string[] {
  const db=open(root);
  try{db.exec('BEGIN IMMEDIATE');drain(db,root);db.exec('COMMIT');}finally{db.close();}
  const dir=memoryPath(root,JOURNAL_HOME_REL);
  if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir).filter(name=>/^\d{4}-\d{2}-\d{2}\.md$/.test(name)).map(name=>name.slice(0,-3)).sort().reverse();
}
export function hasJournalForActor(root:string,actor:string):boolean {
  const db=open(root);
  try{db.exec('BEGIN IMMEDIATE');drain(db,root);db.exec('COMMIT');return !!db.prepare('SELECT 1 FROM journal_entries WHERE actor=? LIMIT 1').get(actor);}finally{db.close();}
}
export function readJournalDay(root:string,day:string):{content:string} {
  const db=open(root);
  try{db.exec('BEGIN IMMEDIATE');drain(db,root);db.exec('COMMIT');return {content:readFile(dayPath(root,day))};}
  catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
}
export interface JournalSearchOptions {fromDate?:string;toDate?:string;cursor?:string;topicId?:string}
export function searchJournal(root:string,query:string,limit=5,day?:string,options:JournalSearchOptions={}){
  if(!Number.isFinite(limit))throw new Error('日志查询条数无效');
  limit=Math.min(10,Math.max(1,Math.floor(limit)));
  if(query.length>1000)throw new Error('日志查询过长');
  const terms=query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const from=options.fromDate?dateKey(options.fromDate):undefined,to=options.toDate?dateKey(options.toDate):undefined;
  if(from&&to&&from>to)throw new Error('开始日期不能晚于结束日期');
  if(options.topicId!==undefined)text(options.topicId,100);
  const signature=digest(JSON.stringify([path.resolve(root),query,day??'',from??'',to??'',options.topicId??'']));
  const days=(day?[dateKey(day)]:listJournalDays(root)).filter(date=>(!from||date>=from)&&(!to||date<=to));
  let startDay=0,startEntry=0;
  if(options.cursor){
    if(options.cursor.length>1000)throw new Error('日志游标过长');
    try {const decoded=JSON.parse(Buffer.from(options.cursor,'base64url').toString('utf8')) as {day:string;index:number;signature:string};
      if(decoded.signature!==signature)throw new Error('scope');
      dateKey(decoded.day);if(!Number.isSafeInteger(decoded.index)||decoded.index<0)throw new Error('index');
      startDay=days.indexOf(decoded.day);startEntry=decoded.index;if(startDay<0)throw new Error('day');
    }catch{throw new Error('日志游标无效或日期已不可用，请重新查询');}
  }
  const cursor=(date:string,index:number)=>Buffer.from(JSON.stringify({day:date,index,signature})).toString('base64url');
  const hits:Array<{kind:'journal';day:string;topic:string;topicId?:string;status:string;problem:string;points:string[];path:string;entryTruncated:boolean}>=[];
  let scanned=0;
  let nextCursor:string|null=null;
  for(let dayIndex=startDay;dayIndex<days.length;dayIndex++){
    const date=days[dayIndex]!;
    if(scanned>=90){nextCursor=cursor(date,0);break;}
    scanned+=1;
    const entries=parseJournalEntries(readJournalDay(root,date).content);
    for(let index=dayIndex===startDay?startEntry:0;index<entries.length;index++){
      const entry=entries[index]!;
      if(options.topicId&&entry.topicId!==options.topicId)continue;
      const body=[entry.topic,entry.problem,...entry.points].join(' ').toLocaleLowerCase();
      if(terms.length&&!terms.some(term=>body.includes(term)))continue;
      const problem=entry.problem.slice(0,400),points=entry.points.slice(0,3).map(point=>point.slice(0,250));
      const item={kind:'journal' as const,day:date,...entry,problem,points,path:path.join(JOURNAL_HOME_REL,`${date}.md`),
        entryTruncated:problem.length<entry.problem.length||points.length<entry.points.length||points.some((point,i)=>point.length<entry.points[i]!.length)};
      if(JSON.stringify({ok:true,result:{hits:[...hits,item]}}).length>9000){nextCursor=cursor(date,index);break;}
      hits.push(item);
      if(hits.length>=limit){nextCursor=index+1<entries.length?cursor(date,index+1):dayIndex+1<days.length?cursor(days[dayIndex+1]!,0):null;break;}
    }
    if(nextCursor||hits.length>=limit)break;
  }
  return {hits,scannedDays:scanned,truncated:!!nextCursor,nextCursor};
}
