/**
 * 模型服务商思考配置链路测试：
 * 1) normalize 往返 thinking 存活（回归：normalizeProvider 白名单曾把 thinking 剥掉，
 *    保存/重启后五档映射与 reasoning_effort 勾选静默丢失）；
 * 2) thinkingFormat 枚举校验与全空收口；
 * 3) piConfigSync 把显式方言/五档映射透传进 Pi compat（含小米默认覆盖、非 completions 协议不下发）。
 * 运行: node test/llm-thinking-config.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-thinking-config-'));
const compile = createSharedCompiler(root, tmp);

// electron shim：ConfigManager 构造时 app.getPath('userData') 指向临时 userdata
const userData = path.join(tmp, 'userdata');
fs.mkdirSync(userData, { recursive: true });
const electronDir = path.join(tmp, 'node_modules', 'electron');
fs.mkdirSync(electronDir, { recursive: true });
fs.writeFileSync(
  path.join(electronDir, 'package.json'),
  JSON.stringify({ name: 'electron', type: 'module', main: 'index.mjs' })
);
fs.writeFileSync(
  path.join(electronDir, 'index.mjs'),
  `export const app = { getPath: () => ${JSON.stringify(userData)} };\nexport default { app };\n`
);

const configMod = await import(pathToFileURL(compile('main/config.ts')));
const piSync = await import(pathToFileURL(compile('main/agent/piConfigSync.ts')));

const realPi = path.join(os.homedir(), '.pi', 'agent');
const sha256Of = (p) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch {
    return null;
  }
};
const realPiSnapshot = new Map(
  ['models.json', 'auth.json', 'settings.json', 'mcp.json'].map((name) => [name, sha256Of(path.join(realPi, name))])
);

// ---------- normalize 往返：thinking 存活 ----------
{
  const seed = {
    llm: {
      providers: [
        {
          id: 'zhipu',
          name: '智谱',
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          apiKey: 'sk-test',
          models: [{ id: 'glm-4.7', reasoning: true, multimodal: false,
            attachments: { nativeAudio: true, nativeFiles: true, maxFileMB: 24, videoFrames: 4, ffmpegPath: 'legacy-ffmpeg', mimeTypes: ['application/pdf'] } }],
          thinking: {
            levels: { off: 'false', low: 'low', high: 'high' },
            reasoningEffortField: true,
            thinkingFormat: 'zai'
          }
        }
      ],
      activeProviderId: 'zhipu',
      activeModelId: 'glm-4.7'
    }
  };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(seed));
  const formerGuiHome = path.join(userData, 'agents', 'pi', 'home');
  const oldModels = JSON.stringify({ providers: { 'previous-home-only': {} } });
  fs.mkdirSync(formerGuiHome, { recursive: true });
  fs.writeFileSync(path.join(formerGuiHome, 'models.json'), oldModels);

  const cm = new configMod.ConfigManager();
  const provider = cm.get().llm.providers[0];
  assert.ok(provider.thinking, 'load 后 thinking 必须保留（normalizeProvider 白名单回归）');
  assert.equal(provider.models[0].multimodal, false);
  assert.equal(provider.models[0].attachments.nativeAudio, true);
  assert.equal(provider.models[0].attachments.videoFrames, undefined);
  assert.deepEqual(cm.get().attachmentProcessing, { maxFileMB: 24, videoFrames: 4 });
  assert.equal(provider.thinking.thinkingFormat, 'zai');
  assert.equal(provider.thinking.levels.low, 'low');
  assert.equal(provider.thinking.reasoningEffortField, true);

  // update 路径：未触及 thinking 的 patch 不能把它洗掉
  cm.update({
    llm: { ...seed.llm, providers: [{ ...seed.llm.providers[0], name: '智谱2' }] }
  });
  const coreHome = path.join(userData, 'muster-core');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(coreHome, 'models.json'), 'utf8')).providers), ['zhipu']);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(coreHome, 'auth.json'), 'utf8'))), ['zhipu']);
  assert.equal(fs.readFileSync(path.join(formerGuiHome, 'models.json'), 'utf8'), oldModels);
  const after = cm.get().llm.providers[0];
  assert.equal(after.name, '智谱2');
  assert.deepEqual(after.models[0].attachments, { nativeAudio: true, nativeFiles: true, mimeTypes: ['application/pdf'] });
  assert.deepEqual(cm.get().attachmentProcessing, { maxFileMB: 24, videoFrames: 4 });
  assert.deepEqual(new configMod.ConfigManager().get().attachmentProcessing, cm.get().attachmentProcessing);
  assert.deepEqual(new configMod.ConfigManager().get().attachmentTools, { ffmpegPath: 'legacy-ffmpeg' });
  cm.update({ attachmentProcessing: { autoPages: 2 } });
  assert.deepEqual(cm.get().attachmentProcessing, { autoPages: 2 });
  cm.update({ attachmentTools: {} });
  assert.deepEqual(new configMod.ConfigManager().get().attachmentTools, {});
  assert.deepEqual(new configMod.ConfigManager().get().attachmentProcessing, { autoPages: 2 });
  assert.equal(after.thinking?.thinkingFormat, 'zai', 'update 后 thinking 必须保留');

  // 新建服务商的空模型列表必须跨保存/重启保留，不能被 normalizeProvider
  // 静默补成 default 模型；运行时调用仍有独立的 default 兜底。
  const emptyProvider = {
    id: 'empty-provider', name: 'Empty provider', baseUrl: 'https://empty.example/v1', apiKey: '', models: [], enabled: true
  };
  cm.update({ llm: { providers: [emptyProvider], activeProviderId: 'empty-provider', activeModelId: 'default' } });
  assert.deepEqual(cm.get().llm.providers[0].models, [], '保存设置时空模型列表不能自动添加 default');
  assert.deepEqual(new configMod.ConfigManager().get().llm.providers[0].models, [], '重新加载后仍应等待用户选择模型');

  // 非法 thinkingFormat 被剥除；仅 reasoningEffortField:false 的全空 thinking 收掉
  cm.update({
    llm: {
      ...seed.llm,
      providers: [
        {
          ...seed.llm.providers[0],
          thinking: { ...seed.llm.providers[0].thinking, thinkingFormat: 'not-a-dialect' }
        },
        {
          id: 'plain',
          name: 'plain',
          baseUrl: 'https://example.com/v1',
          apiKey: '',
          models: [{ id: 'm' }],
          thinking: { reasoningEffortField: false }
        }
      ]
    }
  });
  assert.equal(cm.get().llm.providers[0].thinking?.thinkingFormat, undefined, '非法方言必须被剥除');
  assert.equal(cm.get().llm.providers[1].thinking, undefined, '全空思考配置应收掉');

  // disableAtOff 往返存活；false 归一化掉
  cm.update({
    llm: {
      ...seed.llm,
      providers: [
        { ...seed.llm.providers[0], thinking: { levels: { low: 'low' }, disableAtOff: true } },
        { id: 'plain2', name: 'plain2', baseUrl: 'https://x.example/v1', apiKey: '', models: [{ id: 'm' }], thinking: { disableAtOff: false } }
      ]
    }
  });
  assert.equal(cm.get().llm.providers[0].thinking?.disableAtOff, true, 'disableAtOff 往返必须保留');
  assert.equal(cm.get().llm.providers[1].thinking, undefined, 'disableAtOff:false 应归一化收掉');
}

// ---------- piConfigSync：方言/映射透传 compat ----------
{
  const piDir = path.join(tmp, 'pi-agent');
  const providerBase = {
    id: 'zhipu',
    name: '智谱',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: 'sk',
    api: 'openai-completions',
    models: [{ id: 'glm-4.7', reasoning: true }],
    thinking: { levels: { low: 'low', high: 'high' }, reasoningEffortField: true, thinkingFormat: 'zai' }
  };
  const cfg = {
    openai: { baseUrl: '', apiKey: '', model: '' },
    llm: { providers: [{ ...providerBase }], activeProviderId: 'zhipu', activeModelId: 'glm-4.7' }
  };

  piSync.syncPiConfigFromApp(cfg, piDir);
  const models = JSON.parse(fs.readFileSync(path.join(piDir, 'models.json'), 'utf-8'));
  const p = models.providers.zhipu;
  assert.equal(p.compat.thinkingFormat, 'zai', '显式方言必须进 compat');
  assert.equal(p.compat.supportsReasoningEffort, true);
  assert.equal(p.models[0].thinkingLevelMap.low, 'low');

  // 非 completions 协议：方言与 effort 开关都不下发
  cfg.llm.providers[0] = { ...providerBase, api: 'anthropic-messages' };
  piSync.syncPiConfigFromApp(cfg, piDir);
  const models2 = JSON.parse(fs.readFileSync(path.join(piDir, 'models.json'), 'utf-8'));
  // 非 completions 协议：方言与 effort 开关都不下发（无任何用户显式 compat 项时整段不写，pi 自动探测）
  assert.equal(models2.providers.zhipu.compat, undefined, '非 completions 协议不下发方言（compat 整段缺省）');

  // 用户显式方言压过小米默认 deepseek
  cfg.llm.providers[0] = {
    ...providerBase,
    id: 'xiaomi',
    baseUrl: 'https://api.xiaomi.com/v1',
    thinking: { ...providerBase.thinking, thinkingFormat: 'openai' }
  };
  piSync.syncPiConfigFromApp(cfg, piDir);
  const models3 = JSON.parse(fs.readFileSync(path.join(piDir, 'models.json'), 'utf-8'));
  assert.equal(models3.providers.xiaomi.compat.thinkingFormat, 'openai', '用户显式方言压过小米默认');
}

// ---------- piConfigSync：disableAtOff 按协议/方言门控翻译为 off 哨兵 ----------
{
  const piDir = path.join(tmp, 'pi-agent-disableatoff');
  const mk = (over) => ({
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk',
    api: 'openai-completions',
    models: [{ id: 'deepseek-v4-flash', reasoning: true }],
    thinking: { levels: { low: 'low' }, ...over }
  });
  const read = () => JSON.parse(fs.readFileSync(path.join(piDir, 'models.json'), 'utf-8'));

  // deepseek 系 completions：disableAtOff → off 哨兵
  const cfg1 = {
    openai: { baseUrl: '', apiKey: '', model: '' },
    llm: { providers: [mk({ disableAtOff: true })], activeProviderId: 'deepseek', activeModelId: 'deepseek-v4-flash' }
  };
  piSync.syncPiConfigFromApp(cfg1, piDir);
  assert.equal(read().providers.deepseek.models[0].thinkingLevelMap.off, 'disabled', 'DeepSeek 系 disableAtOff 必须打 off 哨兵');

  // responses 协议（GLM-5.3 系禁止关闭）：disableAtOff 不翻译
  const cfg2 = {
    openai: { baseUrl: '', apiKey: '', model: '' },
    llm: {
      providers: [{ ...mk({ disableAtOff: true }), id: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/v1', api: 'openai-responses' }],
      activeProviderId: 'zhipu',
      activeModelId: 'GLM-5.3-Flash'
    }
  };
  piSync.syncPiConfigFromApp(cfg2, piDir);
  assert.equal(read().providers.zhipu.models[0].thinkingLevelMap.off, null, 'responses 协议不翻译 disableAtOff');

  // 非 DeepSeek 的 completions：不翻译（openai 方言会把哨兵当 effort 发出去，必须拦住）
  const cfg3 = {
    openai: { baseUrl: '', apiKey: '', model: '' },
    llm: {
      providers: [{ ...mk({ disableAtOff: true }), id: 'gateway', baseUrl: 'https://gw.example.com/v1' }],
      activeProviderId: 'gateway',
      activeModelId: 'deepseek-v4-flash'
    }
  };
  piSync.syncPiConfigFromApp(cfg3, piDir);
  assert.equal(read().providers.gateway.models[0].thinkingLevelMap.off, null, '非 DeepSeek 系 completions 不打 off 哨兵');
}

for (const [name, before] of realPiSnapshot) {
  const after = sha256Of(path.join(realPi, name));
  assert.equal(
    after,
    before,
    `真实 ~/.pi/agent/${name} 被 ConfigManager.update 夹具改写（2026-09-16 sk-test 污染）`
  );
}

console.log('llm-thinking-config: all assertions passed');
