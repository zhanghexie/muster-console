/**
 * 模型服务商目录化接缝回归（审计 model-providers F-01/F-03，2026-10 修复）：
 *
 * F-01 连通性探针 /v1 归一化：探针此前直接 baseUrl + '/chat/completions'，而真实请求经
 * pi 的 normalizePiBaseUrl 自动补 /v1——网关 baseUrl 不带 /vN 时「测试连通性」误报失败，
 * 保存后实际对话却能通（探针结论与运行时能力相反）。修复：非 anthropic 协议探针复用同款归一化。
 *
 * F-03 目录判定加端点一致条件：存量用户在目录化之前用旧 preset id（deepseek/zhipu 等）建过
 * 指向企业网关/反代的自定义 provider，升级后 id 命中目录即被收编——piConfigSync 目录分支丢弃
 * p.api 与用户思考映射，端点/协议被静默替换。修复：baseUrl 与目录官方端点不一致时按自定义
 * provider 处理（保留 api/thinking，模型写全量条目）；端点一致或目录无端点信息时维持目录分支。
 *
 * 还原修复即红。运行: node test/model-provider-catalog-quirks.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-provider-quirks-'));
const compile = createSharedCompiler(root, tmp);

// ── F-01：探针 URL 与运行时同款 /v1 归一化 ────────────────────────────────────
const { testLlmConnection } = await import(pathToFileURL(compile('main/agent/openaiClient.ts')).href);
const probeUrls = [];
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    probeUrls.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

try {
  // 审计复现路径：网关 baseUrl 不带 /vN → 探针必须补 /v1（与运行时 pi 一致），不再误报 404
  await testLlmConnection({ baseUrl: origin, apiKey: 'sk-x', api: 'openai-completions' });
  assert.equal(probeUrls.at(-1), '/v1/chat/completions', 'F-01: 不带 /vN 的 completions 网关探针须补 /v1');

  await testLlmConnection({ baseUrl: ` ${origin}/gw//// `, apiKey: 'sk-x', api: 'openai-completions' });
  assert.equal(probeUrls.at(-1), '/gw/v1/chat/completions', 'F-01: 尾斜杠清理后再补 /v1');

  await testLlmConnection({ baseUrl: `${origin}/api/paas/v4`, apiKey: 'sk-x', api: 'openai-completions' });
  assert.equal(probeUrls.at(-1), '/api/paas/v4/chat/completions', 'F-01: 已带 /vN 的端点不重复补 /v1');

  await testLlmConnection({ baseUrl: origin, apiKey: 'sk-x', api: 'openai-responses' });
  assert.equal(probeUrls.at(-1), '/v1/responses', 'F-01: responses 协议同样补 /v1');

  // anthropic 原行为保留（SDK 对齐路径，勿套 OpenAI 归一化造成 /v1/v1）
  await testLlmConnection({ baseUrl: origin, apiKey: 'sk-x', api: 'anthropic-messages', model: 'claude-x' });
  assert.equal(probeUrls.at(-1), '/v1/messages', 'F-01: anthropic 保持 /v1/messages（不产生 /v1/v1）');

  // ── F-03：目录分支按「端点一致」守门 ────────────────────────────────────────
  const piSync = await import(pathToFileURL(compile('main/agent/piConfigSync.ts')).href);
  const syncDir = path.join(tmp, 'pi-agent');
  const snapshot = {
    deepseek: {
      'deepseek-v4-pro': {
        contextWindow: 1000000,
        maxTokens: 65536,
        reasoning: true,
        input: ['text'],
        cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 }
      }
    }
  };
  const metas = [
    { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', authMethods: ['apiKey'] }
  ];
  piSync.setPiCatalogSnapshot(snapshot, metas);
  const readSynced = () =>
    JSON.parse(fs.readFileSync(path.join(syncDir, 'models.json'), 'utf8')).providers.deepseek;
  const sync = (provider) =>
    piSync.syncPiConfigFromApp(
      { providers: [provider], activeProviderId: provider.id, activeModelId: provider.models[0].id },
      syncDir
    );

  // 1) 存量「目录 id + 企业网关端点」：按自定义处理——api 与用户思考映射保留，模型全量条目
  sync({
    id: 'deepseek',
    name: 'DeepSeek (企业网关)',
    baseUrl: 'https://gw.example.com',
    apiKey: 'sk-gw',
    api: 'openai-responses',
    thinking: { levels: { high: 'forced' } },
    models: [{ id: 'deepseek-v4-pro', name: 'V4P' }],
    enabled: true
  });
  const gw = readSynced();
  assert.equal(gw.api, 'openai-responses', 'F-03: 网关条目保留 p.api（协议不被目录静默替换）');
  assert.equal(gw.baseUrl, 'https://gw.example.com/v1', 'F-03: 网关 baseUrl 原样同步（补 /v1）');
  assert.equal(gw.modelOverrides, undefined, 'F-03: 端点不一致不走目录 modelOverrides 分支');
  assert.equal(gw.models[0].thinkingLevelMap.high, 'forced', 'F-03: 用户思考映射保留（目录分支会丢弃）');
  assert.equal(gw.models[0].contextWindow, 1000000, 'F-03: 自定义分支仍按 id 抄目录同名默认值');

  // 首次设置允许粘贴带 /v1 的 Anthropic Base URL，Core 和探针应请求同一路径。
  sync({ id: 'deepseek', name: 'Anthropic-compatible gateway', baseUrl: `${origin}/anthropic/v1/`,
    apiKey: 'fixture-key', api: 'anthropic-messages', models: [{ id: 'claude-fixture' }] });
  assert.equal(readSynced().baseUrl, `${origin}/anthropic`);
  assert.equal(readSynced().api, 'anthropic-messages');

  // 2) 端点与目录一致：维持目录分支（modelOverrides 字段级继承，协议交目录）
  sync({
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-ds',
    models: [{ id: 'deepseek-v4-pro', name: 'V4P' }],
    enabled: true
  });
  const ds = readSynced();
  assert.ok(ds.modelOverrides?.['deepseek-v4-pro'], 'F-03: 端点一致仍走目录分支（modelOverrides 继承）');
  assert.equal(ds.models, undefined, '端点一致：目录内模型不写 models 全量条目（既有语义）');
  assert.equal(ds.api, undefined, '端点一致：协议由目录说了算（既有语义）');

  // 3) 目录 meta 缺 baseUrl（或未注入 metas）：无从比对，维持目录分支（不回归）
  piSync.setPiCatalogSnapshot(snapshot, [{ id: 'deepseek', name: 'DeepSeek', authMethods: ['apiKey'] }]);
  sync({
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://gw2.example.com',
    apiKey: 'sk-gw2',
    models: [{ id: 'deepseek-v4-pro', name: 'V4P' }],
    enabled: true
  });
  assert.ok(readSynced().modelOverrides, 'F-03: 目录无端点信息时维持目录分支（back-compat）');

  piSync.setPiCatalogSnapshot(snapshot, metas);
  const auto = sync({ id: 'deepseek', name: 'Fixture', baseUrl: origin, models: [
    { id: 'qwen4-max-preview' }, { id: 'deepseek-v4-pro' }, { id: 'unknown' }, { id: 'custom-cap', maxTokens: 8192 }
  ] });
  const budgets = Object.fromEntries(readSynced().models.map(m => [m.id, m.maxTokens]));
  assert.equal(budgets['qwen4-max-preview'], 393216);
  assert.equal(budgets['deepseek-v4-pro'], snapshot.deepseek['deepseek-v4-pro'].maxTokens);
  assert.equal(budgets['custom-cap'], 8192);
  assert.deepEqual(auto.providerDefaultOutput, [{ provider: 'deepseek', id: 'unknown' }]);
  piSync.setPiCatalogSnapshot(null, null);
  console.log('model-provider-catalog-quirks: ok');
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}
