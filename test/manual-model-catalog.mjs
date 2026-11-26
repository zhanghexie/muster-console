import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-model-catalog-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
  const load = entry => import(pathToFileURL(compile(entry)).href);
  const acpEntry = 'main/agentSession/drivers/acp/models.ts';
  compile(acpEntry);
  fs.writeFileSync(compile('main/agentSession/drivers/acp/agents.ts'), `
    export function getAcpPresets() { return [{ id: 'fixture' }, { id: 'qwen' }]; }
    export function resolveAcpLaunch() { return { command: 'fixture', args: [] }; }
  `);
  fs.writeFileSync(compile('main/agentSession/process/controlledChild.ts'), `
    import { EventEmitter } from 'node:events';
    import { PassThrough } from 'node:stream';
    export function createControlledChild() {
      globalThis.discoveryStarts++;
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, killed: false
      });
      const modelIds = globalThis.qwenDiscovery ? ['a', 'b', 'c', ...Array.from({ length: 10 }, (_, i) => 'model-' + i)] : ['a', 'b', 'c'];
      const model = value => ({
        id: 'model', type: 'select', currentValue: value, options: modelIds.map(value => ({ value, name: value }))
      });
      const reasoning = value => ({
        id: 'vendor-budget', category: 'thought_level', type: 'select', currentValue: value, options: [{ value, name: value }]
      });
      child.stdin.on('data', chunk => {
        const request = JSON.parse(String(chunk));
        const { id, method, params } = request;
        let result;
        if (method === 'initialize') result = { protocolVersion: 1 };
        else if (method === 'session/new') result = globalThis.legacyDiscovery
          ? { sessionId: 'fixture-session', models: { currentModelId: 'a', availableModels: [{ modelId: 'a', name: 'a' }] } }
          : { sessionId: 'fixture-session', configOptions: [model('a'), reasoning('low')] };
        else if (method === 'session/set_config_option') {
          if (globalThis.qwenDiscovery && params.value === 'model-0') {
            const notice = JSON.stringify({ method: 'session/update', params: { sessionId: 'fixture-session', update: {
              sessionUpdate: 'available_commands_update', _meta: { availableSkillDetails: '技'.repeat(400_000) }
            } } });
            child.stdout.write(notice.slice(0, -20));
            child.stdout.write(notice.slice(-20) + '\\n');
          }
          const effort = params.value === 'b' ? [reasoning('high')] : [];
          result = { configOptions: [model(params.value), ...effort] };
          if (globalThis.partialDiscovery && params.value === 'b') {
            child.stdout.write(JSON.stringify({ method: 'session/update', params: { sessionId: 'fixture-session', update: {
              sessionUpdate: 'config_option_update', configOptions: [model('a'), reasoning('low')]
            } } }) + '\\n');
            result = {};
          }
        } else throw Error(method);
        const response = globalThis.failDiscovery
          ? { id, error: { code: -32000, message: 'fixture discovery failed' } }
          : { id, result };
        child.stdout.write(JSON.stringify(response) + '\\n');
      });
      return { child, started: true, ready: Promise.resolve(), reclaim: async () => child.stdin.end() };
    }
  `);
  const { configureModelCatalogStorage, ModelCatalogCache } = await load('main/agentSession/modelCatalogCache.ts');
  const { listAcpModels } = await load(acpEntry);
  const userDataDir = path.join(tmp, 'profile');
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(userDataDir); fs.mkdirSync(cwd);
  globalThis.discoveryStarts = 0;
  configureModelCatalogStorage(userDataDir);
  const read = (modelId, refresh) => listAcpModels({ cwd, agentId: 'fixture', userDataDir, modelId, refresh });
  assert.equal((await read()).ok, false);
  assert.equal(globalThis.discoveryStarts, 0, 'reading a missing catalog never starts an engine');
  assert.equal((await read(undefined, true)).reasoning?.currentValue, 'low');
  assert.equal((await read('b')).parametersUnknown, true);
  assert.equal((await read('b', true)).reasoning?.currentValue, 'high');
  assert.equal((await read('c', true)).parametersUnknown, undefined, 'known unsupported differs from unobserved');
  globalThis.failDiscovery = true;
  assert.equal((await read('b', true)).ok, false);
  globalThis.failDiscovery = false;
  configureModelCatalogStorage(userDataDir);
  for (const [model, level] of [['b', 'high'], ['a', 'low'], [undefined, 'low'], ['b', 'high']]) {
    assert.equal((await read(model)).reasoning?.currentValue, level, 'model-specific options survive other refreshes and restart');
  }
  assert.equal((await listAcpModels({ cwd: tmp, agentId: 'fixture', userDataDir })).ok, false, 'different source has its own snapshot');
  assert.equal(globalThis.discoveryStarts, 4, 'all cached reads reuse the snapshot');

  const progress = [];
  const complete = await listAcpModels({ cwd: tmp, agentId: 'fixture', userDataDir, refresh: true, allModels: true,
    onProgress: update => progress.push(update) });
  assert.equal(complete.ok, true);
  assert.deepEqual(complete.coverage, { total: 3, read: 3 });
  assert.deepEqual(progress, [{ completed: 1, total: 3, model: 'b' }, { completed: 2, total: 3, model: 'c' }, { completed: 3, total: 3 }]);
  assert.equal(globalThis.discoveryStarts, 5, 'bulk reads reuse one empty ACP session');
  configureModelCatalogStorage(userDataDir);
  assert.equal((await listAcpModels({ cwd: tmp, agentId: 'fixture', userDataDir, modelId: 'b' })).reasoning.currentValue, 'high');
  assert.equal((await listAcpModels({ cwd: tmp, agentId: 'fixture', userDataDir, modelId: 'c' })).parametersUnknown, undefined);

  globalThis.partialDiscovery = true;
  const partial = await listAcpModels({ cwd: tmp, agentId: 'fixture', userDataDir, refresh: true, allModels: true });
  assert.deepEqual(partial.coverage, { total: 3, read: 2 }, 'an unrelated update cannot confirm another model');
  assert.equal((await listAcpModels({ cwd: tmp, agentId: 'fixture', userDataDir, modelId: 'b' })).reasoning.currentValue, 'high',
    'a partially confirmed batch retains the last confirmed option for that model');
  globalThis.legacyDiscovery = true;
  const legacy = await listAcpModels({ cwd: userDataDir, agentId: 'fixture', userDataDir, refresh: true, allModels: true });
  assert.deepEqual(legacy.coverage, { total: 1, read: 0 }, 'a legacy model list alone does not confirm its reasoning options');
  assert.equal(legacy.parametersUnknown, true);

  globalThis.partialDiscovery = false;
  globalThis.legacyDiscovery = false;
  globalThis.qwenDiscovery = true;
  const qwen = await listAcpModels({ cwd, agentId: 'qwen', userDataDir, refresh: true, allModels: true });
  assert.deepEqual(qwen.coverage, { total: 13, read: 13 }, 'a fragmented Qwen Skills notification must not interrupt model discovery');
  globalThis.qwenDiscovery = false;

  const { codexModelItems } = await load('shared/codexModels.ts');
  const { validateCliModelReasoning } = await load('main/agentSession/cliModelReasoning.ts');
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  new ModelCatalogCache('codex').set(JSON.stringify([cwd, codexHome]), {
    ok: true, source: 'app-server', defaultModelId: 'limited', items: codexModelItems([
      { model: 'limited', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
      { model: 'no-effort', supportedReasoningEfforts: [] }
    ])
  });
  await validateCliModelReasoning('codex', { model: 'limited', reasoning: 'low' }, cwd);
  await assert.rejects(validateCliModelReasoning('codex', { model: 'limited', reasoning: 'xhigh' }, cwd), /CLI 不支持/);
  await assert.rejects(validateCliModelReasoning('codex', { model: 'no-effort', reasoning: 'low' }, cwd), /CLI 不支持/);

  const { claudeConfigDirectory } = await load('main/agentSession/drivers/claude/models.ts');
  new ModelCatalogCache('claude').set(JSON.stringify([cwd, claudeConfigDirectory(userDataDir, false), false]), [
    { id: 'fixture-alias', name: 'Claude fixture', resolvedModel: 'fixture-model', effortLevels: ['low'] }
  ]);
  await validateCliModelReasoning('claude-code', { model: 'fixture-alias', reasoning: 'low' }, cwd);
  await assert.rejects(validateCliModelReasoning('claude-code', { model: 'fixture-model', reasoning: 'high' }, cwd), /CLI 不支持/);

  const { PiRuntimeDriver } = await load('main/agentSession/drivers/pi/driver.ts');
  const { primePiCatalogSnapshot } = await load('main/agent/piConfigSync.ts');
  const model = { id: 'core-model', reasoning: true };
  const provider = { id: 'core-provider', baseUrl: 'https://example.invalid/v1', models: [model] };
  await primePiCatalogSnapshot({
    getBuiltinProviders: () => [provider.id],
    getBuiltinModels: () => [{ ...model, api: 'openai-completions', baseUrl: provider.baseUrl, thinkingLevelMap: { off: null, low: null, medium: null, high: 'strong', max: null } }]
  });
  for (const configured of [provider, { ...provider, thinking: { levels: { high: 'strong' } } }]) {
    const core = { runtimeId: 'pi', ctx: {}, resolveModelConfig: () => ({ resolved: { provider: configured, model } }) };
    const description = await PiRuntimeDriver.prototype.describeModelParameters.call(core, {});
    assert.deepEqual(description.parameters[0]?.options.map(option => option.value), configured === provider ? ['minimal', 'high'] : ['high']);
  }
  console.log('manual model catalog: cached ACP switch/restart/failure, model-specific CLI validation, Core model effort');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
