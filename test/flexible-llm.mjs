/**
 * 大模型多服务商与多模型配置同步与解析自测
 * 运行: node test/flexible-llm.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const compilerOptions = {
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true
};

function rewriteImports(src) {
  return src
    .replace(/import type \{[^}]+\} from '[^']+';?\r?\n/g, '')
    .replace(/from '\.\.\/\.\.\/shared\/([^']+)'/g, (_m, rel) => `from '../../shared/${rel.replace(/\.mjs$/, '')}.mjs'`)
    .replace(/from '\.\.\/shell\/([^']+)'/g, (_m, rel) => `from '../shell/${rel.replace(/\.mjs$/, '')}.mjs'`)
    // F-04 引入的 ../atomicJson（原子写）；单条精确改写避免误伤 ../../shared 等前缀
    .replace(/from '\.\.\/atomicJson'/g, "from '../atomicJson.mjs'")
    .replace(/from '\.\/([^']+)'/g, (_m, rel) => `from './${rel.replace(/\.mjs$/, '')}.mjs'`);
}

function emit(outPath, srcPath) {
  const src = fs.readFileSync(srcPath, 'utf8');
  const { outputText } = ts.transpileModule(rewriteImports(src), {
    compilerOptions,
    fileName: srcPath
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, outputText, 'utf8');
}

function compileBundle() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fllm-'));
  fs.mkdirSync(path.join(tmp, 'main', 'shell'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'main', 'shell', 'profiles.mjs'),
    'export function detectGitBashPath() { return null; }',
    'utf8'
  );
  emit(path.join(tmp, 'shared', 'thinkingLevels.mjs'), path.join(root, 'src', 'shared', 'thinkingLevels.ts'));
  // piConfigSync re-export normalizePiBaseUrl 自 shared/piCatalog（探针/设置页共用真源）
  emit(path.join(tmp, 'shared', 'piCatalog.mjs'), path.join(root, 'src', 'shared', 'piCatalog.ts'));
  // F-04 原子写依赖（此前漏发导致本测试在 HEAD 即红）
  emit(path.join(tmp, 'main', 'atomicJson.mjs'), path.join(root, 'src', 'main', 'atomicJson.ts'));
  fs.mkdirSync(path.join(tmp, 'shared'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'shared', 'i18n.mjs'),
    'export function t(key, opts) { return opts ? key.replace(/\\{\\{(\\w+)\\}\\}/g, (_, k) => opts[k] ?? "") : key; }\n',
    'utf8'
  );
  emit(path.join(tmp, 'shared', 'modelCapabilities.mjs'), path.join(root, 'src', 'shared', 'modelCapabilities.ts'));
  for (const file of ['piConfigSync', 'coreReasoningCatalog', 'coreReasoningSeed', 'piReasoningCatalog']) {
    emit(path.join(tmp, 'main', 'agent', `${file}.mjs`), path.join(root, 'src', 'main', 'agent', `${file}.ts`));
  }
  return { tmp, entry: path.join(tmp, 'main', 'agent', 'piConfigSync.mjs') };
}

const { entry } = compileBundle();
const { normalizePiBaseUrl, syncPiConfigFromApp, syncPiRetrySettings, PI_RETRY_MAX_RETRIES, PI_RETRY_BASE_DELAY_MS } = await import(pathToFileURL(entry).href);

// ── 隔离与回归守卫（2026-09-15 生产事故）──────────────────────────────────────
// 本测试曾漏传 targetDir，把夹具 key（sk-legacy / sk-openai-test / sk-test-responses
// / sk-thinking / sk-mimo-key）写进真实 ~/.pi/agent/{models,auth}.json——安装版调度
// 的 pi 鉴权读的就是这份文件，直接导致线上 401 "Your api key: ****gacy is invalid"。
// 所有 sync 调用必须落 syncDir（tmp）；结尾的快照比对保证真实目录全程未被触碰，
// 谁删掉 targetDir 参数，该守卫即转红。
const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fllm-sync-'));
const piAgentDir = path.join(os.homedir(), '.pi', 'agent');
// settings.json 一并看住：syncPiShellPath 同样写默认目录（本测试把探测 stub 成 null 不触发，
// 但 stub 失效或漏传 targetDir 时它会被写）。mcp.json 同理：syncPiMcpFromApp 漏传
// targetDir 时（config.update / runPiProvider 路径）会写穿真实 CLI 配置。
const GUARD_FILES = ['models.json', 'auth.json', 'settings.json', 'mcp.json'];
const sha256Of = (p) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch {
    return null; // 文件不存在也算一种快照态
  }
};
const realConfigSnapshot = new Map(GUARD_FILES.map((name) => [name, sha256Of(path.join(piAgentDir, name))]));

// Fresh and explicitly empty configs must not recreate a default provider/model.
for (const [label, input] of [
  ['empty LlmConfig', { providers: [], activeProviderId: '', activeModelId: '' }],
  ['empty AppConfig overrides legacy', { llm: { providers: [], activeProviderId: '', activeModelId: '' }, openai: { baseUrl: 'https://api.deepseek.com', apiKey: 'fixture', model: 'saved-legacy' } }],
  ['blank legacy', { baseUrl: '', apiKey: '', model: '' }],
  ['legacy without model', { baseUrl: 'https://example.com/v1', apiKey: 'fixture', model: '' }],
  ['legacy without endpoint', { baseUrl: '', apiKey: 'fixture', model: 'saved-model' }],
  ['provider without models', { providers: [{ id: 'empty', baseUrl: 'https://example.com', apiKey: 'fixture', models: [] }], activeProviderId: 'empty', activeModelId: '' }]
]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fllm-empty-'));
  try {
    const result = syncPiConfigFromApp(input, dir);
    assert.deepEqual(result.providers, [], label);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8')), { providers: {} }, label);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')), {}, label);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fllm-legacy-'));
  try {
    const legacy = { baseUrl: 'https://api.deepseek.com', apiKey: 'fixture', model: 'user-saved-model' };
    const result = syncPiConfigFromApp(legacy, dir);
    assert.equal(result.providerId, 'deepseek');
    assert.equal(result.modelId, 'user-saved-model');
    const models = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'));
    assert.equal(models.providers.deepseek.models[0].id, 'user-saved-model');
    // Empty app config preserves unrelated/pre-existing runtime registry entries.
    syncPiConfigFromApp({ providers: [], activeProviderId: '', activeModelId: '' }, dir);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8')), models);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// 测试 1: normalizePiBaseUrl
assert.equal(normalizePiBaseUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1');
assert.equal(normalizePiBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1');
assert.equal(normalizePiBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1');
assert.equal(normalizePiBaseUrl(''), 'https://api.openai.com/v1');
console.log('✔ normalizePiBaseUrl passed');

// 测试 2: syncPiConfigFromApp 同步多服务商与模型
const mockLlmConfig = {
  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-deepseek-test',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek V3' },
        { id: 'deepseek-reasoner', name: 'DeepSeek R1', reasoning: true }
      ],
      enabled: true
    },
    {
      id: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai-test',
      models: [
        { id: 'gpt-4o', name: 'GPT-4o' },
        { id: 'o1', name: 'o1', reasoning: true }
      ],
      enabled: true
    },
    {
      id: 'disabled-provider',
      name: 'Disabled',
      baseUrl: 'https://api.disabled.com',
      apiKey: 'sk-disabled',
      models: [{ id: 'm1', name: 'm1' }],
      enabled: false
    }
  ],
  activeProviderId: 'deepseek',
  activeModelId: 'deepseek-chat'
};

const syncRes = syncPiConfigFromApp(mockLlmConfig, syncDir);
assert.equal(syncRes.providerId, 'deepseek');
assert.equal(syncRes.modelId, 'deepseek-chat');
assert.deepEqual(syncRes.providers.sort(), ['deepseek', 'openai'].sort());

const modelsJson = JSON.parse(fs.readFileSync(path.join(syncRes.agentDir, 'models.json'), 'utf8'));
assert.ok(modelsJson.providers.deepseek);
assert.ok(modelsJson.providers.openai);
assert.equal(modelsJson.providers['disabled-provider'], undefined);
assert.equal(modelsJson.providers.deepseek.models.length, 2);
assert.equal(modelsJson.providers.deepseek.models[1].reasoning, true);

const authJson = JSON.parse(fs.readFileSync(path.join(syncRes.agentDir, 'auth.json'), 'utf8'));
assert.equal(authJson.deepseek?.key, 'sk-deepseek-test');
assert.equal(authJson.openai?.key, 'sk-openai-test');
console.log('✔ syncPiConfigFromApp multi-provider passed');

// 测试 2.5: syncPiRetrySettings —— 无 retry 键时下发应用预算并保留其余键；用户手工值尊重
// （始终显式传 syncDir：写真实 ~/.pi/agent 会复现 2026-09-15 的密钥污染事故）
const retrySettingsPath = path.join(syncDir, 'settings.json');
const settingsAfterSync = JSON.parse(fs.readFileSync(retrySettingsPath, 'utf8'));
assert.equal(settingsAfterSync.retry.enabled, true, 'sync 后应下发 enabled:true');
assert.equal(settingsAfterSync.retry.maxRetries, PI_RETRY_MAX_RETRIES);
assert.equal(settingsAfterSync.retry.baseDelayMs, PI_RETRY_BASE_DELAY_MS);

const manualSettings = { myKey: 1, retry: { enabled: false, maxRetries: 9 } };
fs.writeFileSync(retrySettingsPath, JSON.stringify(manualSettings));
syncPiRetrySettings(syncDir);
assert.deepEqual(
  JSON.parse(fs.readFileSync(retrySettingsPath, 'utf8')),
  manualSettings,
  '用户手工配过 retry.maxRetries 必须原样保留'
);

// 显式 enabled:false（无 maxRetries）同样是手工决策，sync 不得改回 true
const disabledSettings = { myKey: 1, retry: { enabled: false } };
fs.writeFileSync(retrySettingsPath, JSON.stringify(disabledSettings));
syncPiRetrySettings(syncDir);
assert.deepEqual(
  JSON.parse(fs.readFileSync(retrySettingsPath, 'utf8')),
  disabledSettings,
  '用户显式关闭 retry（enabled:false）必须原样保留'
);

fs.writeFileSync(retrySettingsPath, JSON.stringify({ myKey: 1 }));
syncPiRetrySettings(syncDir);
const mergedSettings = JSON.parse(fs.readFileSync(retrySettingsPath, 'utf8'));
assert.equal(mergedSettings.myKey, 1, '其余键合并保留');
assert.equal(mergedSettings.retry.enabled, true);
assert.equal(mergedSettings.retry.maxRetries, PI_RETRY_MAX_RETRIES);
console.log('✔ syncPiRetrySettings passed');

// 测试 3: 存量单 OpenAIConfig 兼容同步
const legacyOpenAI = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'sk-legacy',
  model: 'deepseek-chat'
};
const legacyRes = syncPiConfigFromApp(legacyOpenAI, syncDir);
assert.equal(legacyRes.providerId, 'deepseek');
assert.equal(legacyRes.modelId, 'deepseek-chat');
console.log('✔ syncPiConfigFromApp legacy compatibility passed');

// 测试 4: 小米 MiMo V2.5 多模态与 1M 上下文配置同步
const mimoConfig = {
  providers: [
    {
      id: 'xiaomi',
      name: 'Xiaomi MiMo',
      baseUrl: 'https://api.xiaomi.com/v1',
      apiKey: 'sk-mimo-key',
      models: [
        { id: 'mimo-v2.5', name: 'Xiaomi MiMo V2.5' }
      ],
      enabled: true
    }
  ],
  activeProviderId: 'xiaomi',
  activeModelId: 'mimo-v2.5'
};
const mimoRes = syncPiConfigFromApp(mimoConfig, syncDir);
const mimoModelsJson = JSON.parse(fs.readFileSync(path.join(mimoRes.agentDir, 'models.json'), 'utf8'));
const mimoModel = mimoModelsJson.providers.xiaomi.models[0];
assert.equal(mimoModel.contextWindow, 1_000_000, 'unknown window falls back to 1,000,000');
assert.deepEqual(mimoModel.input, ['text', 'image'], 'MiMo should support image multimodal');
assert.equal(mimoModel.reasoning, true, 'MiMo should be marked reasoning');
assert.deepEqual(
  mimoModel.thinkingLevelMap,
  { off: null },
  'MiMo thinkingLevelMap.off=null prevents Pi from sending thinking:disabled'
);
const mimoCompat = mimoModelsJson.providers.xiaomi.compat;
assert.equal(mimoCompat.thinkingFormat, 'deepseek');
assert.equal(mimoCompat.requiresReasoningContentOnAssistantMessages, true);
console.log('✔ Xiaomi MiMo V2.5 multimodal and contextWindow inference passed');

// 测试 5: 支持自定义 API 协议 (openai-responses, anthropic-messages 等)
const responsesConfig = {
  providers: [
    {
      id: 'openai-responses',
      name: 'OpenAI Responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-responses',
      api: 'openai-responses',
      models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
      enabled: true
    }
  ],
  activeProviderId: 'openai-responses',
  activeModelId: 'gpt-4o'
};
const responsesRes = syncPiConfigFromApp(responsesConfig, syncDir);
const responsesModelsJson = JSON.parse(fs.readFileSync(path.join(responsesRes.agentDir, 'models.json'), 'utf8'));
assert.equal(responsesModelsJson.providers['openai-responses'].api, 'openai-responses');
console.log('✔ Custom API protocol (openai-responses) passed');

// Anthropic SDK 会在 baseUrl 后拼 /v1/messages，不能套 OpenAI 的 /v1 补全。
// Xiaomi 的 completions 专用默认方言也不能泄漏进 Anthropic 协议。
for (const [id, baseUrl] of [
  ['anthropic', ' https://api.anthropic.com/// '],
  ['xiaomi', ' https://api.xiaomimimo.com/anthropic/// ']
]) {
  const expectedBase = baseUrl.trim().replace(/\/+$/, '');
  const anthropicConfig = {
    providers: [{
      id,
      name: id,
      api: 'anthropic-messages',
      baseUrl,
      apiKey: 'sk-anthropic-test',
      models: [{ id: 'mimo-v2-pro', reasoning: true }],
      thinking: { reasoningEffortField: true, thinkingFormat: 'deepseek' }
    }],
    activeProviderId: id,
    activeModelId: 'mimo-v2-pro'
  };
  // driver 每次启动都会同步；重复同步也必须保持 URL 不变。
  for (let attempt = 0; attempt < 2; attempt++) {
    syncPiConfigFromApp(anthropicConfig, syncDir);
    const provider = JSON.parse(fs.readFileSync(path.join(syncDir, 'models.json'), 'utf8')).providers[id];
    assert.equal(provider.baseUrl, expectedBase, 'Anthropic baseUrl 不能追加 /v1');
    assert.equal(provider.api, 'anthropic-messages');
    assert.equal(provider.compat, undefined, '非 completions 且无用户显式 compat 项：整段不写（pi 自动探测）');
    assert.equal(provider.models[0].thinkingLevelMap, undefined, 'Xiaomi completions 的 off 默认不跨协议');
  }
}
console.log('✔ Anthropic baseUrl and Xiaomi protocol isolation passed');

// 测试 6: 思考强度映射（产品五档 → 服务商载荷值；空=不可用 null；重复映射允许；
// reasoningEffortField 开 compat 字段）
const thinkingConfig = {
  providers: [
    {
      id: 'thinking-prov',
      name: 'Thinking Provider',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-thinking',
      api: 'openai-completions',
      models: [{ id: 'm-reason', name: 'M Reason', reasoning: true }],
      enabled: true,
      thinking: {
        levels: { off: 'disable', low: 'soft', medium: 'soft', high: 'hard' }, // max 留空
        reasoningEffortField: true
      }
    }
  ],
  activeProviderId: 'thinking-prov',
  activeModelId: 'm-reason'
};
const thinkRes = syncPiConfigFromApp(thinkingConfig, syncDir);
const thinkJson = JSON.parse(fs.readFileSync(path.join(thinkRes.agentDir, 'models.json'), 'utf8'));
const thinkModel = thinkJson.providers['thinking-prov'].models[0];
assert.deepEqual(thinkModel.thinkingLevelMap, {
  off: 'disable',
  low: 'soft',
  medium: 'soft', // 服务商只有三档：产品多档重复映射到同一值
  high: 'hard',
  max: null // 留空=该档不可用
});
assert.equal(thinkJson.providers['thinking-prov'].compat.supportsReasoningEffort, true);
// 未配置 thinking 的服务商不受影响（默认仍不支持 reasoning_effort）
const plainRes = syncPiConfigFromApp(responsesConfig, syncDir);
const plainJson = JSON.parse(fs.readFileSync(path.join(plainRes.agentDir, 'models.json'), 'utf8'));
assert.equal(plainJson.providers['openai-responses'].compat, undefined, '无用户显式项的 completions 也不写 compat（pi 按 baseUrl 自动探测）');
assert.equal(plainJson.providers['openai-responses'].models[0].thinkingLevelMap, undefined);
console.log('✔ Thinking level mapping (five levels, duplicate mapping, reasoning_effort flag) passed');

// 测试 7: pi-ai 目录快照注入——内置 provider 走 modelOverrides 字段级继承，
// 自定义端点沿用同名价格计算，窗口与图片能力按端点解析
const { setPiCatalogSnapshot } = await import(pathToFileURL(entry).href);
setPiCatalogSnapshot({
  deepseek: {
    'deepseek-chat': {
      cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
      contextWindow: 65536,
      maxTokens: 8192,
      reasoning: false,
      input: ['text']
    },
    'deepseek-reasoner': {
      cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
      contextWindow: 65536,
      maxTokens: 65536,
      reasoning: true,
      input: ['text'],
      thinkingLevelMap: { off: null, high: 'default' }
    }
  }
}, [{ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', authMethods: ['apiKey'] }]);
const catalogConfig = {
  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-catalog',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek V3' },
        { id: 'deepseek-reasoner', name: 'DeepSeek R1', reasoning: true },
        { id: 'relay-alias-model', name: 'Relay Alias' }
      ],
      enabled: true
    },
    {
      id: 'my-relay',
      name: 'My Relay',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-relay',
      models: [
        { id: 'deepseek-chat', name: 'Relayed chat' },
        { id: 'unknown-model', name: 'Unknown', contextWindow: 32000 }
      ],
      enabled: true
    }
  ],
  activeProviderId: 'deepseek',
  activeModelId: 'deepseek-chat'
};
const catRes = syncPiConfigFromApp(catalogConfig, syncDir);
const catJson = JSON.parse(fs.readFileSync(path.join(catRes.agentDir, 'models.json'), 'utf8'));
// 内置 provider：目录内两个模型走 modelOverrides，目录外别名进 models
const dsProvider = catJson.providers.deepseek;
assert.ok(dsProvider.modelOverrides, '内置 provider 产出 modelOverrides');
assert.equal(Object.keys(dsProvider.modelOverrides).length, 2, '目录内两模型走 modelOverrides');
assert.deepEqual(dsProvider.modelOverrides['deepseek-chat'], { name: 'DeepSeek V3' }, '未显式配置的模型只写 name，价格/窗口全继承目录');
assert.deepEqual(
  dsProvider.modelOverrides['deepseek-reasoner'],
  { name: 'DeepSeek R1', reasoning: true },
  '显式 reasoning 落 overrides；不写 cost/contextWindow（不钉死目录值）'
);
assert.equal(dsProvider.models.length, 1);
assert.equal(dsProvider.models[0].id, 'relay-alias-model', '目录外模型仍写全量条目');
assert.deepEqual(dsProvider.models[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, '目录外模型无价（未知价语义）');
// 自定义 provider 的同名模型继续使用价格估计，未知输入规格使用保底值。
const relayModels = catJson.providers['my-relay'].models;
assert.deepEqual(relayModels[0].cost, { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 }, '自定义 provider 抄目录同名价格');
assert.equal(relayModels[0].contextWindow, 1_000_000, '同名网关独立使用保底窗口');
assert.deepEqual(relayModels[0].input, ['text', 'image']);
assert.equal(relayModels[1].contextWindow, 32000, '显式 contextWindow 优先');
assert.equal(relayModels[1].cost.input, 0, '目录外模型价格回落 0');
console.log('✔ Catalog snapshot (modelOverrides inheritance, relay copy, off-catalog fallback) passed');

// 测试 7.5: 用户思考映射保持全量契约（留空=不可用，不做目录合并）；未配置时目录 map 为默认
setPiCatalogSnapshot({
  deepseek: {
    'deepseek-reasoner': {
      reasoning: true,
      cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
      thinkingLevelMap: { off: null, medium: 'default', high: 'default' }
    },
    'deepseek-chat': {
      reasoning: false,
      cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 }
    }
  }
});
const mergedThinking = syncPiConfigFromApp(
  {
    providers: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-catalog',
        models: [
          { id: 'deepseek-reasoner', name: 'R1' },
          { id: 'deepseek-chat', name: 'Chat' }
        ],
        enabled: true,
        // 只配 high：五档全量契约，留空档不可用——不能被目录值悄悄填上
        thinking: { levels: { high: 'forced-high' } }
      }
    ],
    activeProviderId: 'deepseek',
    activeModelId: 'deepseek-reasoner'
  },
  syncDir
);
const mergedJson = JSON.parse(fs.readFileSync(path.join(mergedThinking.agentDir, 'models.json'), 'utf8'));
assert.deepEqual(
  mergedJson.providers.deepseek.modelOverrides['deepseek-reasoner'].thinkingLevelMap,
  { off: null, low: null, medium: null, high: 'forced-high', max: null },
  '用户思考映射全量契约：留空档=不可用，不被目录 map 悄悄填上'
);
assert.deepEqual(
  mergedJson.providers.deepseek.modelOverrides['deepseek-chat'].thinkingLevelMap,
  { off: null, low: null, medium: null, high: 'forced-high', max: null },
  'provider 级思考映射作用于全部模型（既有语义；pi 侧对非思考模型不生效）'
);
console.log('✔ Catalog thinkingLevelMap contract (user mapping is authoritative) passed');

setPiCatalogSnapshot(null);
// 清除快照后回落旧行为（内置 provider 回 models 全量条目）
const fallbackRes = syncPiConfigFromApp(catalogConfig, syncDir);
const fallbackJson = JSON.parse(fs.readFileSync(path.join(fallbackRes.agentDir, 'models.json'), 'utf8'));
assert.ok(fallbackJson.providers.deepseek.models, '无快照回落：内置 provider 仍写 models 全量条目');
assert.equal(fallbackJson.providers.deepseek.modelOverrides, undefined);
console.log('✔ Snapshot cleared fallback (legacy models shape) passed');

// ── 回归守卫：真实 ~/.pi/agent 全程未被本测试触碰 ──────────────────────────────
// 任何一项哈希漂移都说明有 sync 调用又漏传了 targetDir（或外部进程恰在此时改写；
// 后者重跑即恢复，前者会稳定复现）。
for (const name of GUARD_FILES) {
  assert.equal(
    sha256Of(path.join(piAgentDir, name)),
    realConfigSnapshot.get(name),
    `真实 ~/.pi/agent/${name} 被改写——syncPiConfigFromApp 是否漏传 targetDir？` +
      `（安装版应用恰在运行并重同步也会触发，重跑即可恢复；稳定复现=漏传。2026-09-15 生产 401 事故守卫）`
  );
}
fs.rmSync(syncDir, { recursive: true, force: true });
console.log('✔ 真实 ~/.pi/agent 未被污染（regression guard）passed');

console.log('All flexible LLM tests passed!');
