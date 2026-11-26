import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-bindings-'));
const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
const { createSafetyServiceForContext, authorizeSafetyOperation } = await import(pathToFileURL(compile('main/safety/bindings.ts')));
const config = { workspaces: [{ id: 'w', name: 'Fixture', path: '/fixture' }] };
const confirms = [];
const ctx = { config: { get: () => config }, sessions: { peek: () => undefined }, orchestrator: null, resolveBubbleWorkspaceId: () => 'w', ui: { confirm: async (...args) => { confirms.push(args); return { confirmed: true }; } } };
const op = () => ({ workspaceId: 'w', source: 'catalog', action: 'extensions.trust', args: { extensionId: 'fixture', apiKey: 'PRIVATE-FIXTURE-KEY' }, targetFingerprint: 'package-v1' });
try {
  // Missing service still provides an actual human gate instead of a hidden wait.
  const missing = await authorizeSafetyOperation(ctx, op());
  assert.equal(missing.allowed, true); assert.equal(missing.escalated, true); assert.equal(confirms.length, 1);
  assert.equal(confirms[0][2].signal.aborted, true); assert.equal(JSON.stringify(confirms[0]).includes('PRIVATE-FIXTURE-KEY'), false);
  // Service exists but the model is unavailable: same default gate, no custom callback required.
  ctx.safety = createSafetyServiceForContext(ctx, { userDataPath: tmp });
  const unavailable = await authorizeSafetyOperation(ctx, op());
  assert.equal(unavailable.allowed, true); assert.equal(unavailable.escalated, true); assert.equal(confirms.length, 2);
  assert.match(confirms[1][2].confirmNote, /模型|凭据/);
  assert.equal(ctx.safety.snapshot('w').records.at(-1).status, 'allowed');
  const rename = fs.renameSync, write = fs.writeFileSync;
  let failures = 0, privateMode = false;
  try {
    fs.writeFileSync = (target, content, options) => { if (String(target).includes('conversation.json')) privateMode ||= options?.mode === 0o600; return write(target, content, options); };
    fs.renameSync = (source, target) => { if (String(target).endsWith('conversation.json') && failures++ < 2) throw Object.assign(new Error('fixture sharing violation'), { code: 'EPERM' }); return rename(source, target); };
    const retry = await authorizeSafetyOperation(ctx, op());
    assert.equal(retry.allowed, true); assert.equal(privateMode, true, 'atomic retry retains private file mode');
    fs.renameSync = (source, target) => { if (String(target).endsWith('conversation.json')) throw Object.assign(new Error('fixture persistent disk lock'), { code: 'EBUSY' }); return rename(source, target); };
    const manual = await authorizeSafetyOperation(ctx, op());
    assert.equal(manual.allowed, true); assert.equal(manual.escalated, true); assert.equal(manual.auditUnavailable, true);
    assert.match(confirms.at(-1)[2].confirmNote, /记录.*无法保存/);
    assert.equal(confirms.at(-1)[2].signal.aborted, true);
    assert.equal(ctx.safety.snapshot('w').records.at(-1).status, 'failed', 'failed persistence is never presented as a stored model permit');
  } finally { fs.renameSync = rename; fs.writeFileSync = write; }
  try { ctx.safety.dispose(); } catch {} ctx.safety = null;
  for (const accepted of [true, false]) {
    const id = `final-human-${accepted}`;
    config.workspaces.push({ id, name: id, path: '/fixture' });
    ctx.safety = createSafetyServiceForContext(ctx, { userDataPath: tmp });
    let prompts = 0;
    ctx.ui.confirm = async () => {
      prompts++;
      fs.renameSync = (source, target) => { if (String(target).endsWith('conversation.json')) throw Object.assign(new Error('audit failed after human decision'), { code: 'EBUSY' }); return rename(source, target); };
      return { confirmed: accepted };
    };
    try {
      const result = await authorizeSafetyOperation(ctx, { ...op(), workspaceId: id });
      assert.equal(result.allowed, accepted, 'an explicit human decision remains final even if recording it fails');
      assert.equal(result.humanDecision, accepted); assert.equal(prompts, 1, 'never ask the human to decide the same request twice');
    } finally { fs.renameSync = rename; try { ctx.safety.dispose(); } catch {} ctx.safety = null; }
  }
  let resolveHuman, signal;
  ctx.ui.confirm = async (_title, _detail, options) => { signal = options.signal; return new Promise(resolve => { resolveHuman = resolve; }); };
  const stale = authorizeSafetyOperation(ctx, op());
  while (!resolveHuman) await new Promise(resolve => setTimeout(resolve, 0));
  config.workspaces[0].path = '/changed';
  const outcome = await stale;
  assert.equal(outcome.allowed, false); assert.equal(outcome.cancelled, true); assert.equal(signal.aborted, true);
  resolveHuman({ confirmed: true });
  console.log('default safety human gate and scope invalidation passed');
} finally { try { ctx.safety?.dispose(); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); }
