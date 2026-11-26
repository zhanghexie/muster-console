/** F-03: a blocked-flip between the typed body and the first Enter leaves input-line residue; the retry must clear it before retyping. Real PTY, no external CLI or model. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const require = createRequire(import.meta.url), pty = require('node-pty');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbox-retry-residue-'));
const compile = createSharedCompiler(process.cwd(), path.join(dir, 'compiled'));
const load = file => import(pathToFileURL(compile(file)));
const store = await load('main/metaAgent/messageStore.ts');
const { attachMailboxWakes, flushMailboxWake } = await load('main/messages/wake.ts');
const { flattenForTypedInput } = await load('main/pty/submit.ts');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  for (let n = 0; n < 500; n++) { if (predicate()) return; await delay(10); }
  throw Error('Timeout: ' + label);
}
// Fake TUI: keeps one input line; \r submits it, DEL/BS deletes the last code point — the
// lowest-common-denominator line edit every real TUI input box implements.
const script = path.join(dir, 'cli.cjs');
fs.writeFileSync(script, `const fs=require('node:fs');
const record=(kind,extra)=>fs.appendFileSync(process.argv[2],JSON.stringify({kind,at:Date.now(),...extra})+'\\n');
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.resume();
let input='';
process.stdin.on('data',data=>{for(const ch of data){
 if(ch==='\\x7f'||ch==='\\x08'){input=[...input].slice(0,-1).join('');record('backspace',{len:input.length});}
 else if(ch==='\\r'||ch==='\\n'){record('submit',{text:input});input='';}
 else{input+=ch;record('typed',{len:input.length});}
}});
record('ready');
`);
// wake.ts:105 的固定提醒模板（1 封普通信、无打断信）；单行无首尾空白，flatten 原样保留。
const wakeText = '【宿主收信提醒】邮箱收到 1 封新信。请用 host.mail.read 批量读取未读正文，按 nextCursor 续收。提醒不代表信件已读或任务完成；无需回复本提醒。';
const flat = flattenForTypedInput(wakeText);
const root = dir; fs.mkdirSync(root, { recursive: true }); store.setAgentMessagesUserDataDir(root);
const log = path.join(root, 'records.jsonl');
const records = () => fs.existsSync(log)
  ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
  : [];
const child = { id: 'child', workspaceId: 'ws', name: 'CLI', runtime: 'fixture', lifecycle: 'idle', parentSessionId: 'parent' };
const parent = { id: 'parent', workspaceId: 'ws' };
let proc, running = false;
const processes = [];
function start() {
  proc = pty.spawn(process.execPath, [script, log], { cwd: root, env: { ...process.env }, cols: 100, rows: 25 });
  processes.push(proc);
  running = true;
  proc.onExit(() => { running = false; });
}
const write = (_id, data) => { if (!running) return false; proc.write(data); return true; };
const lifecycleListeners = new Set();
const setLifecycle = next => { const prev = child.lifecycle; child.lifecycle = next; for (const fn of [...lifecycleListeners]) fn(child, prev, next); };
const ctx = { config: { get: () => ({}) }, resolveBubbleWorkspaceId: () => 'ws', workspaces: { list: () => [{ id: 'ws', path: root }] },
  sessions: { get: id => id === 'child' ? child : id === 'parent' ? parent : undefined,
    peek: id => id === 'child' ? child : undefined, isChatRuntime: () => false,
    broadcastMessagesChanged() {}, onLifecycle(fn) { lifecycleListeners.add(fn); return () => lifecycleListeners.delete(fn); },
    getCliWorkspaceContext: () => undefined, injectStrategy: async () => undefined, pasteInput: async () => false },
  pty: { isRunning: () => running, write, captureWriter: () => ({ write }) } };
const off = attachMailboxWakes(ctx);
try {
  start();
  await until(() => records().some(r => r.kind === 'ready'), 'CLI ready');
  // appendAgentMessage 分配顺序 id（输入 id 不保留），必须用返回值查账。
  const saved = await store.appendAgentMessageToStore(root, 'ws', {
    kind: 'notice', ts: Date.now(), receipt: 'stored',
    from: 'parent', to: 'child', fromName: 'parent', toName: 'child', text: '请继续推进' });
  const mailId = saved.id;
  // 第一次唤醒：正文键入后、首次 Enter 前（TYPE_TO_ENTER_MS 时序窗）翻到 blocked。
  const warn = console.warn; console.warn = () => {};
  const first = flushMailboxWake(ctx, 'child', 'ws');
  await until(() => {
    const typed = records().filter(r => r.kind === 'typed');
    return typed.length > 0 && typed[typed.length - 1].len >= flat.length;
  }, 'wake body fully typed into the TUI input line');
  setLifecycle('blocked'); // write 回调自此返回 false，Enter 被拦
  await first;
  console.warn = warn;
  fs.appendFileSync(log, JSON.stringify({ kind: 'harness-blocked', at: Date.now() }) + '\n');
  const letter = store.readAgentMessageLedger(root, 'ws').messages.find(m => m.id === mailId);
  assert.equal(letter.wakeError, '提交失败：进程未在运行', '首次失败必须如实落账');
  assert.ok(!letter.notifiedAt, '首次失败不得假报已通知');
  const attempt1 = records();
  const marker = attempt1.findIndex(r => r.kind === 'harness-blocked');
  assert.ok(marker > 0, 'harness marker recorded');
  assert.ok(!attempt1.slice(0, marker).some(r => r.kind === 'submit'), 'blocked 门必须拦下第一次 Enter（物理层未发出）');
  const typed1 = attempt1.slice(0, marker).filter(r => r.kind === 'typed');
  assert.ok(typed1.length && typed1[typed1.length - 1].len === flat.length, '正文完整残留在输入框中');
  // 空闲边沿触发重试（onLifecycle → scan → request → flush）。
  setLifecycle('idle');
  await until(() => records().some(r => r.kind === 'submit'), 'retry submits once');
  await until(() => store.readAgentMessageLedger(root, 'ws').messages.find(m => m.id === mailId).notifiedAt, 'letter notified after retry');
  const submits = records().filter(r => r.kind === 'submit');
  assert.equal(submits.length, 1, '两次尝试只应有一次物理提交');
  // 红：旧实现重发与残留拼接，submit 文本 = flat + flat。
  assert.equal(submits[0].text, flat, '重试正文不得与输入框残留拼接（TUI 输入框重复文本）');
  const backspaces = records().filter(r => r.kind === 'backspace');
  assert.equal(backspaces.length, flat.length, '重发前必须按残留长度退格清行');
  const notified = store.readAgentMessageLedger(root, 'ws').messages.find(m => m.id === mailId);
  assert.equal(notified.wakeError, undefined, '重试成功后落账清除 wakeError');
  console.log('mailbox-pty-retry-residue: OK (blocked between body and Enter, retry cleared the input line before retyping)');
} finally {
  off();
  for (const terminal of processes) terminal.kill();
  await until(() => !running, 'PTY cleanup');
  fs.rmSync(dir, { recursive: true, force: true });
}
