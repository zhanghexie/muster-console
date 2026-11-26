import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';

// Models.dev is MIT licensed. Import only declared controls for a supported wire format.
const upstream = 'https://models.opencode.ai/experimental/v2.0/api.json?type=chat';
const modelsDevSource = 'https://github.com/anomalyco/models.dev/tree/dev/providers/';
const piSource = 'https://github.com/earendil-works/pi/tree/v1.4.0/packages/ai';
const safeEffort = /^[a-z][a-z0-9_-]{0,127}$/;
const excludedValues = new Set(['on', 'off', 'none', 'default']);
const gatewayIds = new Set(['opencode', 'opencode-go', 'ollama-cloud']);
const inputModalities = ['text', 'image', 'audio', 'video', 'pdf'];
const apiProtocols = {
  'chat-completions': 'openai-completions', responses: 'openai-responses', messages: 'anthropic-messages',
  'generate-content': 'google-generative-ai', converse: 'bedrock-converse-stream'
};

function catalogEndpoint(value, protocol) {
  const url = typeof value === 'string' && URL.parse(value);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || value.includes('${')) return;
  const endpoint = url.href.replace(/\/+$/, '');
  if (['openai-completions', 'openai-responses', 'azure-openai-responses'].includes(protocol) && !/\/v\d+$/i.test(endpoint)) {
    return `${endpoint}/v1`;
  }
  return protocol === 'anthropic-messages' ? endpoint.replace(/\/v1$/, '') : endpoint;
}

function declaredInput(modalities) {
  if (!Array.isArray(modalities)) return;
  const groups = new Set(modalities.filter(value => typeof value === 'string')
    .map(value => value === 'application/pdf' ? 'pdf' : value.split('/')[0]));
  const input = inputModalities.filter(value => groups.has(value));
  return input.length ? input : undefined;
}

function wireFormat(provider, model, key, route, builtin) {
  const pkg = route.sdk?.opencodeai ?? '';
  if (key === 'responses') {
    if (pkg === '@opencode/ai/providers/openai/responses') return 'openai';
    return;
  }
  if (key !== 'chat-completions' || typeof route.base_url !== 'string') return;
  if (provider === 'siliconflow-cn' && route.base_url === 'https://api.siliconflow.cn/v1') return 'siliconflow';
  if (pkg.startsWith('@opencode/ai/providers/alibaba/')) return 'qwen';
  if (pkg === '@opencode/ai/providers/openai/chat') return 'openai-chat';
  if (pkg.startsWith('@opencode/ai/providers/deepseek')) return 'deepseek';
  if (pkg === '@opencode/ai/providers/zai/chat' || pkg === '@opencode/ai/providers/zai-coding-plan/chat') return 'zai';
  if (pkg === '@opencode/ai/providers/moonshot/chat') {
    if (/k2[.-][56]/i.test(model.id)) return 'deepseek';
    if (!/k2[.-]7-code|k2-thinking/i.test(model.id)) return 'openai-chat';
    return;
  }
  if ((builtin.has(provider) || gatewayIds.has(provider)) && pkg === '@opencode/ai/providers/openai-compatible') return 'openai-chat';
}

function importDeclaredControls(model, format) {
  const declared = model.capabilities?.reasoning;
  if (!declared?.supported) return;
  const values = Array.isArray(declared.effort) ? declared.effort : [];
  // OpenCode's generic OpenAI adapter exposes only effort. It sends an explicit "none" value when present.
  const toggle = declared.toggle === true && !['openai', 'openai-chat'].includes(format) &&
    !(format === 'zai' && /glm-?(?:5[.-]([3-9]|\d{2,})|[6-9])/i.test(model.id));
  const effort = [...new Set(values.filter(value => typeof value === 'string' && safeEffort.test(value) &&
    !excludedValues.has(value) && !value.startsWith('budget-') && !(format === 'zai' && value === 'minimal')))];
  if (format === 'deepseek' && /^kimi-/i.test(model.id)) effort.length = 0;
  const canDisable = toggle || values.includes('none') || (format === 'zai' && values.includes('minimal'));
  const canEnable = toggle && !effort.length;
  const minimum = declared.budget?.min ?? (format === 'siliconflow' ? 128 : 1);
  const maximum = declared.budget?.max;
  const budget = ['qwen', 'siliconflow'].includes(format) && !effort.length && Number.isSafeInteger(minimum) &&
    Number.isSafeInteger(maximum) && minimum >= 1 && maximum >= minimum && maximum <= 2_000_000
    ? { min: minimum, max: maximum } : undefined;
  if (!effort.length && !canDisable && !canEnable && !budget) return;
  const defaultValue = declared.default?.value;
  const defaultEffort = effort.includes(defaultValue) ? defaultValue :
    (defaultValue === false || defaultValue === 'none') && canDisable ? 'off' : defaultValue === true && canEnable ? 'on' : undefined;
  return { format, effort, canDisable, ...(canEnable ? { canEnable } : {}), ...(budget ? { budget } : {}),
    ...(defaultEffort === undefined ? {} : { defaultEffort }) };
}

const alias = { 'siliconflow-cn': 'siliconflow', 'alibaba-cn': 'qwen', zhipuai: 'zhipu', 'moonshotai-cn': 'moonshot',
  'alibaba-token-plan-cn': 'qwen-token-plan-cn' };
const supplementaryProviders = new Set([...Object.keys(alias), 'alibaba', 'alibaba-token-plan', 'alibaba-token-plan-individual',
  'alibaba-coding-plan', 'alibaba-coding-plan-cn', 'zhipuai-coding-plan', 'ollama-cloud']);

const dashscope = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const verifiedOverrides = [{
  providerId: 'qwen', baseUrl: dashscope, protocol: 'openai-completions', modelId: 'qwen4-max',
  reasoning: { format: 'qwen', effort: ['low', 'high', 'xhigh'], defaultEffort: 'high', canDisable: true },
  sources: ['https://help.aliyun.com/zh/model-studio/qwen4-max', 'https://help.aliyun.com/zh/model-studio/deep-thinking']
}];

export function buildModelReasoningCatalog(modelsDev, revision,
  builtinModels = new Map(getBuiltinProviders().map(id => [id, getBuiltinModels(id)])), officialCapabilities = []) {
  if (!modelsDev || typeof modelsDev !== 'object' || !/^\d{4}-\d{2}-\d{2}\.\d{1,10}$/.test(revision)) throw new Error('Invalid inputs');
  if (!Array.isArray(officialCapabilities)) throw new Error('Expected an array of verified model specifications');
  const pi = Object.fromEntries([...builtinModels].flatMap(([provider, rows]) => rows.length ? [[provider, rows.map(model => {
    const { id, api, baseUrl, reasoning, thinkingLevelMap, compat } = model;
    return { id, api, baseUrl, reasoning, ...(thinkingLevelMap ? { thinkingLevelMap } : {}), ...(compat ? { compat } : {}) };
  })]] : []));
  const models = new Map();
  const capabilities = new Map();
  const put = row => models.set(JSON.stringify([row.providerId, row.baseUrl, row.protocol, row.modelId]), row);
  const putCapability = (row, official = false) => {
    const { providerId, protocol, modelId, sources } = row;
    const baseUrl = catalogEndpoint(row.baseUrl, protocol);
    const input = official ? row.input : declaredInput(row.input);
    const window = Number.isSafeInteger(row.contextWindow) && row.contextWindow > 0 ? row.contextWindow : undefined;
    if (!baseUrl || (window === undefined && !input)) {
      if (official) throw new Error(`Invalid official model specification: ${providerId}/${modelId}`);
      return;
    }
    const key = JSON.stringify([providerId, baseUrl, protocol, modelId]);
    const previous = capabilities.get(key);
    capabilities.set(key, { providerId, baseUrl, protocol, modelId,
      ...(previous?.contextWindow !== undefined ? { contextWindow: previous.contextWindow } : {}),
      ...(previous?.input ? { input: previous.input } : {}),
      ...(window !== undefined ? { contextWindow: window } : {}), ...(input ? { input } : {}),
      ...(official && input ? { verified: true } : {}),
      sources: [...new Set([...sources, ...(previous?.sources ?? [])])] });
  };
  for (const [providerId, rows] of builtinModels) {
    for (const { id, api, baseUrl, contextWindow, input } of rows) {
      putCapability({ providerId, baseUrl, protocol: api, modelId: id, contextWindow, input, sources: [piSource] });
    }
  }
  for (const [id, vendor] of Object.entries(modelsDev)) {
    if (!(builtinModels.has(id) || supplementaryProviders.has(id)) || !vendor?.models) continue;
    for (const model of Object.values(vendor.models)) {
      if (typeof model.id !== 'string') continue;
      for (const [key, route] of Object.entries(model.api ?? {})) {
        const base = URL.parse(route?.base_url ?? '');
        if (!base || base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || route.base_url.includes('${')) continue;
        const protocol = Object.hasOwn(apiProtocols, key) ? apiProtocols[key] : undefined;
        if (protocol) putCapability({ providerId: alias[id] ?? id, baseUrl: base.href, protocol, modelId: model.id,
          contextWindow: route.limit?.context ?? model.limit?.context,
          input: route.modalities?.input ?? model.modalities?.input, sources: [`${modelsDevSource}${id}`] });
        const format = wireFormat(id, model, key, route, builtinModels);
        if (!format) continue;
        const reasoning = importDeclaredControls(model, format);
        if (!reasoning) continue;
        const baseUrl = base.href.replace(/\/+(?=$)/, '') || base.href;
        put({ providerId: alias[id] ?? id, baseUrl, protocol: key === 'responses' ? 'openai-responses' : 'openai-completions',
          modelId: model.id, reasoning, sources: [`${modelsDevSource}${id}`] });
      }
    }
  }
  for (const row of verifiedOverrides) put(row);
  for (const row of officialCapabilities) putCapability(row, true);
  return { schemaVersion: 2, revision, pi, models: [...models.values()], capabilities: [...capabilities.values()], sources: [
    'https://github.com/earendil-works/pi/blob/v1.4.0/LICENSE', 'https://github.com/anomalyco/models.dev/blob/dev/LICENSE', upstream
  ] };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' }, revision: { type: 'string' },
    'official-capabilities': { type: 'string' } } });
  if (!values.output || !values.revision) throw new Error('Provide --output and --revision');
  const data = values.input ? JSON.parse(await fs.readFile(values.input, 'utf8')) : await (async () => {
    const response = await fetch(upstream, { signal: AbortSignal.timeout(20_000), redirect: 'error', credentials: 'omit' });
    if (!response.ok) throw new Error(`Models.dev HTTP ${response.status}`);
    return response.json();
  })();
  const official = values['official-capabilities'] ? JSON.parse(await fs.readFile(values['official-capabilities'], 'utf8')) : [];
  const catalog = buildModelReasoningCatalog(data, values.revision, undefined, official);
  await fs.writeFile(values.output, `${JSON.stringify(catalog)}\n`);
  console.log(`${Object.keys(catalog.pi).length} Pi provider shards, ${catalog.models.length} reasoning overlays, ${catalog.capabilities.length} input specifications`);
}
