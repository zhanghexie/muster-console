import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-boundary-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const load = name => import(pathToFileURL(compile(`main/desktop/${name}.ts`)));
  const { DesktopActionGate } = await load('actionGate');
  const { DesktopAuthority } = await load('authority');
  const { DesktopUnknownState } = await load('unknownState');
  const { DesktopDispatchJournal } = await load('dispatchJournal');
  const { UnknownActionChains } = await load('unknownActionChain');
  const { DesktopTaskLock } = await load('taskLock');
  const { DesktopActionIdempotency } = await load('actionIdempotency');
  for (const scenario of ['cancel', 'expired', 'mark-failed', 'mark-failed-after-insert', 'cleanup-failed', 'dispatch-failed']) {
    const dir = path.join(temp, scenario), journal = new DesktopDispatchJournal(path.join(dir, 'journal'));
    const store = new DesktopActionIdempotency(path.join(dir, 'receipts'));
    let clock = 0, failure = true, dispatched = 0;
    let controller = new AbortController();
    const begin = journal.begin.bind(journal);
    journal.begin = async (...args) => {
      const record = await begin(...args);
      if (failure && scenario === 'cancel') controller.abort();
      if (failure && scenario === 'expired') clock = 1000;
      return record;
    };
    if (scenario === 'cleanup-failed') journal.finish = async () => { throw new Error('journal cleanup failed'); };
    const authority = new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['launch'], grantTtlMs: 100,
      now: () => clock, journal, confirmApplication: async () => true, confirmObject: async () => true, audit: async () => {} });
    const gate = new DesktopActionGate(authority, new UnknownActionChains(journal), async () => true, async () => {},
      new DesktopTaskLock(path.join(dir, 'gate-lock')), async () => () => true);
    const request = { taskId: 'task', target: { appId: 'app', processInstance: 'p', surfaceId: 's', surfaceGeneration: 'g' },
      action: 'launch', foreground: true, effect: { kind: 'reversible' } };
    const run = () => store.run('session', 'task', 'same-id', request, () => true, mark =>
      gate.runKnown(request, () => true, async () => { dispatched++; if (scenario === 'dispatch-failed') throw new Error('lost after dispatch'); return 'ok'; }, controller.signal, undefined, (_signal, authorized) => {
        if (!authorized()) throw new Error('authorization changed');
        if (failure && (scenario === 'mark-failed' || scenario === 'cleanup-failed')) throw new Error('receipt write failed');
        mark();
        if (failure && scenario === 'mark-failed-after-insert') throw new Error('receipt write failed after insert');
      }), controller.signal);
    if (scenario === 'cleanup-failed' || scenario === 'dispatch-failed') {
      assert.equal((await run()).outcome, 'unknown', scenario);
      assert.equal((await run()).outcome, 'unknown', `${scenario}: retry remains unknown`);
      assert.equal(dispatched, scenario === 'dispatch-failed' ? 1 : 0, scenario);
      assert.ok(await journal.read('task'), `${scenario}: journal stays unresolved`);
      store.close(); continue;
    }
    await assert.rejects(run());
    assert.equal(dispatched, 0, scenario);
    assert.equal(await journal.read('task'), null, `${scenario}: authority marker cleared`);
    failure = false; controller = new AbortController();
    assert.equal((await run()).outcome, 'dispatched', `${scenario}: same ID succeeds after safe failure`);
    assert.equal(dispatched, 1, scenario);
    store.close();
  }
  console.log('desktop pre-dispatch journal coordination: cancel, expiry and receipt failures passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
