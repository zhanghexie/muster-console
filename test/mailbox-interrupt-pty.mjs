/** Real PTY Ctrl+C, confirmed idle/exit, and a rejected write; no external CLI or model. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const require = createRequire(import.meta.url), pty = require('node-pty');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interrupt-pty-'));
const compile = createSharedCompiler(process.cwd(), path.join(dir, 'compiled'));
const load = file => import(pathToFileURL(compile(file)));
const store = await load('main/metaAgent/messageStore.ts');
const { sendInterruptMail } = await load('main/messages/interrupt.ts');
const { attachMailboxWakes } = await load('main/messages/wake.ts');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  for (let n = 0; n < 500; n++) { if (predicate()) return; await delay(10); }
  throw Error('Timeout: ' + label);
}
const script = path.join(dir, 'cli.cjs');
fs.writeFileSync(script, `const fs=require('node:fs');
const record=kind=>fs.appendFileSync(process.argv[3],JSON.stringify({kind,at:Date.now()})+'\\n');
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.resume();
let input='';
process.stdin.on('data',data=>{for(const ch of data){
 if(ch==='\\x03'){record('ctrl-c');setTimeout(()=>{if(process.argv[2]==='exit')process.exit(0);record('idle');process.stdout.write('TURN_IDLE\\n');},200);}
 else if(ch==='\\r'||ch==='\\n'){if(input.includes('宿主收信提醒'))record('wake');input='';}
 else input+=ch;
}});
record('ready');if(process.argv[2]==='reader')process.stdout.write('TURN_IDLE\\n');
`);
async function check(mode) {
  const root = path.join(dir, mode); fs.mkdirSync(root); store.setAgentMessagesUserDataDir(root);
  const log = path.join(root, 'records.jsonl');
  const records = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const child = { id: 'child', workspaceId: 'ws', name: 'CLI', runtime: 'fixture', lifecycle: 'working', parentSessionId: 'parent' };
  const parent = { id: 'parent', workspaceId: 'ws' };
  let proc, running = false, respawns = 0, signals = 0, text = '';
  const processes = [];
  function start(kind) {
    proc = pty.spawn(process.execPath, [script, kind, log], { cwd: root, env: { ...process.env }, cols: 100, rows: 25 });
    processes.push(proc);
    running = true; text = '';
    proc.onData(data => { text += data; if (text.includes('TURN_IDLE')) child.lifecycle = 'idle'; });
    proc.onExit(() => { running = false; child.lifecycle = 'exited'; });
  }
  const write = (_id, data) => {
    if (!running) return false;
    if (data === '\x03') {
      assert.ok(store.readAgentMessageLedger(root, 'ws').messages.length, 'saved before a physical Ctrl+C');
      if (mode === 'write-failure') return false;
      signals++;
    }
    proc.write(data); return true;
  };
  const ctx = { config: { get: () => ({}) }, resolveBubbleWorkspaceId: () => 'ws', workspaces: { list: () => [{ id: 'ws', path: root }] },
    sessions: { get: id => id === 'child' ? child : id === 'parent' ? parent : undefined,
      peek: id => id === 'child' ? child : undefined, isChatRuntime: () => false,
      broadcastMessagesChanged() {}, onLifecycle: () => () => {}, getCliWorkspaceContext: () => undefined,
      async captureManagedInterruptSnapshot() { child.interruptSnapshot = { interruptedAt: 1, lastActivityAt: 1,
        reason: 'preemption', worktreeClean: true, uncommitted: [] }; },
      injectStrategy: async () => undefined, pasteInput: async () => false,
      respawn: async () => {
        assert.equal(running, false, 'resume only after actual process exit'); respawns++;
        start('reader'); await until(() => child.lifecycle === 'idle', 'resumed reader idle');
      } },
    pty: { isRunning: () => running, write, captureWriter: () => ({ write }) } };
  const off = attachMailboxWakes(ctx);
  try {
    start(mode); await until(() => records().some(r => r.kind === 'ready'), 'CLI ready');
    const send = key => sendInterruptMail(ctx, { from: 'parent', to: 'child', workspaceId: 'ws', text: 'changed plan ' + key, idempotencyKey: key });
    if (mode === 'write-failure') {
      await assert.rejects(send('failed'), /已保存.*未能发送中断信号/);
      assert.equal(signals, 0); assert.equal(running, true);
      assert.equal(records().filter(r => r.kind === 'wake').length, 0);
      assert.equal(store.readAgentMessageLedger(root, 'ws').messages[0].interruption, 'pending');
    } else {
      await Promise.all([send('one'), send('two')]);
      await until(() => records().some(r => r.kind === 'wake'), 'reader wake');
      assert.equal(signals, 1, 'distinct concurrent letters do not send Ctrl+C twice');
      assert.equal(records().filter(r => r.kind === 'ctrl-c').length, 1);
      assert.equal(records().filter(r => r.kind === 'wake').length, 1);
      assert.equal(respawns, mode === 'exit' ? 1 : 0);
      if (mode !== 'exit') assert.ok(records().findIndex(r => r.kind === 'wake') > records().findIndex(r => r.kind === 'idle'));
      assert.ok(store.readAgentMessageLedger(root, 'ws').messages.every(m => m.interruption === 'stopped' && m.notifiedAt && !m.read));
    }
  } finally {
    off();
    // An exited PTY still owns its ConPTY output worker; replacement must dispose that handle too.
    for (const terminal of processes) terminal.kill();
    await until(() => !running, 'PTY cleanup');
  }
}
try {
  for (const mode of ['idle', 'exit', 'write-failure']) await check(mode);
  console.log('mailbox-interrupt-pty: OK (real Ctrl+C, confirmed idle/exit, shared stop/wake, rejected write preserves mail)');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
