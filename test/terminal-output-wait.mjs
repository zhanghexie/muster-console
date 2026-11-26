import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-wait-'));
const compile = createSharedCompiler(process.cwd(), dir);
const load = file => import(pathToFileURL(compile(file)).href);
try {
  const { waitForTerminalOutput: wait } = await load('main/pty/outputWait.ts');
  // Use the real PtyManager cursor/lifecycle path with a fake PTY process only.
  const entry = compile('main/pty/manager.ts');
  const ptyDir = path.join(dir, 'node_modules/node-pty');
  fs.mkdirSync(ptyDir, { recursive: true });
  fs.writeFileSync(path.join(ptyDir, 'package.json'), '{"type":"module","exports":"./index.js"}');
  fs.writeFileSync(path.join(ptyDir, 'index.js'), 'export const spawn = (...args) => globalThis.testSpawn(...args);');
  const processes = [];
  globalThis.testSpawn = () => {
    const data = [], exit = [];
    const proc = { pid: 0, onData: fn => data.push(fn), onExit: fn => exit.push(fn),
      write() {}, kill() {}, resize() {},
      output: value => data.forEach(fn => fn(value)), end: code => exit.forEach(fn => fn({exitCode:code})) };
    processes.push(proc); return proc;
  };
  const { PtyManager } = await import(pathToFileURL(entry).href);
  const source = new PtyManager(() => null, ({ launch, spawn }) => {
    const proc = spawn(launch);
    let exited = false;
    const completed = new Promise(resolve => proc.onExit(() => { exited = true; resolve(); }));
    return { ready: Promise.resolve(), completed, close: async () => { if (!exited) proc.end(0); } };
  });
  const spawn = async () => {
    await source.spawn('s', { command: 'fixture', args: [] }, process.cwd());
    return processes.at(-1);
  };
  let proc = await spawn();
  proc.output('old READY');
  assert.equal((await wait(source, 's', {text:'READY',timeoutMs:20})).reason, 'timeout', 'old buffer is never matched implicitly');
  const cursor = source.getOutputCursor('s');
  proc.output('\x1b[32mRE'); proc.output('ADY\x1b[0m');
  assert.equal((await wait(source, 's', {text:'READY'}, {after:cursor})).reason, 'text', 'write -> capture gap and ANSI-spanning chunks are covered');
  const pending = wait(source, 's', {text:'NEW',timeoutMs:200});
  proc.output('N'); proc.output('EW');
  assert.equal((await pending).reason, 'text');
  const largeCursor = source.getOutputCursor('s');
  proc.output('BACKLOG_DONE' + 'x'.repeat(70_000));
  assert.equal((await wait(source, 's', {text:'BACKLOG_DONE',timeoutMs:30}, {after:largeCursor})).reason, 'text', 'match the full retained suffix before bounding the carry buffer');
  const largeChunk = wait(source, 's', {text:'CHUNK_DONE',timeoutMs:30});
  proc.output('CHUNK_DONE' + 'x'.repeat(70_000));
  assert.equal((await largeChunk).reason, 'text', 'do not truncate a large chunk before matching');
  let titleMatched = false;
  const title = wait(source, 's', {text:'VISIBLE_DONE',timeoutMs:250}).then(result=>{titleMatched=true;return result;});
  proc.output('\x1b]0;VISIBLE_DONE');
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(titleMatched,false,'an incomplete OSC title is not displayed text');
  proc.output('\x1b');proc.output('\\');proc.output('VISIBLE_');proc.output('DONE');
  assert.equal((await title).reason,'text','visible text after ST can match across chunks');
  proc.output('\x1b]0;old-title-');
  const inside = source.getOutputCursor('s');proc.output('MID_TITLE');
  let midMatched=false;
  const mid=wait(source,'s',{text:'MID_TITLE',timeoutMs:250},{after:inside}).then(result=>{midMatched=true;return result;});
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(midMatched,false,'cursor inside an open OSC restores parser state without matching old text');
  proc.output('\x07MID_TITLE');assert.equal((await mid).reason,'text');
  const quiet = wait(source, 's', {quietMs:50,timeoutMs:250});
  await new Promise(resolve => setTimeout(resolve, 30)); proc.output('working');
  const q = await quiet;
  assert.equal(q.reason, 'quiet'); assert.ok(q.elapsedMs >= 75, 'every new chunk resets the quiet window');
  const abort = new AbortController();
  const cancelled = wait(source, 's', {text:'never'}, {signal:abort.signal});
  abort.abort(); await assert.rejects(cancelled, /取消/);
  assert.equal(source.outputListeners.size, 0, 'abort releases observers');
  const exiting = wait(source, 's', {text:'never'}); proc.end(17);
  assert.deepEqual({...await exiting, elapsedMs:0}, {reason:'exited',exitCode:17,elapsedMs:0});
  assert.equal((await wait(source, 's', {quietMs:50})).reason, 'not_running');
  proc = await spawn();
  const replaced = wait(source, 's', {text:'never'}), oldCursor = source.getOutputCursor('s'), old = proc;
  proc = await spawn(); assert.equal((await replaced).reason, 'replaced');
  old.output('stale'); assert.equal(source.getBuffer('s'), '', 'retired process cannot contaminate replacement output');
  await assert.rejects(wait(source, 's', {text:'never'}, {after:oldCursor}), /当前终端进程/);
  const evicted = source.getOutputCursor('s'); proc.output('x'.repeat(210_000));
  await assert.rejects(wait(source, 's', {text:'never'}, {after:evicted}), /过期/);
  const stopped = wait(source, 's', {text:'never'}); source.kill('s');
  assert.equal((await stopped).reason, 'stopped');
  for (const condition of [{}, {text:'a',quietMs:50}, {text:''}, {text:'a',timeoutMs:30001}, {quietMs:49}]) await assert.rejects(wait(source, 's', condition));
  assert.equal(source.outputListeners.size, 0, 'every completion releases observers');
  console.log('terminal-output-wait: OK (new-output cursor, chunk/ANSI match, quiet reset, timeout/cancel/exit/replacement/eviction)');
} finally { delete globalThis.testSpawn; fs.rmSync(dir, {recursive:true,force:true}); }
