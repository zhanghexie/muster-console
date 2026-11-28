import type { WorkerRoutingConfig, WorkerRoutingLayer, WorkerRoutingScope, WorkerRoutingSettings, WorkerTargetConfig } from '../../src/shared/workerRouting';
import type { HarnessPickerChoice, HarnessPickerRequest, HarnessPickerResult, SetModelConfigurationInput } from '../../src/shared/harnessPicker';
import { resolveModelParameters } from '../../src/shared/modelParameters';

export const scope: WorkerRoutingScope = { workspaceId: 'fixture-routing', rootId: 'routing-root', rootsRevision: 2 };
export const workspace = { id: scope.workspaceId, name: '路由测试工作区', path: 'E:/Routing', rootsRevision: scope.rootsRevision,
  defaultRootId: scope.rootId, roots: [{ id: scope.rootId, path: 'E:/Routing' }] };
const runtimes = [
  { id: 'pi', label: 'Muster Core', enabled: true, builtin: true, surface: 'chat' },
  { id: 'acp', label: 'ACP', enabled: true, builtin: true, surface: 'chat' },
  { id: 'codex-gui', label: 'Codex', enabled: true, builtin: true, surface: 'chat' },
  { id: 'codex', label: 'Codex CLI', enabled: true, builtin: true, surface: 'pty' }
];
const config = { workspaces: [workspace], activeWorkspaceId: workspace.id, defaultRuntime: 'pi', locale: 'zh-CN',
  llm: { providers: [
    { id: 'fixture-openai', name: '账户 A', models: [{ id: 'swift-model', name: 'Swift Model' }, { id: 'deep-model', name: 'Deep Model' }] },
    { id: 'fixture-team', name: '团队服务', models: [{ id: 'deep-model', name: 'Deep Model' }] }
  ] } };
const candidate = (providerId: string, modelId: string, reasoning: string): WorkerTargetConfig => ({
  harnessId: 'muster-core', surface: 'gui', runtimeId: 'pi', model: { providerId, modelId }, modelParameters: { reasoning }
});
let globalRouting: WorkerRoutingConfig = { revision: 8, tiers: [
  { id: 'light', kind: 'low', name: '轻量', description: '小范围编辑、文档整理和一次性查询。', fallbackTierIds: [], members: [
    { id: 'first', enabled: true, config: candidate('fixture-openai', 'swift-model', 'low') },
    { id: 'second', enabled: true, config: candidate('fixture-team', 'deep-model', 'high') }
  ] },
  { id: 'heavy', kind: 'high', name: '攻坚', description: '多模块改动和复杂故障排查。', fallbackTierIds: ['light'], members: [
    { id: 'third', enabled: true, config: candidate('fixture-openai', 'deep-model', 'high') },
    { id: 'fourth', enabled: false, config: candidate('fixture-team', 'deep-model', 'medium') },
    { id: 'codex', enabled: true, config: { harnessId: 'codex', surface: 'gui', runtimeId: 'codex-gui',
      model: { providerId: 'codex-gui', modelId: 'codex-model' } } }
  ] },
  { id: 'review', kind: 'special', name: '代码审查', description: '复核变更和测试覆盖。', fallbackTierIds: [], members: [] }
] };
let workspaceRouting: WorkerRoutingConfig | undefined;
let workspaceGeneration = 0;
const refMap = new Map<string, WorkerTargetConfig>();
export const fixture = {
  sent: [] as string[], calls: [] as { path: string; args: unknown[] }[], unmocked: [] as string[], expire: false,
  taskStarts: 0, modelChanges: [] as Array<Omit<SetModelConfigurationInput, 'sessionId'>>, delayedCodexPreview: false
};
export const pickerRuntimes = runtimes;
const choices: HarnessPickerChoice[] = [
  { harnessId: 'muster-core', runtimeId: 'pi', surface: 'gui', label: 'Muster Core', available: true, status: 'available' },
  { harnessId: 'codex', runtimeId: 'codex-gui', surface: 'gui', label: 'Codex', available: true, status: 'available' },
  { harnessId: 'codex', runtimeId: 'codex', surface: 'cli', label: 'Codex CLI', available: true, status: 'available' }
];
function readPicker(request: HarnessPickerRequest): HarnessPickerResult {
  const harness = 'harness' in request ? request.harness : { harnessId: 'muster-core', runtimeId: 'pi', surface: 'gui' as const };
  if (Object.keys(harness).some(key => !['harnessId', 'runtimeId', 'surface', 'acpPresetId'].includes(key)) ||
    request.model && Object.keys(request.model).sort().join() !== 'modelId,providerId') throw new Error('Unexpected picker request fields');
  const models = harness.runtimeId === 'pi' ? config.llm.providers.flatMap(provider => provider.models.map(model => ({
    providerId: provider.id, modelId: model.id, label: model.name, group: { id: provider.id, label: provider.name }
  }))) : fixture.delayedCodexPreview && harness.runtimeId === 'codex-gui' ? Array.from({ length: 18 }, (_, index) => ({
    providerId: 'codex-gui', modelId: `codex-model-${index + 1}`, label: `Codex model ${index + 1}`
  })) : [];
  const last = fixture.modelChanges.at(-1);
  const parameters = resolveModelParameters({ runtimeId: harness.runtimeId, providerId: 'fixture-team', modelId: 'deep-model',
    parameters: [{ id: 'reasoning', semantic: 'reasoning', label: '思考强度',
    apply: 'next-turn', supportsDefault: true, options: [{ value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }] }] }, []).controls;
  return { ok: true, catalog: {
    harness, source: { ...scope, cwd: workspace.path }, models, defaultModel: models.length ? { providerId: models[0].providerId, modelId: models[0].modelId } : null,
    state: models.length ? 'ready' : 'missing', parameterState: request.model === undefined ? 'not-requested' : models.length ? 'ready' : 'unknown',
    parameters: models.length ? parameters : [], canRefresh: harness.runtimeId !== 'pi', warning: models.length ? undefined : '尚无模型目录快照，请手动刷新。',
    ...('source' in request ? {} : { selectedModel: last?.model ?? null, selectedParameters: last?.parameters ?? {}, sessionStamp: 'fixture', commitStamp: 'fixture:1' })
  } };
}
let cooldown = true;
const statuses = (): WorkerRoutingSettings['members'] => [
  cooldown ? { id: 'first', state: 'cooldown', retryAt: Date.now() + 60000, reason: '限流后等待恢复' } : { id: 'first', state: 'available' },
  { id: 'second', state: 'unknown', reason: '尚无运行回执' }, { id: 'third', state: 'available' }, { id: 'fourth', state: 'disabled' },
  { id: 'codex', state: 'available' }
];
function routingSettings(layer: WorkerRoutingLayer): WorkerRoutingSettings {
  if (layer === 'global') return { layer, origin: layer, version: `global:${globalRouting.revision}`, config: globalRouting, members: statuses() };
  return workspaceRouting
    ? { layer, origin: layer, version: `workspace:${workspaceGeneration}`, config: workspaceRouting, members: statuses() }
    : { layer, origin: 'global', version: `inherited:${workspaceGeneration}:${globalRouting.revision}`, config: globalRouting, members: statuses() };
}
function checkRoutingVersion(layer: WorkerRoutingLayer, expectedVersion: string) {
  if (expectedVersion !== routingSettings(layer).version) throw new Error('配置已更新，请重新载入。');
}
const defaults: Record<string, unknown> = {
  'workspaces.list': { workspaces: [workspace], activeWorkspaceId: workspace.id },
  'config.get': config,
  'capabilities.get': { dispatcher: { defaultBody: '', customBody: '' } },
  'capabilityManagement.usageList': { revision: 0, resources: [], runtimes: [], categories: {} },
  'sessions.list': { sessions: [], activeId: null },
  'sessions.precheck': { dirty: false },
  'extensions.list': { workspaceId: workspace.id, entries: [] },
  'runtimes.list': runtimes,
  'runtimes.availability': { runtimes, acpAgents: [], checkedAt: Date.now() },
  'notify.list': [],
  'app.setChromeTheme': undefined,
  'agent.listSkills': { skills: [
    { name: 'review', description: '检查改动', filePath: 'E:/Routing/skills/review/SKILL.md' },
    ...Array.from({ length: 40 }, (_, i) => ({
      name: `workspace-${i + 1}`, description: `工作区技能 ${i + 1}`, filePath: `E:/Routing/skills/workspace-${i + 1}/SKILL.md`
    }))
  ] },
  'agentSession.getHarnessModelSelections': {},
  'agentSession.listHarnessPickerChoices': { choices, checkedAt: 1 },
  'agentSession.listPiModes': [
    { id: 'creator', name: '创造模式' }, { id: 'explore', name: '探索模式' }, { id: 'verify', name: '验收判定' }
  ],
  'agentSession.cancelHarnessModels': { ok: true },
  'agentSession.refreshHarnessModelCatalogs': { ok: true, workspace: workspace.name, rows: [] },
  'agentSession.describeNativeConfig': {
    identity: { runtimeId: 'codex-gui', sourceKey: 'fixture-source', version: 'fixture-native' }, revision: 1,
    source: 'catalog', status: 'ready',
    options: [
      { id: 'permissions', name: 'Permission Profile', category: 'permissions', type: 'select', changePolicy: 'idle',
        choices: [{ value: ':workspace', name: ':workspace' }, { value: 'custom-profile', name: 'Custom profile' }] },
      { id: 'approvalPolicy', name: 'Approval Policy', category: 'permissions', type: 'select', changePolicy: 'idle',
        choices: [{ value: 'on-request', name: 'on-request' }] },
      { id: 'approvalsReviewer', name: 'Approvals Reviewer', category: 'permissions', type: 'select', changePolicy: 'idle',
        choices: [{ value: 'user', name: 'user' }] }
    ]
  },
  'agentSession.listCodexModels': { ok: false, error: '尚无模型目录快照，请手动刷新。' },
  'workflow.overview': { workflows: [], active: [], recent: [] },
  'workspaces.listFiles': { files: [{ path: 'model.md', absolutePath: 'E:/Routing/model.md' }] },
  'fs.cancelQuery': { ok: true },
  'notify.toast': undefined,
  'boardTodos.list': [],
  'workspaceFile.get': { workspaceId: workspace.id, config: {} }
};
const custom: Record<string, (...args: any[]) => unknown> = {
  'agentSession.readHarnessPickerCatalog': async (request: HarnessPickerRequest) => {
    if (fixture.delayedCodexPreview && 'harness' in request && request.harness.runtimeId === 'codex-gui' && request.model !== undefined) {
      await new Promise(resolve => setTimeout(resolve, 140));
    }
    return readPicker(request);
  },
  'agentSession.describeModelParameters': ({ providerId, modelId, runtimeId }) => ({ runtimeId, providerId, modelId,
    parameters: [{ id: 'reasoning', semantic: 'reasoning', label: '思考强度', apply: 'next-turn', supportsDefault: true,
      options: [{ value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }] }]
  }),
  'workerRouting.read': ({ layer }) => routingSettings(layer),
  'workerRouting.save': ({ layer, expectedVersion, config: next }) => {
    checkRoutingVersion(layer, expectedVersion);
    if (layer === 'global') globalRouting = { ...next, revision: globalRouting.revision + 1 };
    else workspaceRouting = { ...next, revision: ++workspaceGeneration };
    return routingSettings(layer);
  },
  'workerRouting.followGlobal': ({ expectedVersion }) => {
    checkRoutingVersion('workspace', expectedVersion);
    workspaceRouting = undefined;
    workspaceGeneration++;
    return routingSettings('workspace');
  },
  'workerRouting.resetCooldown': ({ layer, expectedVersion }) => {
    checkRoutingVersion(layer, expectedVersion);
    cooldown = false;
    return routingSettings(layer);
  },
  'workerRouting.reference': ({ config }) => {
    const targetRef = 'wr1.' + String(refMap.size + 1).padStart(32, '0');
    refMap.set(targetRef, config);
    return { targetRef, config };
  },
  'workerRouting.validate': ({ targetRef }) => {
    if (fixture.expire || !refMap.has(targetRef)) throw new Error('模型引用已失效');
    return { targetRef, config: refMap.get(targetRef) };
  }
};

function api(route = ''): any {
  return new Proxy(() => {}, {
    get: (_, key) => key === 'then' ? undefined : api(route ? route + '.' + String(key) : String(key)),
    apply: (_, __, args: unknown[]) => {
      if (route === 'on') return () => {};
      fixture.calls.push({ path: route, args });
      if (Object.hasOwn(custom, route)) return Promise.resolve().then(() => custom[route](...args)).then(value => structuredClone(value));
      if (!Object.hasOwn(defaults, route) && !fixture.unmocked.includes(route)) fixture.unmocked.push(route);
      return Promise.resolve(structuredClone(defaults[route]));
    }
  });
}

(window as any).__uiFixture = fixture;
(window as any).api = api();
