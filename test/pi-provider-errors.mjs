/** 真实 Pi SDK + 本地服务商：默认模型响应、401/402 错误事件与 会话历史诊断 诊断出口。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { builtinHarnessFixtures } from './helpers/harness-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const scratch = path.join(root, '.tmp');
fs.mkdirSync(scratch, { recursive: true });
const tmp = fs.mkdtempSync(path.join(scratch, 'pi-provider-errors-'));
const bundledDriver = path.join(tmp, 'pi');
await build({
  entryPoints: [path.join(root, 'src/main/agentSession/drivers/pi/worker.ts')],
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
  outfile: path.join(bundledDriver, 'worker.cjs')
});
if (process.platform === 'win32') {
  const guardian = path.join(tmp, 'codex', 'worker');
  fs.mkdirSync(guardian, { recursive: true });
  fs.copyFileSync(path.join(root, 'src/main/agentSession/drivers/codex/worker/windows-job.ps1'), path.join(guardian, 'windows-job.ps1'));
}
const ts = require('typescript');
const Module = require('node:module');
require.extensions['.ts'] = (module, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename
  }).outputText;
  const hostFile = path.join(root, 'src/main/agentSession/drivers/pi/workerHost.ts');
  const dirOverride = filename === hostFile ? '__dirname = ' + JSON.stringify(bundledDriver) + ';\n' : '';
  module._compile(dirOverride + compiled, filename);
};
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: { getPath: () => tmp, isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  return originalLoad.apply(this, arguments);
};
const pi = await import('@earendil-works/pi-coding-agent');
const { __setPiSdkForTests } = require(path.join(root, 'src/main/agentSession/drivers/pi/piSdk.ts'));
const { PiRuntimeDriver } = require(path.join(root, 'src/main/agentSession/drivers/pi/driver.ts'));
const { ModeController } = require(path.join(root, 'src/main/agent/providers/modeExtension.ts'));
const { createPiMode } = require(path.join(root, 'src/main/agentSession/drivers/pi/modes.ts'));
const { readSessionHistory } = require(path.join(root, 'src/main/sessions/history.ts'));
const { probeRuntime } = require(path.join(root, 'src/main/agentSession/host/base.ts'));
const { preflightRuntime } = require(path.join(root, 'src/main/runtime/preflight.ts'));
const { createAgentTerminalSession } = require(path.join(root, 'src/main/sessions/createTerminal.ts'));
const { UsageStatsService } = require(path.join(root, 'src/main/usage/service.ts'));
const { llmHost } = require(path.join(root, 'src/main/capabilities/hosts/llm.ts'));
__setPiSdkForTests(pi);
const { SkillsManagementService } = require(path.join(root, 'src/main/capabilityManagement/skills.ts'));
const { setSkillsManagementService } = require(path.join(root, 'src/main/capabilityManagement/runtimeSkills.ts'));
const skills = new SkillsManagementService({
  homeDir: tmp, userDataDir: tmp, watch: false, getProjectPaths: () => [tmp], getRuntimes: builtinHarnessFixtures
});
setSkillsManagementService(skills);

let status = 200;
let requestCount = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    requestCount++;
    const payload = JSON.parse(body);
    assert.equal(payload.model, 'default-model', '默认 activeModelId 一路传到真实请求');
    if (status !== 200) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: status === 429 ? 'rate_limit_exceeded: 您的账户已达到速率限制' : status === 402 ? 'Insufficient Balance' : 'Invalid API key' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => ({ id: 'test', object: 'chat.completion.chunk', created: 0, model: 'default-model', choices: [{ index: 0, delta, finish_reason }] });
    res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'ok' }))}\n\n`);
    res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const cfg = { llm: { providers: [{ id: 'test-provider', name: 'Local fixture', enabled: true, apiKey: 'fixture-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'default-model', name: 'Default model' }] }], activeProviderId: 'test-provider', activeModelId: 'default-model' } };
let conn;
const usage = new UsageStatsService({ loadUsageStats: () => ({}), loadUsageLlmCalls: () => [], saveUsageStats() {}, saveUsageLlmCalls() {} });
try {
  const driver = new PiRuntimeDriver({ config: { get: () => cfg, reloadFromDisk: () => cfg }, usage, bgTasks: null }, { userDataDir: tmp });
  assert.equal((await driver.probe()).status, 'available');
  const missing = structuredClone(cfg);
  missing.llm.providers.push({ ...structuredClone(missing.llm.providers[0]), id: 'chosen' });
  missing.llm.providers[0].apiKey = '';
  const selected = { providerId: 'chosen', modelId: 'default-model' };
  const config = { get: () => missing, reloadFromDisk: () => missing };
  const selectedDriver = new PiRuntimeDriver({ config, bgTasks: null }, { userDataDir: tmp });
  assert.equal((await selectedDriver.probe()).status, 'not_configured');
  const agentSessions = { probeRuntime: (id, mode, model) => probeRuntime({ drivers: new Map([['pi', selectedDriver]]) }, id, mode, model) };
  const runtimes = { get: () => ({ id: 'pi', enabled: true, surface: 'chat' }) };
  const preflight = await preflightRuntime({ config, runtimes, agentSessions }, 'pi', { modelOverride: selected });
  assert.equal(preflight.ok, true, 'preflight → host → driver 保留显式模型，不能被未配置默认项误拦');
  assert.equal(createPiMode(tmp, { id: 'pinned', name: 'Pinned', description: '', persona: 'Fixture', model: selected }), null);
  assert.equal((await selectedDriver.probe({ piModeId: 'pinned' })).status, 'available', '模式钉模型参与预检');
  let admitted;
  const admissionConfig = { ...config, get: () => ({ ...missing, workspace: { path: tmp }, workspaces: [{ id: 'fixture', path: tmp }], activeWorkspaceId: 'fixture' }) };
  await assert.rejects(createAgentTerminalSession({ config: admissionConfig, runtimes, isChatRuntime: () => true, agentSessionsRef: { probeRuntime: async (...args) => {
    admitted = args;
    return { status: 'not_configured', problems: [{ code: 'config_missing', message: 'fixture rejection' }] };
  } } }, { runtime: 'pi', inheritMeta: { piModeId: 'pinned', modelOverride: selected } }, { sourceRoot: { path: tmp }, cwd: tmp }), /fixture rejection/);
  assert.deepEqual(admitted, ['pi', 'pinned', selected], 'sessions.create gate 透传会话初始模型与模式');
  conn = await driver.connect({ sessionId: 'provider-fixture', cwd: tmp, systemPromptAppend: '', mode: 'auto', planExecuting: false, modeController: new ModeController('default'), hostTools: [], nativeTools: [], getTurnId: () => 'provider-fixture-turn', getPolicyState: () => ({ mode: 'auto', planExecuting: false }), requestApproval: async () => ({ approved: true }), piSettings: { retry: { enabled: false } }, log() {} });
  const stream = conn.events[Symbol.asyncIterator]();
  for (const code of [200, 401, 402, 429, 200]) {
    status = code;
    const events = [];
    const timer = setTimeout(() => { void conn.close(); }, 8000);
    try {
      await conn.send('Reply ok');
      while (true) {
        const result = await stream.next();
        assert.equal(result.done, false, '回合必须在超时前收到终态事件');
        events.push(result.value);
        if (['error', 'turn-complete'].includes(result.value.type)) break;
      }
    } finally { clearTimeout(timer); }
    if (code === 200) {
      assert.equal(events.at(-1).type, 'turn-complete');
      assert.equal(events.filter((ev) => ev.type === 'text-delta').map((ev) => ev.delta).join(''), 'ok');
    } else {
      const error = events.at(-1);
      assert.equal(error.type, 'error', `${code} 不能作为空成功回合`);
      assert.match(error.message, new RegExp(String(code)));
      const message = { id: 'm1', role: 'assistant', parts: [], ts: 1, error: error.message };
      const history = { messages: [message], before: 0, total: 1, hasEarlier: false };
      const before = JSON.stringify(history);
      const tail = await readSessionHistory({ sessions: { resolveSessionRef: () => ({ id: 's1' }), get: () => ({ id: 's1', runtime: 'pi' }), isChatRuntime: () => true }, agentSessions: { getHistoryRange: () => history } }, { sessionId: 's1', n: 1 });
      assert.match(tail.messages[0].text, /\[error\]/, '真实宿主出口保留 assistant.error');
      assert.match(tail.messages[0].text, new RegExp(String(code)));
      assert.equal(JSON.stringify(history), before, '诊断出口保持只读');
    }
  }
  assert.equal(requestCount, 5, '不额外探测网络/偷偷切换服务商');
  const quota = llmHost['llm.quota']({ config: { get: () => cfg }, usage }, { providerId: 'test-provider' });
  assert.equal(quota.sampleCount, 5, '实际 Worker 请求进入 quota');
  assert.equal(quota.failCount, 3);
  assert.equal(quota.classified.rate_limit, 1);
  assert.equal(quota.rateLimited, true);
  assert.equal(llmHost['llm.quota']({ config: { get: () => cfg }, usage }, { providerId: 'other' }).sampleCount, 0, '按精确服务商身份隔离');
  assert.equal(usage.getDays()[Object.keys(usage.getDays())[0]]?.extLlmCalls ?? 0, 0, 'Worker 不增加扩展调用数');

  // ── 目录继承端到端：真 pi-ai 目录 prime → 内置 provider 走 modelOverrides →
  //    真 ModelRuntime 解析继承（价格/窗口来自目录而非宿主手写） ──
  const { syncPiConfigFromApp, primePiCatalogSnapshot } = require(path.join(root, 'src/main/agent/piConfigSync.ts'));
  // 转译环境的 import() 会退化成 require()（pi-ai 仅开放 import 条件），这里以真 ESM
  // 动态 import 拿到目录模块后注入；生产链路（electron-vite bundle）内动态 import 可用
  const piCatalogModule = await import('@earendil-works/pi-ai/providers/all');
  await primePiCatalogSnapshot(piCatalogModule);
  const catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-catalog-'));
  const catalogSync = syncPiConfigFromApp(
    {
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          enabled: true,
          apiKey: 'sk-catalog-e2e',
          // 目录分支按「端点与目录一致」守门（model-providers F-03）：本节验证目录继承，
          // baseUrl 须取目录官方端点；localhost 网关端点会（正确地）走自定义分支
          baseUrl: 'https://api.deepseek.com',
          models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }]
        }
      ],
      activeProviderId: 'deepseek',
      activeModelId: 'deepseek-v4-pro'
    },
    catalogDir
  );
  const catalogJson = JSON.parse(fs.readFileSync(path.join(catalogDir, 'models.json'), 'utf8'));
  const dsEntry = catalogJson.providers.deepseek;
  assert.ok(dsEntry.modelOverrides?.['deepseek-v4-pro'], '真实目录 prime 后内置 provider 走 modelOverrides');
  assert.equal(dsEntry.models, undefined, '目录内模型不写 models 全量条目');
  assert.equal(dsEntry.modelOverrides['deepseek-v4-pro'].cost, undefined, '不把价格钉进 overrides（目录继承）');
  const runtime = await pi.ModelRuntime.create({
    authPath: path.join(catalogDir, 'auth.json'),
    modelsPath: path.join(catalogDir, 'models.json'),
    allowModelNetwork: false
  });
  const inherited = runtime.getModel('deepseek', 'deepseek-v4-pro');
  assert.ok(inherited, '真 ModelRuntime 能解析 modelOverrides 形态并命中模型');
  assert.equal(typeof inherited.cost?.input, 'number', '继承目录价格字段');
  assert.ok(inherited.contextWindow > 0, '继承目录上下文窗口');
  fs.rmSync(catalogDir, { recursive: true, force: true });
} finally {
  await conn?.close();
  await new Promise((resolve) => server.close(resolve));
  setSkillsManagementService(undefined);
  skills.dispose();
  __setPiSdkForTests(null);
  Module._load = originalLoad;
  assert.equal(path.dirname(tmp), scratch);
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('ok   pi-provider-errors (real SDK, default model, 401/402/429, 会话历史诊断, quota)');
