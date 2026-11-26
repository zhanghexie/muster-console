/** Real executor gates, with only the reviewer and side-effect handlers replaced. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-safety-'));
try {
  const compile = createSharedCompiler(root, tmp);
  const entry = compile('main/capabilities/executor.ts');
  const source = fs.readFileSync(path.join(root, 'src/main/capabilities/executor.ts'), 'utf8');
  for (const [, exports, name] of source.matchAll(/import \{ ([^}]+) \} from '\.\/hosts\/([^']+)';/g)) {
    fs.writeFileSync(path.join(tmp, `main/capabilities/hosts/${name}.mjs`), exports.split(',').map(x => `export const ${x.trim()} = {};`).join('\n'));
  }
  fs.writeFileSync(path.join(tmp, 'main/capabilities/hosts/themes.mjs'), `export const themesHost = {'themes.remove': (ctx,args) => {ctx.effects.push(args); return 'done';}};`);
  fs.writeFileSync(path.join(tmp, 'main/capabilities/hosts/sessions.mjs'), `export const sessionsHost = {'sessions.integrate': (ctx,args) => {ctx.effects.push(args); return 'done';}};`);
  fs.writeFileSync(path.join(tmp, 'main/capabilities/hosts/runtimes.mjs'), `export const runtimesHost = {'runtimes.update': (ctx,args) => {ctx.effects.push(args); return 'done';}};`);
  fs.writeFileSync(path.join(tmp, 'main/capabilities/hosts/services.mjs'), `export const servicesHost = {'automations.update': (ctx,args) => {ctx.effects.push(args); return 'done';}};`);
  fs.writeFileSync(path.join(tmp, 'main/safety/bindings.mjs'), `export async function authorizeSafetyOperation(ctx,input) { ctx.reviews.push(input); return ctx.authorize(input); }`);
  const { safetyRisk } = await import(pathToFileURL(compile('main/safety/policy.ts')).href);
  const risk = (action, args) => safetyRisk({ workspaceId:'ws', source:'catalog', action, args, dangerous:true });
  for (const args of [{id:'runtime',label:'renamed'}, {id:'runtime',label:'renamed',scriptSource:undefined}, {id:'runtime',label:'renamed',summary:'host evidence',confirmNote:'rename'}]) assert.equal(risk('runtimes.update',args),'routine');
  for (const args of [{id:'runtime',scriptSource:'export const driver={}'}, {id:'runtime',enabled:true}, {id:'runtime',integrations:{}}, {preset:{id:'preset'}}]) assert.equal(risk('runtimes.update',args),'high');
  for (const args of [{automationId:'task',name:'renamed'}, {automationId:'task',name:'renamed',prompt:undefined}]) assert.equal(risk('automations.update',args),'routine');
  for (const args of [{automationId:'task',prompt:'new prompt'}, {automationId:'task',schedule:{kind:'daily',time:'09:00'}}, {automationId:'task',runtime:'pi'}]) assert.equal(risk('automations.update',args),'high');
  for (const action of ['themes.remove','sessions.setArchived','automations.setEnabled','automations.delete','runtimes.remove','runtimes.restoreBuiltins','bash','write']) assert.equal(risk(action,{command:'npm test'}),'routine','dangerous metadata alone does not enter approval model');
  assert.equal(risk('sessions.restartConversation',{sessionId:'s1'}),'high','restart discards continuation context and requires review');
  const { executeTool } = await import(pathToFileURL(entry).href);
  const catalog = await import(pathToFileURL(compile('main/capabilities/catalog.ts')).href);
  const effects = [], reviews = [];
  let confirms = 0;
  const ctx = { effects, reviews, resolveBubbleWorkspaceId: () => 'ws',
    ui: { confirm: async () => { confirms++; return { confirmed: true }; } },
    workspaces: { list: () => [] }, isOrchestratorBusy: () => true,
    themes: { list: () => [] }, sessions: { resolveSessionRef: () => { throw Error('missing'); }, list: () => [], get: () => null },
    authorize: async () => ({ allowed: true, reason: 'reviewed' }) };
  assert.equal((await executeTool(ctx, 'themes.run', JSON.stringify({ action: 'remove', params: { id: 'one' } }))).ok, true);
  assert.equal(reviews.length, 0, 'dangerous metadata does not automatically invoke approval model');
  assert.equal(effects.length, 1);
  assert.equal(confirms, 0);
  ctx.authorize = async () => ({ allowed: false, cancelled: true, reason: 'denied' });
  assert.equal((await executeTool(ctx, 'themes.remove', '{"id":"two"}')).ok, true);
  assert.equal(reviews.length, 0);

  const before = effects.length;
  const runtimeDenied = await executeTool(ctx, 'runtimes.run', JSON.stringify({ action: 'update', params: { id: 'fixture', scriptSource: 'export {}' } }));
  assert.equal(runtimeDenied.ok, false, 'AI runtime changes must wait for the reviewer');
  assert.equal(reviews.at(-1).action, 'runtimes.update');
  const automationDenied = await executeTool(ctx, 'automations.run', JSON.stringify({ action: 'update', params: { automationId: 'fixture', prompt: 'new instructions' } }));
  assert.equal(automationDenied.ok, false, 'AI task changes must wait for the reviewer');
  assert.equal(reviews.at(-1).action, 'automations.update');
  assert.equal(effects.length, before, 'a denied review cannot reach either side-effect handler');

  const { applyLocaleSetting } = await import(pathToFileURL(compile('shared/i18n/index.ts')).href);
  const signal = new AbortController().signal;
  const originalReason = '审批代理需要人工确认：原始理由';
  let display;
  ctx.ui.confirm = async (title, body, options) => { display = { title, body, options }; return { confirmed: false }; };
  ctx.authorize = async operation => ({ allowed: await operation.humanConfirm(originalReason, signal), reason: originalReason });
  applyLocaleSetting('en');
  try {
    const result = await executeTool(ctx, 'runtimes.update', JSON.stringify({ id: 'fixture', scriptSource: 'export {}' }));
    assert.equal(result.ok, false);
    assert.match(display.body, /^The approval agent requires human confirmation: 原始理由/);
    assert.equal(display.options.confirmNote, 'The approval agent requires human confirmation: 原始理由');
    assert.equal(display.options.signal, signal);
    assert.equal(reviews.at(-1).args.scriptSource, 'export {}');
    assert.equal(result.error, originalReason, 'the decision keeps its original reason');
    assert.equal(effects.length, before, 'rejecting the translated confirmation has no side effects');
  } finally { applyLocaleSetting('zh-CN'); }

  // Extension package review happens before publication; identical global versions,
  // rejected reviews and changed bytes are covered by extensions-review.mjs.
  console.log('ok capability-safety-gates');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
