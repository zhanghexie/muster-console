/** Real filesystem regressions for turn ownership, pre-existing edits and guarded undo. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { createRequire } from 'node:module';
const { parseDiff } = createRequire(import.meta.url)('react-diff-view');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'turn-changes-'));
const compile = createSharedCompiler(root, tmp);
const { TurnChangeService } = await import(pathToFileURL(compile('main/turnChanges/service.ts')).href);
// Negative control reproduces the old silent ownership-only behavior without changing production files.
if (process.argv.includes('--baseline-silent-collision')) TurnChangeService.prototype.reportCollision = () => {};
let passed = 0;
async function scenario(name, fn) {
  const dir = path.join(tmp, `case-${passed}`);
  fs.mkdirSync(dir);
  const service = new TurnChangeService(path.join(tmp, `store-${passed}`));
  const begin = async (owner = 'gui:a', id = 'm1') => {
    const tracker = service.begin(owner, id, dir, [dir]); await tracker.ready;
    // The fixture invokes callbacks synchronously before/after the write,
    // matching the trusted SDK hook rather than an observed late event.
    const start = tracker.toolStart.bind(tracker), end = tracker.toolEnd.bind(tracker);
    tracker.toolStart = (id, name, input, kind) => start(id, name, input, kind, true);
    tracker.toolEnd = (id, ok, patch) => end(id, ok, patch, true);
    return tracker;
  };
  const write = (file, text) => fs.writeFileSync(path.join(dir, file), text);
  const read = file => fs.readFileSync(path.join(dir, file), 'utf8');
  // Close filesystem watchers before removing their roots; otherwise an unref'ed
  // recursive watcher can keep processing deletion notifications indefinitely.
  try { await fn({ dir, service, begin, write, read }); }
  finally { service.dispose(); }
  passed++;
  console.log(`ok ${passed} - ${name}`);
}
try {
  await scenario('a newly mapped source cannot be restored through an allowed ancestor', async ({dir, service, begin, write, read}) => {
    write('a.txt', 'before'); const tracker = await begin();
    await tracker.toolStart('edit', 'write', { path: 'a.txt', content: 'after' }); write('a.txt', 'after'); await tracker.toolEnd('edit', true);
    const summary = await tracker.finish();
    assert.equal(summary.files[0].revertible, true);
    const result = await service.revert(summary.id, 'gui:a', 'm1', [dir], () => false);
    assert.equal(result.restored.length, 0); assert.equal(read('a.txt'), 'after');
  });
  await scenario('preserves edits already dirty before the turn; persisted diff survives restart', async ({dir, service, begin, write, read}) => {
    write('a.txt', 'my uncommitted edit\nold\n');
    const t = await begin();
    await t.toolStart('read', 'read', {path:'a.txt'}); await t.toolEnd('read', true);
    await t.toolStart('1', 'edit', {path:'a.txt', oldText:'old', newText:'new'});
    write('a.txt', 'my uncommitted edit\nnew\n'); await t.toolEnd('1', true);
    const s = await t.finish();
    assert.equal(s.files[0].revertible, true);
    const diff = service.diff(s.id, 'gui:a', 'm1', 'a.txt');
    assert.match(diff, /\+new/);
    assert.equal(parseDiff(diff).length, 1, 'the production viewer must parse real hunks, not fall back to raw text');
    const fresh = new TurnChangeService(path.join(tmp, 'store-1'));
    const reverted = (await fresh.revert(s.id, 'gui:a', 'm1', [dir]));
    assert.equal(reverted.ok, true);
    assert.equal(reverted.summary.files[0].reverted, true);
    assert.equal(reverted.summary.files[0].revertible, false);
    assert.equal(read('a.txt'), 'my uncommitted edit\nold\n');
  });
  await scenario('multiple writes aggregate to one net diff', async ({dir, service, begin, write, read}) => {
    write('a', 'one\n'); const t=await begin();
    await t.toolStart('1','write',{path:'a',content:'two\n'}); write('a','two\n'); await t.toolEnd('1',true);
    await t.toolStart('2','edit',{path:'a',oldText:'two',newText:'three'}); write('a','three\n'); await t.toolEnd('2',true);
    const s=await t.finish(); assert.equal(s.files.length,1); assert.equal(s.files[0].revertible,true);
    (await service.revert(s.id,'gui:a','m1',[dir])); assert.equal(read('a'),'one\n');
  });
  await scenario('new file is removed; deleted file restored', async ({dir, service, begin, write, read}) => {
    write('old','keep\n'); const t=await begin();
    await t.toolStart('1','write',{path:'new',content:'created\n'}); write('new','created\n'); await t.toolEnd('1',true);
    await t.toolStart('2','delete_file',{path:'old'}); fs.unlinkSync(path.join(dir,'old')); await t.toolEnd('2',true);
    const s=await t.finish(); assert.equal(s.files.length,2); assert(s.files.every(f=>f.revertible));
    assert.equal((await service.revert(s.id,'gui:a','m1',[dir])).ok,true);
    assert.equal(fs.existsSync(path.join(dir,'new')),false); assert.equal(read('old'),'keep\n');
  });
  await scenario('later personal edit conflicts while independent files revert', async ({dir, service, begin, write, read}) => {
    write('a','old'); write('b','old'); const t=await begin();
    for(const f of ['a','b']) { await t.toolStart(f,'write',{path:f,content:'new'}); write(f,'new'); await t.toolEnd(f,true); }
    const s=await t.finish(); write('a','new plus my later edit');
    const r=(await service.revert(s.id,'gui:a','m1',[dir])); assert.equal(r.ok,false); assert.deepEqual(r.restored,['b']);
    assert.equal(read('a'),'new plus my later edit'); assert.equal(read('b'),'old'); assert.equal(r.conflicts[0].path,'a');
    assert.equal((await service.revert(s.id,'gui:a','m1',[dir])).restored.length,0);
  });
  await scenario('manual edit before a trusted tool is preserved by undo', async ({dir, service, begin, write, read}) => {
    write('a','old\n'); const t=await begin(); write('a','my edit\nold\n');
    await t.toolStart('1','edit',{path:'a',oldText:'old',newText:'new'}); write('a','my edit\nnew\n'); await t.toolEnd('1',true);
    const s=await t.finish(); assert.equal(s.files[0].revertible,true);
    assert.equal((await service.revert(s.id,'gui:a','m1',[dir])).restored.length,1); assert.equal(read('a'),'my edit\nold\n');
  });
  await scenario('concurrent edits are recorded and reported only on revert, preserving the live file', async ({dir, service, begin, write, read}) => {
    write('a','old'); write('safe','original'); const a=await begin('gui:a','a'); const b=await begin('gui:b','b');
    const collisions=[]; a.service.setCollisionHandler(event=>collisions.push(event));
    await a.toolStart('1','write',{path:'a',content:'A'}); write('a','A'); await a.toolEnd('1',true);
    assert.equal(collisions.length,0);
    await b.toolStart('2','write',{path:'a',content:'B'});
    assert.equal(collisions.length,1,'record on the tool event, before round completion');
    assert.deepEqual(a.summary.concurrentEdits,[{path:'a',otherOwner:'gui:b',otherLabel:'gui:b'}]);
    assert.deepEqual(b.summary.concurrentEdits,[{path:'a',otherOwner:'gui:a',otherLabel:'gui:a'}]);
    write('a','B'); await b.toolEnd('2',true);
    await b.toolStart('3','write',{path:'a',content:'B2'}); write('a','B2'); await b.toolEnd('3',true);
    assert.equal(collisions.length,1,'one collision per file and pair in a round');
    await a.toolStart('4','write',{path:'safe',content:'updated'}); write('safe','updated'); await a.toolEnd('4',true);
    const sa=await a.finish(), sb=await b.finish();
    assert.equal(sa.files.find(file => file.path === 'a').revertible,false);
    assert.equal(sb.files[0].revertible,false);
    assert.equal(sa.concurrentEdits.length,1); assert.equal(sb.concurrentEdits.length,1);
    const result = await service.revert(sa.id, 'gui:a', 'a', [dir]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.restored, ['safe']);
    assert.deepEqual(result.conflicts, [{ path: 'a', reason: '其他会话同时修改了该文件，已保留当前内容：gui:b' }]);
    assert.equal(read('a'), 'B2'); assert.equal(read('safe'), 'original');
  });
  await scenario('different files and non-overlapping rounds do not warn; separate peers do', async ({begin,write})=>{
    write('a','old'); write('b','old'); const a=await begin('gui:a','a'), b=await begin('dispatch:b','b');
    const collisions=[]; a.service.setCollisionHandler(event=>collisions.push(event));
    await a.toolStart('1','write',{path:'a',content:'A'}); write('a','A'); await a.toolEnd('1',true);
    await b.toolStart('2','write',{path:'b',content:'B'}); write('b','B'); await b.toolEnd('2',true);
    assert.equal(collisions.length,0);
    await a.finish(); await b.toolStart('3','write',{path:'a',content:'B'}); write('a','B'); await b.toolEnd('3',true);
    assert.equal(collisions.length,0,'completed rounds are no longer active peers');
    const c=await begin('gui:c','c'); await c.toolStart('4','write',{path:'a',content:'C'}); write('a','C'); await c.toolEnd('4',true);
    assert.equal(collisions.length,1); assert.equal(c.summary.concurrentEdits[0].otherOwner,'dispatch:b');
    await b.finish(); await c.finish();
  });
  await scenario('unregistered shell changes are not attributed or reverted', async ({dir, service, begin, write, read}) => {
    write('a','old'); const t=await begin(); await t.toolStart('1','bash',{command:'script'});
    write('a','foreign'); write('new','script result'); await t.toolEnd('1',true);
    const s=await t.finish(); assert.equal(s.files.length,0); assert(s.warnings.some(w=>w.includes('命令改动')));
    assert.equal(read('a'),'foreign'); assert.equal(read('new'),'script result');
  });
  await scenario('failed writes do not become confirmed diffs', async ({begin, write}) => {
    write('a','old'); const t=await begin(); await t.toolStart('1','write',{path:'a',content:'new'}); write('a','new'); await t.toolEnd('1',false);
    const s=await t.finish(); assert.equal(s.files.length,0); assert(s.warnings.length);
  });
  await scenario('net zero edits produce no changed files', async ({begin,write}) => {
    write('a','old'); const t=await begin(); await t.toolStart('1','write',{path:'a',content:'old'}); write('a','old'); await t.toolEnd('1',true);
    assert.equal((await t.finish()).files.length,0);
  });
  await scenario('a late event cannot claim an independently created matching file', async ({dir,service,begin,write,read}) => {
    const t=await begin(); write('a','same result');
    await t.capture.toolStart('1','write',{path:'a',content:'same result'}); write('a','same result'); await t.capture.toolEnd('1',true);
    const s=await t.finish(); assert.equal(s.files.length,0);
    assert.equal(read('a'),'same result');
  });
  await scenario('same-content external rewrites after the turn are protected by the fingerprint', async ({dir,service,begin,write,read})=>{
    write('a','old'); const t=await begin(); await t.toolStart('1','write',{path:'a',content:'new'});write('a','new');await t.toolEnd('1',true);
    const s=await t.finish(); const st=fs.statSync(path.join(dir,'a'));fs.utimesSync(path.join(dir,'a'),st.atime,new Date(st.mtimeMs+1000));
    assert.equal((await service.revert(s.id,'gui:a','m1',[dir])).restored.length,0);assert.equal(read('a'),'new');
  });
  await scenario('different owner, removed writable root and active turn fail closed', async ({dir,service,begin,write,read})=>{
    write('a','old'); const t=await begin(); await t.toolStart('1','write',{path:'a',content:'new'}); write('a','new'); await t.toolEnd('1',true); const s=await t.finish();
    assert.throws(()=>service.revert(s.id,'gui:other','m1',[dir]),/不属于/);
    assert.equal((await service.revert(s.id,'gui:a','m1',[])).restored.length,0);
    const active=await begin('gui:b','b'); assert.equal((await service.revert(s.id,'gui:a','m1',[dir])).restored.length,0);
    await active.finish(); assert.equal(read('a'),'new');
  });
  await scenario('deleted file recreated by a user cannot be overwritten', async ({dir,service,begin,write,read})=>{
    write('a','old'); const t=await begin(); await t.toolStart('1','delete_file',{path:'a'}); fs.unlinkSync(path.join(dir,'a')); await t.toolEnd('1',true); const s=await t.finish();
    write('a','recreated'); assert.equal((await service.revert(s.id,'gui:a','m1',[dir])).restored.length,0); assert.equal(read('a'),'recreated');
  });
  await scenario('patch edits establish intent without attributing other files', async ({dir,service,begin,write,read})=>{
    write('a','old\n'); const t=await begin();
    await t.toolStart('1','apply_patch',{patch:'*** Begin Patch\n*** Update File: a\n@@\n-old\n+new\n*** Add File: b\n+created\n*** End Patch'});
    write('a','new\n'); write('b','created\n'); await t.toolEnd('1',true); const s=await t.finish(); assert(s.files.every(f=>f.revertible));
    assert.equal((await service.revert(s.id,'gui:a','m1',[dir])).ok,true); assert.equal(read('a'),'old\n'); assert(!fs.existsSync(path.join(dir,'b')));
  });
  await scenario('oversized pre-existing file cannot be mistaken for a new file', async ({dir,service,begin,write,read})=>{
    write('a','x'.repeat(1024*1024+1)); const t=await begin(); await t.toolStart('1','write',{path:'a',content:'new'}); write('a','new'); await t.toolEnd('1',true); const s=await t.finish();
    assert.equal(s.files.length,1); assert.equal(s.files[0].kind,'modified'); assert.equal(s.files[0].diffOmitted,true);
    assert.equal((await service.revert(s.id,'gui:a','m1',[dir])).restored.length,0); assert.equal(read('a'),'new');
  });
  await scenario('links and host storage cannot be traversed or restored', async ({dir,begin,write})=>{
    fs.mkdirSync(path.join(dir,'.muster')); fs.writeFileSync(path.join(dir,'.muster','private'),'secret');
    const outside=path.join(tmp,'outside'); fs.mkdirSync(outside,{recursive:true}); fs.writeFileSync(path.join(outside,'x'),'safe');
    fs.symlinkSync(outside,path.join(dir,'link'),'junction'); const t=await begin();
    await t.toolStart('1','write',{path:'link/x',content:'new'}); await t.toolEnd('1',true);
    write('ordinary','safe'); const s=await t.finish(); assert.equal(s.files.length,0); assert.equal(fs.readFileSync(path.join(outside,'x'),'utf8'),'safe');
  });
  console.log(`turn-changes: ${passed} passed`);
} finally {
  assert(tmp.startsWith(path.join(root,'.tmp')+path.sep));
  fs.rmSync(tmp,{recursive:true,force:true});
}
