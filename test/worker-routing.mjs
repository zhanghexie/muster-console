import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-routing-'));
const workspace = path.join(tmp, 'source');
const nested = path.join(workspace, 'nested');
fs.mkdirSync(nested, { recursive: true });
const require = createRequire(import.meta.url);
const ts = require('typescript');
const Module = require('node:module');
const originalLoad = Module._load;
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename
}).outputText, filename);
Module._load = function (request, parent) {
  if (request === 'electron') return { app: { getPath: () => tmp, isReady: () => true }, ipcMain: { on() {}, handle() {} } };
  if (parent?.filename === path.join(root, 'src/main/tasks/delegate.ts') && request === '../capabilities/hosts/chat') {
    return { buildBriefWithNamedSkills: async (_ctx, _id, task) => ({ brief: task, vocab: [] }) };
  }
  return originalLoad.apply(this, arguments);
};
const load = file => require(path.join(root, 'src', file));

try {
  const { ConfigManager } = load('main/config.ts');
  const config = new ConfigManager();
  const provider = (id, apiKey) => ({ id, name: id, baseUrl: 'http://127.0.0.1:1/v1', apiKey, models: [{ id: 'same-id', name: 'Shared name' }] });
  config.update({ workspace, workspaces: [{ id: 'ws', name: 'Fixture', path: workspace, openedAt: 1,
    roots: [{ id: 'root', path: workspace }], defaultRootId: 'root' }], activeWorkspaceId: 'ws',
    llm: { providers: [provider('first', 'fixture-a'), provider('second', 'fixture-b')], activeProviderId: 'first', activeModelId: 'same-id' },
    modelParameterProfiles: [{ runtimeId: 'pi', providerId: 'first', modelId: 'same-id', parameters: {
      reasoning: { options: [{ value: 'fast', label: 'Fast', mappedValue: 'low' }, { value: 'low', label: 'Deliberate', mappedValue: 'high' }] }
    } }] });
  const { resolveSessionTarget } = load('main/sessions/targets.ts');
  const { readWorkerNativeCatalog } = load('main/tasks/workerRoutingCatalog.ts');
  const { assertWorkerRouteCurrent, captureWorkerRoute, clearRoutingCooldown, followGlobalWorkerRouting, mintWorkerReference,
    parseWorkerRoutingConfig, readWorkerRoutingConfig, routingSettings, saveWorkerRoutingSettings, summarizeWorkerRoutingTiers,
    validateWorkerReference } = load('main/tasks/workerRouting.ts');
  const { classifyWorkerRuntimeFailure, cooldownFor, recordWorkerCooldown, resetWorkerCooldown } = load('main/tasks/workerRoutingPolicy.ts');
  const { schedulerProjectedCatalog, workerPresetProjectedCatalog } = load('main/capabilities/catalog/projectedCatalog.ts');
  const { assertToolArguments } = load('main/capabilities/schemaValidation.ts');
  const { workerOptionsHost } = load('main/capabilities/hosts/workerOptions.ts');
  const { createSessionWithTask } = load('main/capabilities/hosts/creation.ts');
  const { runAsAgentSession, runAsAgentWorkspace, runAsSchedulerTool } = load('main/agent/agentScope.ts');
  const { delegateTask } = load('main/tasks/delegate.ts');
  const { RuntimePreflightError } = load('shared/runtimePreflight.ts');
  const { recoverWorkerRouteAfterRestart } = load('shared/workerRouting.ts');
  const { setAgentMessagesUserDataDir, readAgentMessageLedger } = load('main/metaAgent/messageStore.ts');
  const { harnessModelId, harnessModelSelectionKey } = load('shared/harnessModelSelection.ts');
  setAgentMessagesUserDataDir(tmp);
  const runtimes = [{ id: 'pi', enabled: true, surface: 'chat' }, { id: 'codex-gui', enabled: true, surface: 'chat' }];
  const identity = { harnessId: 'muster-core', runtimeId: 'pi', surface: 'gui' };
  const targetConfig = (id, modelParameters) => ({ ...identity, model: { providerId: id, modelId: 'same-id' }, ...(modelParameters ? { modelParameters } : {}) });
  let visible = {};
  const rows = [];
  const ctx = {
    config, resolveBubbleWorkspaceId: () => 'ws', getWindow: () => null, workspaces: { list: () => config.get().workspaces },
    runtimes: { get: id => runtimes.find(runtime => runtime.id === id), list: () => runtimes },
    sessions: { list: () => rows, listByWorkspace: () => rows, get: id => rows.find(session => session.id === id),
      isChatRuntime: id => id === 'pi' || id === 'codex-gui', ensureStatusToken() {}, clearDonePhase() {}, broadcastMessagesChanged() {} },
    agentSessions: { modelAdmission: { selections: { read: () => visible } }, getDriver: () => undefined,
      validateLaunchModel: async () => {}, describeModelParameters: async request => ({ runtimeId: 'pi', providerId: request.providerId,
        modelId: request.modelId, parameters: [{ id: 'reasoning', semantic: 'reasoning', label: 'Reasoning', apply: 'next-turn', supportsDefault: true,
          options: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] }] }) }
  };
  const source = await resolveSessionTarget(config.get(), { workspaceId: 'ws', rootId: 'root' });
  const readWorkspace = () => routingSettings(ctx, source, 'workspace');
  const saveWorkspace = (draft, baseline) => saveWorkerRoutingSettings(ctx, source, { layer: 'workspace', expectedVersion: baseline.version, config: draft });
  visible = { [harnessModelSelectionKey('pi')]: [harnessModelId('pi', 'second', 'same-id')] };
  assert.deepEqual((await readWorkerNativeCatalog(ctx, identity, source)).items.map(item => item.providerId), ['second']);
  await assert.rejects(mintWorkerReference(ctx, source, targetConfig('first')), /missing.*catalog|disabled/);
  visible = {};
  const first = await mintWorkerReference(ctx, source, targetConfig('first', { reasoning: 'fast' }));
  const second = await mintWorkerReference(ctx, source, targetConfig('second', { reasoning: 'high' }));
  assert.match(first.targetRef, /^wr1\.[A-Za-z0-9_-]{32}$/);
  assert.notEqual(first.targetRef, second.targetRef, 'same model name under another provider retains distinct identity');
  assert.deepEqual(first.config.modelParameters, { reasoning: 'low' }, 'raw alias is mapped to a native value');
  assert.deepEqual(await validateWorkerReference(ctx, source, first.targetRef), first, 'canonical low must not be read back as alias low→high');
  const subfolder = await resolveSessionTarget(config.get(), { workspaceId: 'ws', rootId: 'root', cwd: nested });
  await assert.rejects(validateWorkerReference(ctx, subfolder, first.targetRef), /different or outdated source/);
  await assert.rejects(validateWorkerReference(ctx, source, `wr1.${'z'.repeat(32)}`), /expired|installation/);
  const unknown = await readWorkerNativeCatalog(ctx, { harnessId: 'codex', runtimeId: 'codex-gui', surface: 'gui' }, source);
  assert.equal(unknown.state, 'unknown');
  assert.deepEqual(unknown.items, []);
  const member = (id, reference, enabled = true) => ({ id, enabled, config: reference.config });
  const tier = (id, members, fallbackTierIds = []) => ({ id, name: id, description: `Choose ${id} by task difficulty`, members, fallbackTierIds });
  const initial = { revision: 0, tiers: [tier('light', [member('first', first), member('second', second)]), tier('hard', [member('hard-1', second), member('hard-2', first, false)])] };
  const blank = await readWorkspace();
  const saved = await saveWorkspace(initial, blank);
  assert.equal(saved.config.revision, 1);
  assert.deepEqual(readWorkerRoutingConfig(new ConfigManager().get(), 'ws'), saved.config, 'settings survive reloading the public app config');
  assert.ok(new ConfigManager().get().modelParameterProfiles.length, 'routing saves retain model parameter aliases across restart');
  assert.equal(config.getRedacted().workerRoutingByWorkspace, undefined, 'generic model config does not expose all workspaces’ pool members');
  await assert.rejects(saveWorkspace(initial, blank), /Reload/);
  await assert.rejects(saveWorkspace({ revision: 1, tiers: [tier('light', [], ['hard']), tier('hard', [], ['light'])] }, saved), /cycle/);
  const captured = await captureWorkerRoute(ctx, source, { tierId: 'light' });
  assert.deepEqual(captured.candidates.map(item => item.memberId), ['first', 'second']);

  const schema = schedulerProjectedCatalog().find(entry => entry.name === 'host.sessions.create').def.parameters;
  assertToolArguments(schema, { task: 'task', isolation: 'shared', target: { tierId: 'light' } }, 'host.sessions.create');
  assert.throws(() => assertToolArguments(schema, { task: 'task', isolation: 'shared', runtime: 'codex', cliLaunchOptions: { model: 'same-id', reasoning: 'high' } }, 'host.sessions.create'), /Invalid parameters/);
  assert.throws(() => assertToolArguments(schema, { task: 'task', isolation: 'shared', target: { tierId: 'light', targetRef: first.targetRef } }, 'host.sessions.create'), /Invalid parameters/);
  assert.equal(Object.hasOwn(schema.properties, 'crossHarness'), false, 'model schema does not advertise consent');
  assert.throws(() => createSessionWithTask(ctx, { task: 'task', isolation: 'shared', target: { tierId: 'light' }, crossHarness: { binding: 'forged' } }), /managed in Settings/);
  for (const surface of ['gui-full', 'acp-subset', 'pty-allowlist']) {
    const catalog = workerPresetProjectedCatalog(surface, true);
    assert.ok(catalog.some(entry => entry.name === 'host.workers.options'), surface);
    assert.ok(!catalog.some(entry => entry.name === 'host.runtimes.run'), surface);
  }
  assert.throws(() => createSessionWithTask(ctx, { task: 'task', isolation: 'shared', target: { tierId: 'light' }, model: { providerId: 'first', modelId: 'same-id' } }), /raw model/);
  await assert.rejects(runAsSchedulerTool(async () => createSessionWithTask(ctx, { task: 'task', isolation: 'shared' })), /Choose a Worker tier/);
  const options = await workerOptionsHost['workers.options'](ctx, {});
  assert.deepEqual(options.tiers.map(t => [t.tierId, t.enabledCandidates]), [['light', 2], ['hard', 1]]);
  await assert.rejects(runAsAgentSession('deleted', () => workerOptionsHost['workers.options'](ctx, {})), /no longer exists/);

  assert.equal(classifyWorkerRuntimeFailure({ status: 429 }).reason, 'rate-limit');
  assert.deepEqual(classifyWorkerRuntimeFailure({ status: 429, retryAfterMs: 250, error: { code: 'insufficient_quota', scope: 'account' } }),
    { reason: 'quota', retryAfterMs: 250, scope: 'account' });
  assert.equal(classifyWorkerRuntimeFailure(new Error('429 quota and ECONNRESET')), undefined, 'prose and unknown delivery never become structured quota');
  const accountPeer = { ...first.config, modelParameters: { reasoning: 'high' } };
  recordWorkerCooldown(ctx, source, first.config, { reason: 'quota', scope: 'account' }, 100, 1000);
  assert.equal(cooldownFor(ctx, source, accountPeer, 110)?.reason, 'quota');
  assert.equal(cooldownFor(ctx, source, second.config, 110), undefined, 'same display model and endpoint do not share different credentials');
  assert.equal(cooldownFor(ctx, source, first.config, 900_101), undefined, 'a cooldown expires using elapsed time');
  recordWorkerCooldown(ctx, source, first.config, { reason: 'rate-limit' });
  resetWorkerCooldown(ctx, source, first.config);
  assert.equal(cooldownFor(ctx, source, first.config), undefined);

  const starts = [], submittedTasks = [];
  ctx.agentSessions.send = async (sessionId, text) => { submittedTasks.push({ sessionId, text }); return { ok: true }; };
  ctx.sessions.createTerminal = async input => {
    starts.push(input);
    if (input.inheritMeta.modelOverride.providerId === 'first') throw new RuntimePreflightError({
      id: 'pi', surface: 'chat', ok: false, status: 'not_configured', problems: [{ code: 'config_missing', message: 'Fixture unavailable' }], checkedAt: Date.now()
    });
    const session = { ...input, id: input.reservedSessionId, type: 'terminal', launchKind: 'agent', lifecycle: 'idle', sourceRoot: input.capturedSource };
    rows.push(session);
    return session;
  };
  const result = await delegateTask(ctx, { task: 'One logical task', workspaceId: 'ws', isolate: false, target: { tierId: 'light' }, select: false, notifyOrchestrator: false });
  assert.deepEqual(starts.map(input => input.inheritMeta.modelOverride.providerId), ['first', 'second']);
  assert.equal(starts[0].reservedSessionId, starts[1].reservedSessionId);
  assert.equal(rows.length, 1);
  assert.deepEqual(submittedTasks, [{ sessionId: rows[0].id, text: 'One logical task' }], 'only the committed GUI Worker receives the first task');
  assert.equal(readAgentMessageLedger(workspace, 'ws').messages.length, 0, 'a new GUI task does not duplicate its first input in the mailbox');
  assert.equal(result.routing.attempt, 2);
  assert.equal(result.routing.reason, 'engine-unavailable');
  assert.equal(result.routing.nativeConfirmed, undefined);
  assert.equal(result.status, 'starting');
  const restored = recoverWorkerRouteAfterRestart(result.session.workerRouting);
  assert.equal(restored.phase, 'blocked');
  assert.equal(restored.reason, 'delivery-unknown');
  assert.equal(restored.attempts.length, 2, 'recovery retains attempt history without allocating a new Worker');
  assert.equal(result.session.workerRouting.phase, 'starting', 'readback recovery does not mutate the original snapshot');

  const reordered = { revision: 1, tiers: [tier('light', [member('second', second, false), member('first', first)], ['hard']), tier('hard', [member('hard-1', second)])] };
  const newSettings = await saveWorkspace(reordered, saved);
  assert.equal(newSettings.config.revision, 2);
  assert.deepEqual(newSettings.config.tiers[0].members.map(candidate => [candidate.id, candidate.enabled]), [['second', false], ['first', true]]);
  assert.throws(() => assertWorkerRouteCurrent(ctx, source, captured), /changed while.*pending/);
  assert.deepEqual((await captureWorkerRoute(ctx, source, { tierId: 'light' })).candidates.map(item => item.memberId), ['first', 'hard-1']);

  const codexConsent = { nativeConfig: { identity: { runtimeId: 'codex-gui', sourceKey: 'fixture-source', version: 'fixture-version' }, selections: [
    { id: 'permissions', value: ':workspace' }, { id: 'approvalPolicy', value: 'on-request' }, { id: 'approvalsReviewer', value: 'user' }
  ] }, binding: `wp1.${'a'.repeat(64)}.${'b'.repeat(64)}` };
  const legacy = { revision: 10, tiers: [
    { ...tier('original-light', [member('first', first), member('second', second)], ['review', 'original-complex']), name: '轻量' },
    { ...tier('original-complex', [member('high-model', second)]), name: 'Complex tasks' },
    { ...tier('review', [{ id: 'approved-member', enabled: false, config: { harnessId: 'codex', runtimeId: 'codex-gui', surface: 'gui',
      model: { providerId: 'codex-gui', modelId: 'fixture-codex' } }, crossHarness: codexConsent }]), name: 'Review' }
  ] };
  config.update({ workerRoutingByWorkspace: { ws: legacy } });
  const configFile = config.filePath;
  const beforeRead = fs.readFileSync(configFile, 'utf8');
  const projected = await readWorkspace();
  assert.deepEqual(projected.config.tiers.map(({ kind }) => kind), ['low', 'high', 'special']);
  assert.deepEqual(projected.config.tiers.map(({ kind: _kind, ...original }) => original), legacy.tiers);
  assert.equal(projected.config.revision, 10);
  assert.equal(fs.readFileSync(configFile, 'utf8'), beforeRead, 'legacy classification is a read-only projection');
  const noMedium = await workerOptionsHost['workers.options'](ctx, {});
  assert.deepEqual(noMedium.tiers.map(({ tierId, kind }) => [tierId, kind]), [
    ['original-light', 'low'], ['original-complex', 'high'], ['review', 'special']
  ]);

  const cases = { revision: 0, tiers: [
    { ...tier('first-alias', []), name: '轻量' }, { ...tier('second-alias', []), name: 'Lightweight' },
    { ...tier('explicit-high', []), kind: 'high' }, { ...tier('occupied-alias', []), name: '攻坚' },
    { ...tier('ordinary-name', []), name: '中' }, { ...tier('explicit-special', []), name: 'Complex tasks', kind: 'special' }
  ] };
  assert.deepEqual(parseWorkerRoutingConfig(cases).tiers.map(({ kind }) => kind), ['special', 'special', 'high', 'special', 'special', 'special']);
  assert.deepEqual(parseWorkerRoutingConfig({ revision: 0, tiers: [
    { ...tier('english-light', []), name: 'Lightweight' }, { ...tier('chinese-complex', []), name: '攻坚' }
  ] }).tiers.map(({ kind }) => kind), ['low', 'high']);
  assert.throws(() => parseWorkerRoutingConfig({ ...cases, tiers: [{ ...tier('invalid-kind', []), kind: 'urgent' }] }), /classification/);
  assert.throws(() => parseWorkerRoutingConfig({ ...cases, tiers: [
    { ...tier('first-medium', []), kind: 'medium' }, { ...tier('second-medium', []), kind: 'medium' }
  ] }), /one pool/);

  const legacyClient = { ...legacy, tiers: [
    { ...legacy.tiers[0], name: 'Renamed low' }, { ...legacy.tiers[1], name: 'Renamed high' }, { ...legacy.tiers[2], name: '轻量' }
  ] };
  await assert.rejects(saveWorkspace({ ...legacyClient, tiers: [
    ...legacyClient.tiers, { ...tier('new-low', []), kind: 'low' }
  ] }, projected), /one pool/, 'an explicitly conflicting kind must not displace a previous kind omitted by an old client');
  const beforeKinds = await captureWorkerRoute(ctx, source, { tierId: 'original-light' });
  const persisted = await saveWorkspace(legacyClient, projected);
  assert.equal(persisted.config.revision, 11);
  assert.deepEqual(persisted.config.tiers.map(({ kind }) => kind), ['low', 'high', 'special'], 'existing kinds follow IDs even if the client renames pools');
  assert.deepEqual(persisted.config.tiers.map(({ kind: _kind, ...original }) => original), legacyClient.tiers);
  assert.deepEqual(new ConfigManager().get().workerRoutingByWorkspace.ws, persisted.config, 'classification is written only by the existing CAS save');
  await assert.rejects(saveWorkspace(legacyClient, projected), /Reload/);
  const classified = await saveWorkspace({ ...persisted.config, tiers: persisted.config.tiers.map(item =>
    item.id === 'review' ? { ...item, kind: 'medium' } : item) }, persisted);
  assert.deepEqual(classified.config.tiers.find(item => item.id === 'review'), { ...persisted.config.tiers[2], kind: 'medium' });
  const afterKinds = await captureWorkerRoute(ctx, source, { tierId: 'original-light' });
  assert.deepEqual(afterKinds.candidates.map(item => item.memberId), beforeKinds.candidates.map(item => item.memberId));

  const full = { revision: 25, tiers: Array.from({ length: 16 }, (_, index) => tier(`special-${index}`, [])) };
  config.update({ workerRoutingByWorkspace: { ws: full } });
  const fullRead = await readWorkspace();
  assert.equal(fullRead.config.tiers.length, 16, 'missing standard slots do not consume persisted capacity');
  assert.ok(fullRead.config.tiers.every(item => item.kind === 'special'));
  const fullSave = await saveWorkspace({ ...fullRead.config, tiers: fullRead.config.tiers.map((item, index) =>
    index === 0 ? { ...item, kind: 'medium' } : index === 1 ? { ...item, kind: 'xhigh' } : item) }, fullRead);
  assert.equal(fullSave.config.tiers.length, 16);
  assert.deepEqual(fullSave.config.tiers[0], { ...full.tiers[0], kind: 'medium' });
  assert.deepEqual(fullSave.config.tiers[1], { ...full.tiers[1], kind: 'xhigh' });
  assert.deepEqual(fullSave.config.tiers.map(item => item.id), full.tiers.map(item => item.id));

  const oldThree = { revision: 40, tiers: [
    { ...legacy.tiers[2], id: 'same-name-special', name: '极高' },
    { ...legacy.tiers[1], kind: 'high', fallbackTierIds: ['original-light'] },
    { ...tier('original-medium', [member('medium-model', second)]), kind: 'medium' },
    { ...legacy.tiers[0], kind: 'low', fallbackTierIds: ['same-name-special'] }
  ] };
  config.update({ workerRoutingByWorkspace: { ws: oldThree } });
  const beforeExtraRead = fs.readFileSync(configFile, 'utf8');
  const beforeExtra = await readWorkspace();
  assert.deepEqual(beforeExtra.config, { ...oldThree, tiers: [{ ...oldThree.tiers[0], kind: 'special' }, ...oldThree.tiers.slice(1)] });
  assert.equal(fs.readFileSync(configFile, 'utf8'), beforeExtraRead, 'an unused xhigh slot must not write or reclassify a same-name pool');
  const extra = { ...tier('extra-high', [member('extra-second', second), member('extra-first', first)], ['original-medium']), kind: 'xhigh', name: '极高' };
  const withExtra = { ...beforeExtra.config, tiers: [...beforeExtra.config.tiers, extra] };
  await assert.rejects(saveWorkspace({ ...withExtra, tiers: [
    ...withExtra.tiers, { ...tier('duplicate-xhigh', []), kind: 'xhigh' }
  ] }, beforeExtra), /one pool/);
  const extraSaved = await saveWorkspace(withExtra, beforeExtra);
  assert.deepEqual(extraSaved.config, { ...withExtra, revision: 41 });
  assert.deepEqual(new ConfigManager().get().workerRoutingByWorkspace.ws, extraSaved.config);
  assert.deepEqual((await workerOptionsHost['workers.options'](ctx, {})).tiers.map(({ tierId, kind }) => [tierId, kind]), [
    ['original-light', 'low'], ['original-medium', 'medium'], ['original-complex', 'high'], ['extra-high', 'xhigh'], ['same-name-special', 'special']
  ]);
  assert.deepEqual((await captureWorkerRoute(ctx, source, { tierId: 'extra-high' })).candidates.map(({ memberId, config }) => [memberId, config.modelParameters]), [
    ['extra-second', second.config.modelParameters], ['extra-first', first.config.modelParameters], ['medium-model', second.config.modelParameters]
  ]);

  const addSource = async id => {
    const cwd = path.join(tmp, id);
    fs.mkdirSync(cwd);
    config.update({ workspaces: [...config.get().workspaces, { id, name: id, path: cwd, openedAt: 1,
      roots: [{ id: 'root', path: cwd }], defaultRootId: 'root' }] });
    return resolveSessionTarget(config.get(), { workspaceId: id, rootId: 'root' });
  };
  const peer = await addSource('peer');
  const follower = await addSource('follower');
  const events = [];
  ctx.getWindow = () => ({ webContents: { send: (channel, event) => events.push([channel, event]) } });
  const read = (target, layer = 'workspace') => routingSettings(ctx, target, layer);
  const save = (target, baseline, tiers = baseline.config.tiers) => saveWorkerRoutingSettings(ctx, target, {
    layer: baseline.layer, expectedVersion: baseline.version, config: { revision: baseline.config.revision, tiers }
  });
  const unchangedBeforeGlobal = fs.readFileSync(configFile, 'utf8');
  const globalBlank = await read(source, 'global');
  assert.equal((await read(peer)).origin, 'global');
  assert.deepEqual(globalBlank.config, { revision: 0, tiers: [] });
  assert.equal(fs.readFileSync(configFile, 'utf8'), unchangedBeforeGlobal, 'no existing workspace pool is promoted during read');

  const globalTier = { ...tier('shared-tier', [member('shared-member', second)]), kind: 'medium' };
  const globalFirst = await save(source, globalBlank, [globalTier]);
  assert.deepEqual(events.at(-1), ['workerRouting:changed', { kind: 'global' }]);
  const peerFollow = await read(peer);
  const followerFirst = await read(follower);
  assert.equal(peerFollow.origin, 'global');
  assert.deepEqual(peerFollow.config, globalFirst.config);
  assert.deepEqual(followerFirst.config, globalFirst.config);
  assert.notEqual(peerFollow.version, followerFirst.version, 'one workspace CAS token cannot be replayed in another');
  assert.deepEqual((await readWorkspace()).config, extraSaved.config, 'a global write retains legacy workspace overrides');
  assert.deepEqual(new ConfigManager().get().workerRoutingDefault, globalFirst.config);
  const redacted = config.getRedacted();
  for (const key of ['workerRoutingDefault', 'workerRoutingByWorkspace', 'workerRoutingWorkspaceRevisions']) assert.ok(!Object.hasOwn(redacted, key));

  const actualSources = [];
  const validateLaunchModel = ctx.agentSessions.validateLaunchModel;
  ctx.agentSessions.validateLaunchModel = async (_runtime, cwd) => { actualSources.push(cwd); };
  const firstGlobalPlan = await captureWorkerRoute(ctx, peer, { tierId: globalTier.id });
  assert.deepEqual(summarizeWorkerRoutingTiers(config.get(), peer.workspaceId).map(({ tierId }) => tierId), [globalTier.id]);
  const inheritedOptions = await runAsAgentWorkspace(peer.workspaceId,
    () => runAsSchedulerTool(() => workerOptionsHost['workers.options'](ctx, { rootId: peer.sourceRoot.rootId })));
  assert.deepEqual(inheritedOptions.tiers.map(({ tierId }) => tierId), [globalTier.id]);
  const inheritedLaunch = await delegateTask(ctx, { task: 'Inherited route', workspaceId: peer.workspaceId, isolate: false,
    target: { tierId: globalTier.id }, select: false, notifyOrchestrator: false });
  assert.equal(inheritedLaunch.session.workerRouting.plan.routingVersion.origin, 'global');
  assert.deepEqual(actualSources, [peer.sourceRoot.cwd], 'launch validates using the actual task source, not the global editor source');
  ctx.agentSessions.validateLaunchModel = validateLaunchModel;

  const peerOverride = await save(peer, peerFollow);
  assert.equal(peerOverride.origin, 'workspace');
  assert.equal(peerOverride.config.revision, globalFirst.config.revision, 'exercise identical numeric revisions across layers');
  assert.deepEqual(events.at(-1), ['workerRouting:changed', { kind: 'workspace', workspaceId: peer.workspaceId }]);
  const peerPlan = await captureWorkerRoute(ctx, peer, { tierId: globalTier.id });
  const legacyPeerPlan = { ...peerPlan, routingVersion: undefined, revision: peerPlan.routingVersion.revision };
  assertWorkerRouteCurrent(ctx, peer, legacyPeerPlan);
  await assert.rejects(delegateTask(ctx, { task: 'Queued snapshot', workspaceId: peer.workspaceId, isolate: false,
    capturedRoute: firstGlobalPlan, target: firstGlobalPlan.requested }), /changed while.*pending/);
  const followerPlan = await captureWorkerRoute(ctx, follower, { tierId: globalTier.id });
  const exact = await captureWorkerRoute(ctx, source, { targetRef: second.targetRef });
  const globalNext = await save(source, globalFirst, [{ ...globalTier, description: 'Revised global description' }]);
  assertWorkerRouteCurrent(ctx, peer, peerPlan);
  assertWorkerRouteCurrent(ctx, source, exact);
  assert.throws(() => assertWorkerRouteCurrent(ctx, follower, followerPlan), /changed while.*pending/);
  await assert.rejects(save(follower, followerFirst), /Reload/);
  assert.deepEqual((await read(follower)).config, globalNext.config);

  const peerRestored = await followGlobalWorkerRouting(ctx, peer, peerOverride.version);
  assert.equal(peerRestored.origin, 'global');
  assert.deepEqual(peerRestored.config, globalNext.config);
  assert.ok(!Object.hasOwn(new ConfigManager().get().workerRoutingByWorkspace, peer.workspaceId));
  const restoredPlan = await captureWorkerRoute(ctx, peer, { tierId: globalTier.id });
  const emptyPeer = await save(peer, peerRestored, []);
  assert.equal(emptyPeer.origin, 'workspace');
  assert.deepEqual(readWorkerRoutingConfig(config.get(), peer.workspaceId).tiers, []);
  assert.deepEqual((await read(follower)).config, globalNext.config);
  assert.throws(() => assertWorkerRouteCurrent(ctx, peer, legacyPeerPlan), /changed while.*pending/);
  const restoredAgain = await followGlobalWorkerRouting(ctx, peer, emptyPeer.version);
  assert.notEqual(restoredAgain.version, peerRestored.version, 'follow→override→follow changes the persisted generation');
  assert.throws(() => assertWorkerRouteCurrent(ctx, peer, restoredPlan), /changed while.*pending/);
  await assert.rejects(save(peer, peerRestored), /Reload/);
  assert.equal(new ConfigManager().get().workerRoutingWorkspaceRevisions[peer.workspaceId], emptyPeer.config.revision + 1);

  let permissionProbes = 0;
  ctx.agentSessions.captureWorkerPermission = async () => { permissionProbes++; return 'b'.repeat(64); };
  const approved = { ...globalTier, members: [{ ...globalTier.members[0], crossHarness: codexConsent }] };
  await assert.rejects(save(source, globalNext, [approved]), /only in workspace/);
  await assert.rejects(save(source, globalNext, [{ ...approved, members: [{ ...approved.members[0], crossHarness: { nativeConfig: codexConsent.nativeConfig } }] }]), /only in workspace/);
  assert.equal(permissionProbes, 0);
  config.update({ workerRoutingDefault: { revision: globalNext.config.revision, tiers: [approved] } });
  assert.equal((await read(peer)).config.tiers[0].members[0].crossHarness, undefined);
  assert.equal((await captureWorkerRoute(ctx, peer, { tierId: globalTier.id })).candidates[0].crossHarness, undefined);
  const safeCopy = await save(peer, await read(peer));
  assert.equal(safeCopy.config.tiers[0].members[0].crossHarness, undefined, 'copying inherited model choices carries no approval');

  const currentGlobal = await read(source, 'global');
  recordWorkerCooldown(ctx, source, second.config, { reason: 'quota' });
  assert.equal((await read(source, 'global')).members[0].state, 'cooldown');
  assert.equal((await read(follower)).members[0].state, 'available');
  assert.deepEqual(events.at(-1), ['workerRouting:changed', { kind: 'cooldown', workspaceId: source.workspaceId }]);
  assert.throws(() => clearRoutingCooldown(ctx, source, 'global', safeCopy.version, 'shared-member'), /Reload/);
  assert.equal((await clearRoutingCooldown(ctx, source, 'global', currentGlobal.version, 'shared-member')).members[0].state, 'available');
  recordWorkerCooldown(ctx, source, second.config, { reason: 'quota', scope: 'account' });
  assert.equal((await read(follower)).members[0].state, 'cooldown');
  assert.deepEqual(events.at(-1), ['workerRouting:changed', { kind: 'cooldown' }]);
  await clearRoutingCooldown(ctx, source, 'global', currentGlobal.version, 'shared-member');
  assert.deepEqual(events.at(-1), ['workerRouting:changed', { kind: 'cooldown' }]);
  assert.equal((await read(follower)).members[0].state, 'available');

  const diskBeforeFailure = fs.readFileSync(configFile, 'utf8');
  const configBeforeFailure = config.get();
  const eventCount = events.length;
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === configFile) throw new Error('fixture refused atomic write');
    return rename(from, to);
  };
  try {
    await assert.rejects(save(source, currentGlobal), /fixture refused atomic write/);
    await assert.rejects(followGlobalWorkerRouting(ctx, peer, safeCopy.version), /fixture refused atomic write/);
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(configFile, 'utf8'), diskBeforeFailure);
  assert.deepEqual(config.get(), configBeforeFailure);
  assert.equal(events.length, eventCount);

  const pauseNextValidation = () => {
    let enter, release;
    const waiting = new Promise(resolve => { enter = resolve; });
    const resume = new Promise(resolve => { release = resolve; });
    ctx.agentSessions.validateLaunchModel = async () => {
      ctx.agentSessions.validateLaunchModel = validateLaunchModel;
      enter();
      await resume;
    };
    return { waiting, release };
  };
  const preCommit = pauseNextValidation();
  const pendingConflict = save(source, currentGlobal, [{ ...globalTier, members: [member('shared-member', first)] }]);
  await preCommit.waiting;
  const accepted = await save(source, currentGlobal);
  preCommit.release();
  await assert.rejects(pendingConflict, /Reload/);
  const postCommit = pauseNextValidation();
  const early = save(source, accepted, [{ ...globalTier, description: 'First committed write' }]);
  await postCommit.waiting;
  const current = await read(source, 'global');
  const later = await save(source, current, [{ ...globalTier, description: 'Second committed write' }]);
  postCommit.release();
  const earlyReceipt = await early;
  assert.equal(earlyReceipt.version, current.version);
  assert.equal(earlyReceipt.config.tiers[0].description, 'First committed write');
  assert.equal(earlyReceipt.members[0].state, 'unknown');
  assert.equal((await read(source, 'global')).version, later.version);
  const followCommit = pauseNextValidation();
  const earlyFollow = followGlobalWorkerRouting(ctx, peer, safeCopy.version);
  await followCommit.waiting;
  const actualFollowVersion = (await read(peer)).version;
  await save(source, later, [{ ...globalTier, description: 'Global write during follow' }]);
  followCommit.release();
  const followReceipt = await earlyFollow;
  assert.equal(followReceipt.version, actualFollowVersion);
  assert.equal(followReceipt.config.tiers[0].description, 'Second committed write');
  assert.equal(followReceipt.members[0].state, 'unknown');

  console.log('worker-routing: exact cache identity, alias canonicalization, CAS/reload, tier classification and legacy preservation, bridge schemas, cooldown, and startup failover verified');
  console.log('worker-routing: global inheritance, empty override, durable generations, per-source launch/cooldown, consent isolation and atomic receipts verified');
} finally {
  Module._load = originalLoad;
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
}
