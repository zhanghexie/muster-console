import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-cross-channel-'));
try {
  const compile = createSharedCompiler(process.cwd(), temp);
  const load = async name => import(pathToFileURL(compile(`main/desktop/${name}.ts`)));
  const { DesktopAuthority } = await load('authority');
  const { MediatedBrowserGate } = await load('mediatedBrowserGate');
  const { DesktopDispatchJournal } = await load('dispatchJournal');
  const { DesktopTaskLock } = await load('taskLock');
  const { DesktopUnknownState } = await load('unknownState');
  const journal = new DesktopDispatchJournal(path.join(temp, 'journal'));
  const lock = new DesktopTaskLock(path.join(temp, 'lock'));
  const unknownState = new DesktopUnknownState();
  const actor = { sessionId: 'session', taskId: 'task', isCurrent: () => true };
  assert.throws(() => new DesktopAuthority({ actions: ['click'], grantTtlMs: 1000, journal,
    confirmApplication: async () => true, confirmObject: async () => true, audit: async () => {} }), /Invalid/);
  assert.throws(() => new MediatedBrowserGate(async () => ({ identity: 'tab', isCurrent: () => true }),
    async () => () => true, async () => {}, journal, lock), /Invalid/);
  const authority = new DesktopAuthority({ actions: ['click'], grantTtlMs: 1000, journal, unknownState,
    confirmApplication: async () => true, confirmObject: async () => true, audit: async () => {} });
  const browser = new MediatedBrowserGate(async () => ({ identity: 'tab', isCurrent: () => true }),
    async () => () => true, async () => {}, journal, lock, unknownState);
  assert.equal((await browser.run(actor, 'browser.click', {}, async () => { throw Error('response lost'); })).outcome, 'unknown');
  await assert.rejects(authority.assertTaskAvailable('task'), /reconcile/);
  await assert.rejects(authority.resolveUnknown('task', 'abandoned'), /Browser action/);
  await browser.reconcile(actor, async () => 'confirmed-not-applied');
  await authority.assertTaskAvailable('task');
  const nativeRequest = { taskId: 'task', target: { appId: 'app', processInstance: 'p', surfaceId: 'w', surfaceGeneration: 'g' },
    action: 'click', foreground: true, effect: { kind: 'reversible' } };
  assert.equal((await authority.run(nativeRequest, () => true, async () => { throw Error('response lost'); })).outcome, 'unknown');
  await assert.rejects(browser.run(actor, 'browser.click', {}, async () => 'never'), /reconcile/);
  await assert.rejects(browser.reconcile(actor, async () => 'abandoned'), /another desktop surface/);
  await authority.resolveUnknown('task', 'confirmed-not-applied');
  assert.equal((await browser.run(actor, 'browser.click', {}, async () => 'ok')).outcome, 'completed');
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const running = browser.run(actor, 'browser.click', {}, async () => {
    entered(); await new Promise(resolve => { release = resolve; }); throw Error('response lost');
  });
  await started;
  await assert.rejects(authority.resolveUnknown('task', 'abandoned'), /Browser action/);
  let verified = false;
  const recovery = browser.reconcile(actor, async () => { verified = true; return 'confirmed-not-applied'; });
  assert.equal(verified, false, 'reconciliation cannot finish an in-flight dispatch');
  release(); assert.equal((await running).outcome, 'unknown');
  assert.equal(await recovery, 'confirmed-not-applied');
  await authority.assertTaskAvailable('task');
  console.log('desktop cross-channel recovery passed');
} finally {
  const resolved = fs.realpathSync(temp);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('desktop-cross-channel-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5 });
}
