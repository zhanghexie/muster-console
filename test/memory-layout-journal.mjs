import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memory-layout-'));
const write=(root,rel,text)=>{const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return file;};
const fixture=name=>{const root=path.join(dir,name);fs.mkdirSync(root);return root;};
const entry={topic:'订阅清理',status:'进行中',problem:'重复订阅',points:['已定位原因']};
const oldJournal='## [旧任务] 已完成\n- 问题：原始问题\n- 要点：原始依据\n';
try{
  const bundle=path.join(dir,'api.cjs');
  await build({stdin:{contents:`export * from './src/main/memory/layout';export * from './src/main/memory/journal';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:bundle});
  const api=createRequire(import.meta.url)(bundle);
  const root=fixture('current-only');
  const old=write(root,'docs/journal/2026-10-25.md',oldJournal);
  const legacy=write(root,'.muster/memory/state.sqlite','legacy bytes');
  write(root,'.muster/memory/layout.json','obsolete marker is not consulted');
  api.ensureMemoryLayout(root);
  assert.deepEqual(api.listJournalDays(root),[],'legacy journals are not discovered');
  assert.equal(fs.readFileSync(old,'utf8'),oldJournal);
  assert.equal(fs.readFileSync(legacy,'utf8'),'legacy bytes');
  assert.equal(fs.existsSync(path.join(root,'.muster/memory/migrations')),false);
  const linked=fixture('linked'),outside=fixture('outside');fs.mkdirSync(path.join(linked,'.muster'));fs.symlinkSync(outside,path.join(linked,'.muster/memory'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>api.ensureMemoryLayout(linked),/符号链接/);assert.deepEqual(fs.readdirSync(outside),[]);

  const j=fixture('journal'),now=new Date(2026,9,25,23,59);
  const receipt=api.writeJournal(j,'session-a',entry,now);
  assert.equal(api.writeJournal(j,'session-a',entry,now).entryId,receipt.entryId,'retry is idempotent');
  const second=api.writeJournal(j,'session-b',entry,now);assert.notEqual(second.entryId,receipt.entryId,'same topic across actors is not merged');
  assert.throws(()=>api.writeJournal(j,'session-b',{...entry,entryId:receipt.entryId,revision:1}),/不属于/);
  const revision=api.writeJournal(j,'session-a',{...entry,status:'已完成',entryId:receipt.entryId,revision:1},new Date(2026,9,26));
  assert.equal(revision.day,'2026-10-25');assert.equal(revision.revision,2);
  assert.throws(()=>api.writeJournal(j,'session-a',{...entry,entryId:receipt.entryId,revision:1}),/版本已变化/);
  assert.equal(api.searchJournal(j,'订阅',10,'2026-10-25').hits.length,2);
  assert.throws(()=>api.readJournalDay(j,'../../secret'),/日期/);
  assert.throws(()=>api.writeJournal(j,'',entry),/身份/);
  const child=write(dir,'child.cjs',`const api=require(${JSON.stringify(bundle)});api.writeJournal(process.argv[2],process.argv[3],${JSON.stringify(entry)});`);
  await Promise.all(['c','d'].map(actor=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[child,j,actor],{stdio:['ignore','ignore','pipe']});let stderr='';p.stderr.on('data',v=>stderr+=v);p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error(stderr)));})));
  assert.equal(api.searchJournal(j,'订阅',10).hits.length,4,'parallel writers preserve both entries');
  assert.equal(api.hasJournalForActor(j,'c'),true);
  assert.equal(api.searchJournal(j,'订阅',1).scannedDays,1,'only count dates actually read');
  api.writeJournal(j,'session-a',{...entry,topicId:'linked-topic',status:'阻塞'},new Date(2026,0,2));
  api.writeJournal(j,'session-b',{...entry,topicId:'linked-topic',status:'搁置'},new Date(2026,0,3));
  const firstTopic=api.searchJournal(j,'',1,undefined,{topicId:'linked-topic'});
  assert.equal(firstTopic.hits[0].status,'搁置');assert.ok(firstTopic.nextCursor);
  const secondTopic=api.searchJournal(j,'',1,undefined,{topicId:'linked-topic',cursor:firstTopic.nextCursor});
  assert.equal(secondTopic.hits[0].status,'阻塞');
  assert.throws(()=>api.searchJournal(j,'',1,undefined,{topicId:'other',cursor:firstTopic.nextCursor}),/游标/);
  assert.equal(api.searchJournal(j,'',10,undefined,{topicId:'linked-topic',fromDate:'2026-01-03'}).hits.length,1);
  const older=fixture('over-90-days');
  for(let index=0;index<92;index++){
    const date=new Date(Date.UTC(2026,9,31-index)).toISOString().slice(0,10);
    write(older,`.muster/memory/journal/${date}.md`,`## [${index===91?'旧里程碑':'普通进展'}] 已完成\n- 问题：记录进度\n- 要点：历史原文\n`);
  }
  const firstHistory=api.searchJournal(older,'旧里程碑');
  assert.equal(firstHistory.scannedDays,90);assert.equal(firstHistory.hits.length,0);assert.ok(firstHistory.nextCursor);
  const olderHistory=api.searchJournal(older,'旧里程碑',5,undefined,{cursor:firstHistory.nextCursor});
  assert.equal(olderHistory.hits[0].topic,'旧里程碑','cursor reaches an entry older than 90 recorded days');
  const crash=fixture('journal-outbox'),renameJournal=fs.renameSync;
  fs.renameSync=(from,to)=>{if(String(to).includes(path.join('memory','journal')))throw new Error('journal projection interrupted');return renameJournal(from,to);};
  try{assert.throws(()=>api.writeJournal(crash,'actor',entry,now),/projection interrupted/);}finally{fs.renameSync=renameJournal;}
  assert.deepEqual(api.listJournalDays(crash),['2026-10-25'],'listing drains a committed outbox after restart');
  assert.equal(api.searchJournal(crash,'订阅').hits.length,1);
  const saved=api.writeJournal(crash,'actor',entry,now);
  fs.writeFileSync(path.join(crash,saved.path),'external change');
  assert.throws(()=>api.writeJournal(crash,'actor',entry,now),/外部更改/,'idempotent retry must not claim a missing projection is saved');

  console.log('memory-layout-journal: current-only paths, no legacy mutation, links, journal CAS and concurrent writers passed');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
