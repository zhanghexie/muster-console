/**
 * 划词「文本工具」自测：配置归一、模型逐级回落、两种 API 协议的请求构造。
 * 运行: node test/text-tools.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-test-'));
// runTextTool.ts → main/config.ts 有 `import { app } from 'electron'`：仓库外的临时
// 目录解析不到 electron，仿 shared-compile 的 i18next shim 在 tmp 种一个最小 ESM 桩
// （app 只在 ConfigManager 构造时才用 getPath，本测试不实例化，模块加载不触达）
const electronDir = path.join(tmp, 'node_modules', 'electron');
fs.mkdirSync(electronDir, { recursive: true });
fs.writeFileSync(
  path.join(electronDir, 'package.json'),
  JSON.stringify({ name: 'electron', type: 'module', main: 'index.mjs' })
);
fs.writeFileSync(
  path.join(electronDir, 'index.mjs'),
  "const app = { getPath: () => '/tmp-metaagent-test' };\nexport { app };\nexport default { app };\n"
);
// shared-compile 按依赖树转译 runTextTool 及其相对依赖（含 config/profiles/i18n 等）
const compile = createSharedCompiler(root, tmp);

const sharedOut = compile('shared/textTools.ts');
const runnerOut = compile('main/textTools/runTextTool.ts');

const shared = await import(pathToFileURL(sharedOut).href);
const runner = await import(pathToFileURL(runnerOut).href);
// 与 runner 内部同一 key 语义对账：断言「报错必须经 t() 路由」而非固定串
// （词条未落 en 时两侧同为回退原文；词条落地后两侧同为插值结果，断言两态皆稳）
const { t } = await import(pathToFileURL(compile('shared/i18n/index.ts')).href);

// ---------- 0. 关闭思考启发式 ----------
const T = runner.buildThinkingOffParams;
assert.deepEqual(
  T('qwen3-max', 'openai-completions', 'https://dash.example.com'),
  { enable_thinking: false, chat_template_kwargs: { enable_thinking: false } }
);
assert.deepEqual(T('GLM-4.6', 'openai-completions', 'https://open.bigmodel.cn'), {
  thinking: { type: 'disabled' }
});
assert.deepEqual(T('doubao-seed-1.6', 'openai-completions', 'https://x'), {
  thinking: { type: 'disabled' }
});
assert.equal(T('gpt-5-mini', 'openai-completions', 'https://api.openai.com/v1').reasoning_effort, 'minimal');
assert.deepEqual(T('gpt-5-mini', 'openai-responses', 'https://api.openai.com/v1').reasoning, { effort: 'minimal' });
assert.equal(T('o3', 'openai-completions', 'https://api.openai.com/v1').reasoning_effort, 'low');
assert.deepEqual(T('some-model', 'openai-completions', 'https://openrouter.ai/api/v1'), {
  reasoning: { enabled: false }
});
assert.deepEqual(
  T('gpt-5-mini', 'openai-responses', 'https://openrouter.ai/api/v1').reasoning,
  { enabled: false, effort: 'minimal' }
);
assert.equal(T('deepseek-reasoner', 'openai-completions', 'https://api.deepseek.com'), null);
assert.equal(T('gpt-4o', 'openai-completions', 'https://api.openai.com/v1'), null);
console.log('✔ 关闭思考启发式：按模型/网关附加参数，未识别不附加');

// ---------- 1. normalizeTextTools ----------
const FALLBACK = shared.normalizeTextTools(undefined, {
  functions: [shared.DEFAULT_TRANSLATE_FUNCTION]
});
assert.equal(FALLBACK.functions.length, 1);
assert.equal(FALLBACK.functions[0].id, 'translate');
assert.equal(FALLBACK.functions[0].name, '翻译');
assert.equal(FALLBACK.functions[0].enabled, true);
console.log('✔ normalizeTextTools: 缺省回落内置翻译');

const cleaned = shared.normalizeTextTools(
  {
    functions: [
      { id: 'a', name: ' 表格 ', prompt: 'p1', enabled: false, providerId: ' dp ', modelId: ' m1 ' },
      { id: 'a', name: '重复id应丢弃', prompt: 'x' },
      { name: '缺id应丢弃', prompt: 'x' },
      { id: 'b', name: '空提示词保留', prompt: '' },
      'not-an-object'
    ],
    defaultProviderId: ' dp ',
    defaultModelId: ''
  },
  { functions: [] }
);
assert.equal(cleaned.functions.length, 2);
assert.deepEqual(cleaned.functions[0], {
  id: 'a',
  name: '表格',
  prompt: 'p1',
  enabled: false,
  providerId: 'dp',
  modelId: 'm1'
});
assert.equal(cleaned.functions[1].id, 'b');
assert.equal(cleaned.functions[1].enabled, true);
assert.equal(cleaned.defaultProviderId, 'dp');
assert.equal(cleaned.defaultModelId, undefined);
console.log('✔ normalizeTextTools: 去重/丢弃残条/字段修剪/空提示词保留');

// ---------- 2. 模型逐级回落 + 请求构造（mock fetch） ----------
const captured = [];
globalThis.fetch = async (url, opts) => {
  captured.push({ url, opts });
  const reqBody = JSON.parse(opts.body);
  if (reqBody.stream) {
    // SSE：分两帧吐增量，再 [DONE]
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'RES' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'ULT' } }] })}\n\n`,
      'data: [DONE]\n\n'
    ];
    const encoder = new TextEncoder();
    let i = 0;
    return {
      ok: true,
      status: 200,
      text: async () => '',
      body: {
        getReader: () => ({
          read: async () =>
            i < frames.length
              ? { done: false, value: encoder.encode(frames[i++]) }
              : { done: true, value: undefined }
        })
      }
    };
  }
  const isResponses = String(url).endsWith('/responses');
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () =>
      isResponses
        ? { output_text: 'RESULT' }
        : { choices: [{ message: { content: 'RESULT' } }] }
  };
};

const config = {
  llm: {
    providers: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-global',
        models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
        enabled: true
      },
      {
        id: 'openai',
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-oai',
        api: 'openai-responses',
        models: [{ id: 'gpt-4o' }],
        enabled: true
      },
      {
        id: 'claude',
        name: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-claude',
        api: 'anthropic-messages',
        models: [{ id: 'claude-3' }],
        enabled: true
      },
      {
        id: 'dash',
        name: '通义',
        baseUrl: 'https://dashscope.example.com',
        apiKey: 'sk-qwen',
        models: [{ id: 'qwen3-max' }],
        enabled: true
      }
    ],
    activeProviderId: 'deepseek',
    activeModelId: 'deepseek-chat'
  },
  textTools: { functions: [] }
};

// 2a. 全空 → 全局 active（deepseek-chat，无 /v1 自动补）
let res = await runner.runTextTool(config, { name: '翻译', prompt: 'P', text: 'hello' });
assert.equal(res.text, 'RESULT');
assert.ok(captured[0].url.endsWith('/v1/chat/completions'), captured[0].url);
let body = JSON.parse(captured[0].opts.body);
assert.equal(body.model, 'deepseek-chat');
assert.deepEqual(body.messages, [
  { role: 'system', content: 'P' },
  { role: 'user', content: 'hello' }
]);
assert.equal(res.modelLabel, 'DeepSeek · deepseek-chat');
console.log('✔ 回落全局 active + /v1 自动补全 + messages 构造');

// 2b. 功能组默认 → defaultProviderId/defaultModelId
config.textTools.defaultProviderId = 'openai';
config.textTools.defaultModelId = 'gpt-4o';
res = await runner.runTextTool(config, { name: 'T', prompt: 'P', text: 'x' });
assert.equal(captured[1].url, 'https://api.openai.com/v1/responses');
body = JSON.parse(captured[1].opts.body);
assert.equal(body.model, 'gpt-4o');
assert.equal(body.instructions, 'P');
assert.equal(body.input, 'x');
assert.ok(body.max_output_tokens > 0);
console.log('✔ 功能组默认模型生效 + openai-responses 构造');

// 2c. 功能自带模型 > 功能组默认
res = await runner.runTextTool(config, {
  name: 'T',
  prompt: 'P',
  text: 'x',
  providerId: 'deepseek',
  modelId: 'deepseek-reasoner'
});
body = JSON.parse(captured[2].opts.body);
assert.equal(body.model, 'deepseek-reasoner');
console.log('✔ 功能自带模型优先于功能组默认');

// 2d. 功能给了 providerId 未给 modelId → 该 provider 第一个模型
await runner.runTextTool(config, { name: 'T', prompt: 'P', text: 'x', providerId: 'openai' });
body = JSON.parse(captured[3].opts.body);
assert.equal(body.model, 'gpt-4o');
console.log('✔ 只指定 provider 时取其首个模型');

// 2d+. 带 onDelta 走流式：stream:true + SSE 增量逐段回调 + 全文拼接
const deltas = [];
res = await runner.runTextTool(config, { name: 'T', prompt: 'P', text: 'x', providerId: 'deepseek' }, {
  onDelta: (d) => deltas.push(d)
});
assert.equal(JSON.parse(captured[4].opts.body).stream, true);
assert.deepEqual(deltas, ['RES', 'ULT']);
assert.equal(res.text, 'RESULT');
console.log('✔ 流式：stream 标记 + SSE 增量回调 + 全文拼接');

// 2d+++. noThinking 缺省开：qwen 模型自动附加 enable_thinking:false；显式关掉则不带
await runner.runTextTool(config, { name: 'T', prompt: 'P', text: 'x', providerId: 'dash' });
assert.equal(JSON.parse(captured[5].opts.body).enable_thinking, false);
await runner.runTextTool(config, {
  name: 'T',
  prompt: 'P',
  text: 'x',
  providerId: 'dash',
  noThinking: false
});
assert.equal('enable_thinking' in JSON.parse(captured[6].opts.body), false);
console.log('✔ 关闭思考：qwen 缺省附加参数，显式关闭后不附加');

// 2d++. 推理模型思考段：reasoning_content 增量回调，不混入正文
const reasonings = [];
const deltas2 = [];
const reasonFrames = [
  `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '想一想' } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: { content: '译文' } }] })}\n\n`,
  'data: [DONE]\n\n'
];
const encoder2 = new TextEncoder();
let ri = 0;
globalThis.fetch = async (_url, opts) => ({
  ok: true,
  status: 200,
  text: async () => '',
  body: {
    getReader: () => ({
      read: async () =>
        ri < reasonFrames.length
          ? { done: false, value: encoder2.encode(reasonFrames[ri++]) }
          : { done: true, value: undefined }
    })
  }
});
res = await runner.runTextTool(config, { name: 'T', prompt: 'P', text: 'x', providerId: 'deepseek' }, {
  onDelta: (d) => deltas2.push(d),
  onReasoning: (r) => reasonings.push(r)
});
assert.deepEqual(reasonings, ['想一想']);
assert.deepEqual(deltas2, ['译文']);
assert.equal(res.text, '译文');
console.log('✔ 推理模型思考段独立回调，不混入正文');

// 2e. anthropic-messages → 明确报错
await assert.rejects(
  () =>
    runner.runTextTool(config, {
      name: 'T',
      prompt: 'P',
      text: 'x',
      providerId: 'claude',
      modelId: 'claude-3'
    }),
  /暂不支持/
);
console.log('✔ 不支持的协议给出明确报错');

// 2f. 空提示词 / 空文本 / 未配置凭证（报错经 t() 路由：注册测试用 en 词条并切英文，
//     裸模板串不随语言翻译、t() 路由会——修复前该断言必红）
await assert.rejects(() => runner.runTextTool(config, { name: 'T', prompt: '  ', text: 'x' }), /提示词为空/);
await assert.rejects(() => runner.runTextTool(config, { name: 'T', prompt: 'P', text: '  ' }), /选中文本为空/);
const noKeyConfig = structuredClone(config);
noKeyConfig.textTools = { functions: [] };
noKeyConfig.llm.providers[0].apiKey = '';
const i18nMod = await import(pathToFileURL(compile('shared/i18n/index.ts')).href);
const NO_KEY_MSG = '「{{name}}」未配置 baseUrl/apiKey（设置 → 模型服务商）';
i18nMod.i18nInstance.addResourceBundle(
  'en', 'translation',
  { [NO_KEY_MSG]: 'Provider {{name}} has no baseUrl/apiKey configured (Settings → Model Providers)' },
  true, true
);
await i18nMod.applyLocaleSetting('en');
await assert.rejects(
  () => runner.runTextTool(noKeyConfig, { name: 'T', prompt: 'P', text: 'x' }),
  (e) => e.message === i18nMod.t(NO_KEY_MSG, { name: 'DeepSeek' }),
  '缺凭证报错必须经 t() 路由（英文档下裸模板串不翻译即失败）'
);
await i18nMod.applyLocaleSetting('zh-CN');
console.log('✔ 空提示词/空文本/缺凭证的防御性报错');

// 2g. openai-responses 原始 output 结构解析
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  text: async () => '',
  json: async () => ({
    output: [{ content: [{ type: 'output_text', text: '表' }, { type: 'output_text', text: '格' }] }]
  })
});
res = await runner.runTextTool(config, {
  name: 'T',
  prompt: 'P',
  text: 'x',
  providerId: 'openai',
  modelId: 'gpt-4o'
});
assert.equal(res.text, '表格');
console.log('✔ responses 原始 output[].content[].text 拼接');

// 2h. SSE 流中途 data:{"error":…}（OpenAI 兼容网关常见）：中断并抛真实错误，
//     不再以「模型返回空内容」收场掩盖配额/审查/网关故障
const streamErrorCase = async (errorPayload) => {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: '半截' } }] })}\n\n`,
    `data: ${JSON.stringify({ error: errorPayload })}\n\n`,
    'data: [DONE]\n\n'
  ];
  let i = 0;
  const enc = new TextEncoder();
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => '',
    body: {
      getReader: () => ({
        read: async () =>
          i < frames.length
            ? { done: false, value: enc.encode(frames[i++]) }
            : { done: true, value: undefined }
      })
    }
  });
  const expected = typeof errorPayload === 'string' ? errorPayload : errorPayload.message;
  await assert.rejects(
    () => runner.runTextTool(config, { name: 'T', prompt: 'P', text: 'x', providerId: 'deepseek' }, { onDelta: () => {} }),
    (e) => e.message === t('LLM 流返回错误：{{message}}', { message: expected }),
    `流中途错误必须抛出真实错误（${expected}），不得误报「模型返回空内容」`
  );
};
await streamErrorCase({ message: 'Insufficient quota', code: 'insufficient_quota' });
await streamErrorCase('rate limit exceeded');
console.log('✔ 流中途 error 块：中断并抛出真实错误（对象/裸字符串两形态）');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('text-tools 全部通过');
