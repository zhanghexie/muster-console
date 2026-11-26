import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'cua-semantic-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { CuaSemanticSession } = await import(pathToFileURL(compile('main/desktop/cuaSemanticSession.ts')));
  const { DesktopCoordinator } = await import(pathToFileURL(compile('main/desktop/desktopCoordinator.ts')));
  const calls = [];
  let pending;
  let pendingAction;
  let actionResult = { isError: false };
  const driver = { async call(name, args) {
    calls.push({ name, args });
    if (name !== 'get_window_state') return pendingAction ? await pendingAction : actionResult;
    if (pending) return await pending;
    return { structuredContent: { pid: 12, window_id: 34, snapshot_id: 's00000001', elements_complete: true, elements: [
      { element_token: 's00000001:0', role: 'Button', label: 'Open', enabled: true, actions: ['invoke'] }
    ] } };
  } };
  let current = true;
  const session = new CuaSemanticSession(driver, 'surface', 'generation', 12, 34, () => current, 'mode-parameter');
  const first = await session.observe();
  assert.equal(first.elements[0].label, 'Open');
  assert.equal(JSON.stringify(first).includes('s00000001:0'), false);
  await session.act(first.snapshotId, first.elements[0].ref, 'click');
  assert.equal(calls[1].args.element_token, 's00000001:0');
  await assert.rejects(session.act(first.snapshotId, first.elements[0].ref, 'click'), /Observe/);
  const second = await session.observe();
  await session.observe();
  await assert.rejects(session.act(second.snapshotId, second.elements[0].ref, 'click'), /Stale/);
  const third = await session.observe();
  await assert.rejects(session.act(third.snapshotId, third.elements[0].ref, 'set_value', 'x'.repeat(4097)), /Invalid/);
  await session.act(third.snapshotId, third.elements[0].ref, 'set_value', 'example');
  assert.equal(calls.at(-1).args.value, 'example');
  assert.equal(calls.at(-1).args.delivery_mode, 'background');
  const fourth = await session.observe();
  await session.act(fourth.snapshotId, fourth.elements[0].ref, 'click', undefined, undefined, 'foreground');
  assert.equal(calls.at(-1).args.delivery_mode, 'foreground');
  const fifth = await session.observe();
  let completeAction;
  pendingAction = new Promise(resolve => { completeAction = resolve; });
  const action = session.act(fifth.snapshotId, fifth.elements[0].ref, 'click');
  await assert.rejects(session.observe(), /action still in progress/);
  completeAction({ isError: false });
  await action;
  pendingAction = undefined;
  const sixth = await session.observe();
  current = false;
  await assert.rejects(session.act(sixth.snapshotId, sixth.elements[0].ref, 'click'), /target changed/);
  current = true;
  await assert.rejects(session.act(sixth.snapshotId, sixth.elements[0].ref, 'click'), /Observe/);
  let resolve;
  pending = new Promise(r => { resolve = r; });
  const slow = session.observe();
  await assert.rejects(session.observe(), /already in progress/);
  session.close();
  resolve({ structuredContent: { pid: 12, window_id: 34, snapshot_id: 's00000002', elements: [] } });
  await assert.rejects(slow, /closed/);
  const wrongTarget = new CuaSemanticSession({ call: async () => ({ structuredContent: {
    pid: 99, window_id: 34, snapshot_id: 's00000001', elements: []
  } }) }, 'other', 'generation', 12, 34, () => true, 'mode-parameter');
  await assert.rejects(wrongTarget.observe(), /Invalid Cua semantic observation/);
  const backgroundOnly = new CuaSemanticSession(driver, 'mac-surface', 'generation', 12, 34, () => true, 'background-only');
  pending = undefined;
  const macSnapshot = await backgroundOnly.observe();
  await assert.rejects(backgroundOnly.act(macSnapshot.snapshotId, macSnapshot.elements[0].ref, 'set_value', 'x', undefined, 'foreground'), /not supported/);
  await backgroundOnly.act(macSnapshot.snapshotId, macSnapshot.elements[0].ref, 'set_value', 'x');
  assert.equal('delivery_mode' in calls.at(-1).args, false, 'background-only schema must not receive a delivery mode');
  const limitedDriver = { async call(name, args) {
    calls.push({ name, args });
    if (name !== 'get_window_state') return { isError: false };
    return { structuredContent: { pid: 12, window_id: 34, snapshot_id: 's00000003', elements_complete: true, elements: [
      { element_token: 's00000003:0', role: 'Button', label: 'Open', actions: ['invoke', 'set_value'] }
    ] } };
  } };
  const limited = new CuaSemanticSession(limitedDriver, 'limited', 'generation', 12, 34, () => true, 'unavailable');
  const limitedPage = await limited.observe();
  assert.ok(limitedPage.limitations.includes('semantic_set_value_unavailable'));
  assert.deepEqual(limitedPage.elements[0].actions, ['invoke']);
  const beforeUnsupported = calls.length;
  await assert.rejects(limited.act(limitedPage.snapshotId, limitedPage.elements[0].ref, 'set_value', 'x'), /not supported/);
  assert.equal(calls.length, beforeUnsupported, 'unsupported set_value must never reach the driver');
  await limited.act(limitedPage.snapshotId, limitedPage.elements[0].ref, 'click');
  for (const effect of ['refused', 'not_applied']) {
    actionResult = { isError: true, structuredContent: { effect, code: 'backend_refused', pid: 12, window_id: 34, path: 'private' } };
    const observation = await backgroundOnly.observe();
    const result = await backgroundOnly.act(observation.snapshotId, observation.elements[0].ref, 'click');
    assert.deepEqual(result, { ok: false, delivery: 'unknown', effect, verification: 'not_performed', code: 'backend_refused' });
    assert.equal(JSON.stringify(result).includes('window_id'), false);
  }
  actionResult = { isError: true, structuredContent: { effect: 'partial', code: 'part_done' } };
  const partial = await backgroundOnly.observe();
  await assert.rejects(backgroundOnly.act(partial.snapshotId, partial.elements[0].ref, 'click'), error =>
    error.name === 'CuaUncertainActionError' && error.outcome.effect === 'partial');
  actionResult = { isError: false, structuredContent: { effect: 'suspected_noop' } };
  const noOp = await backgroundOnly.observe();
  await assert.rejects(backgroundOnly.act(noOp.snapshotId, noOp.elements[0].ref, 'click'), error =>
    error.name === 'CuaUncertainActionError' && error.outcome.effect === 'suspected_noop');
  actionResult = { isError: false, structuredContent: { effect: 'confirmed' } };
  const confirmed = await backgroundOnly.observe();
  assert.deepEqual(await backgroundOnly.act(confirmed.snapshotId, confirmed.elements[0].ref, 'click'),
    { ok: true, delivery: 'unknown', effect: 'confirmed', verification: 'not_performed' });
  actionResult = { isError: true, structuredContent: { effect: 'confirmed' } };
  const conflicting = await backgroundOnly.observe();
  await assert.rejects(backgroundOnly.act(conflicting.snapshotId, conflicting.elements[0].ref, 'click'), error =>
    error.name === 'CuaUncertainActionError' && error.outcome.effect === 'unknown');
  const many = new CuaSemanticSession({ call: async () => ({ structuredContent: { pid: 12, window_id: 34,
    snapshot_id: 's00000003', elements_complete: true, elements: Array.from({ length: 500 }, (_, index) => ({
      element_token: `s00000003:${index}`, role: 'Button', label: '\u0000'.repeat(256), value: 'v'.repeat(256), actions: ['invoke']
    })) } }) }, 'large', 'generation', 12, 34, () => true, 'mode-parameter');
  let page = await many.observe(), count = 0;
  const largeId = page.snapshotId;
  while (true) {
    assert.ok(JSON.stringify({ ok: true, result: page }).length < 12000, 'a page must fit the host result envelope');
    count += page.elements.length;
    if (page.nextOffset === null) break;
    assert.equal(page.complete, false);
    page = many.page(largeId, page.nextOffset);
  }
  assert.equal(count, 500, 'all captured elements must remain accessible through pages');
  assert.equal(page.complete, true);
  await many.observe();
  assert.throws(() => many.page(largeId, 0), /Stale/);
  const degraded = new CuaSemanticSession({ call: async () => ({ structuredContent: { pid: 12, window_id: 34,
    elements: [{ role: 'StaticText', label: 'Read only' }], elements_complete: false, truncated: true } }) },
  'degraded', 'generation', 12, 34, () => true, 'mode-parameter');
  const readOnly = await degraded.observe();
  assert.equal(readOnly.elements[0].label, 'Read only');
  assert.equal(readOnly.elements[0].ref, undefined);
  assert.deepEqual(readOnly.limitations, ['semantic_values_redacted', 'input_label_provenance_unverified', 'semantic_refs_unavailable']);
  assert.equal(readOnly.operable, false);
  assert.equal(readOnly.complete, false);
  await assert.rejects(degraded.act(readOnly.snapshotId, 'fake', 'click'), /Observe/);
  const privateValue = 'synthetic-private-value';
  const privateSession = new CuaSemanticSession({ call: async () => ({ structuredContent: { pid: 12, window_id: 34,
    snapshot_id: 's00000005', elements_complete: true, elements: [
      { element_token: 's00000005:0', role: 'Password', label: privateValue, value: privateValue, is_password: true },
      { element_token: 's00000005:1', role: 'Edit', label: 'Account password', value: privateValue, actions: ['set_value'] },
      { element_token: 's00000005:2', role: 'AXSecureTextField', label: privateValue },
      { element_token: 's00000005:3', role: 'Button', label: 'Confirm ' + privateValue, value: privateValue },
      { element_token: 's00000005:4', role: 'Button', label: 'Save' }
    ] } }) }, 'privacy', 'generation', 12, 34, () => true, 'mode-parameter');
  const safe = await privateSession.observe();
  assert.equal(JSON.stringify(safe).includes(privateValue), false, 'values and value-derived labels must not leak');
  assert.equal(safe.elements[4].label, 'Save', 'ordinary button labels remain usable');
  assert.equal(safe.elements[0].value, undefined);
  assert.equal(safe.elements[0].label, undefined);
  assert.equal(safe.elements[2].label, undefined, 'secure labels with unknown provenance must not be disclosed');
  assert.ok(safe.limitations.includes('semantic_values_redacted'));
  const malformedSecurity = new CuaSemanticSession({ call: async () => ({ structuredContent: { pid: 12, window_id: 34,
    elements: [{ role: 'Edit', is_password: 'false' }] } }) }, 'malformed-security', 'generation', 12, 34, () => true, 'mode-parameter');
  await assert.rejects(malformedSecurity.observe(), /Invalid Cua semantic element/);
  let resolvePartial, startedPartial;
  const partialStarted = new Promise(resolve => { startedPartial = resolve; });
  const partialDriver = { call: async name => name === 'get_window_state' ? { structuredContent: { pid: 12, window_id: 34,
    snapshot_id: 's00000004', elements: [{ element_token: 's00000004:0', role: 'Button' }] } } :
    new Promise(resolve => { resolvePartial = resolve; startedPartial(); }) };
  const guarded = new CuaSemanticSession(partialDriver, 'guarded', 'generation', 12, 34, () => true, 'mode-parameter');
  const guardedSnapshot = await guarded.observe();
  const coordinator = new DesktopCoordinator(async () => {}, () => {});
  const run = await coordinator.start('worker');
  const attempted = coordinator.execute('worker', run, signal => guarded.act(guardedSnapshot.snapshotId, guardedSnapshot.elements[0].ref, 'click', undefined, signal));
  const attemptedResult = attempted.catch(error => error);
  await partialStarted;
  let queuedRan = false;
  const queued = coordinator.execute('worker', run, async () => { queuedRan = true; }).catch(error => error);
  resolvePartial({ isError: true, structuredContent: { effect: 'partial' } });
  assert.equal((await attemptedResult).name, 'CuaUncertainActionError');
  assert.ok(await queued);
  assert.equal(queuedRan, false, 'partial backend effect must abort same-turn queued work');
  console.log('Cua semantic session: opaque refs, stale observations and closed session passed');
} finally { removeWorkspaceFixture(temp, 'cua-semantic-'); }
