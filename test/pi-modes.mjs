import { createSharedCompiler } from './helpers/shared-compile.mjs';
/**
 * Pi 自定义模式库回归：内置 creator/explore/judge + 用户目录 CRUD + 校验 + 损坏标记。
 * 锁创造模式的数据面契约（docs/research/dsh-replace-pi-research.md 第①层实现）：
 * 落盘即可选（listPiModes）、内置遮蔽同名用户文件、模式只携带 persona/配置。
 * §10 锁 modes.* 工具的 extensions 强制确认门：携带扩展路径必弹卡（权限档无关，
 * auto 档策略放行后仍拦）、被拒不落盘、不含 extensions 照旧免卡。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const loadTs = async (rel, rewriteImports) => {
  const src = path.join(root, rel);
  const out = path.join(root, '.tmp', `pimodes-${path.basename(rel, '.ts')}.mjs`);
  const { outputText } = ts.transpileModule(fs.readFileSync(src, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  });
  // .tmp 里相对导入会解析到错误位置：按映射重写为 .tmp 内的已转译产物
  const fixed = Object.entries(rewriteImports ?? {}).reduce(
    (text, [from, to]) => text.split(from).join(to),
    outputText
  );
  fs.writeFileSync(out, fixed, 'utf8');
  return import(pathToFileURL(out, { windows: true }).href);
};

const dependencies = createSharedCompiler(root, path.join(root, '.tmp', 'pimodes-dependencies'));
const m = await loadTs('src/main/agentSession/drivers/pi/modes.ts', {
  '../../../runtimeKernel/storageRootResolver': pathToFileURL(dependencies('main/runtimeKernel/storageRootResolver.ts')).href
});
const tools = await loadTs('src/main/agentSession/tools/piModes.ts', {
  '../drivers/pi/modes': './pimodes-modes.mjs'
});
await loadTs('src/shared/bashReadonly.ts');
const policyShared = await loadTs('src/shared/guiWorkerPolicy.ts', {
  './bashReadonly': './pimodes-bashReadonly.mjs'
});
const g = await loadTs('src/main/agentSession/drivers/pi/guardExtension.ts', {
  '../../../../shared/guiWorkerPolicy': './pimodes-guiWorkerPolicy.mjs'
});

// 独立临时 userData，避免污染真实应用数据
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-pi-modes-'));
try {
  // ── 1. 空库：内置 creator/explore/judge 在册、不可改删 ──
  let roster = m.listPiModes(userData);
  assert.equal(roster.length, 3, '空库应有三个内置模式');
  assert.deepEqual(
    m.builtinPiModeIds().sort(),
    ['creator', 'explore', 'judge'].sort(),
    'builtinPiModeIds 单源'
  );
  for (const id of ['creator', 'explore', 'judge']) {
    const row = roster.find((x) => x.id === id);
    assert.ok(row, `内置 ${id} 在册`);
    assert.equal(row.trust, 'system');
    assert.equal(row.broken, undefined);
    assert.ok(m.readPiMode(userData, id), `${id} 定义可读`);
    assert.ok(m.createPiMode(userData, { id, name: 'x', description: '', persona: 'y' }), `内置 id ${id} 不可占用`);
    assert.ok(m.updatePiMode(userData, id, { persona: 'x' }), `内置 ${id} 不可改`);
    assert.ok(m.deletePiMode(userData, id), `内置 ${id} 不可删`);
  }
  assert.match(m.readPiMode(userData, 'creator').persona, /modes\.create/);

  // ── 1b. explore/judge 只读白名单：native 无 write/edit；守卫拦写命令 ──
  const explore = m.readPiMode(userData, 'explore');
  assert.deepEqual(explore.tools?.native, ['read', 'bash']);
  assert.equal(explore.guards?.bashReadOnly, true);
  assert.deepEqual(
    m.filterPiNativeTools(m.PI_NATIVE_TOOL_ALL, { nativeTools: explore.tools.native }),
    ['read', 'bash'],
    'explore 原生工具面无 write/edit'
  );
  const exploreGuard = g.createPiGuardExtension(explore.guards);
  let exploreHandler = null;
  exploreGuard({ on: (ev, h) => { if (ev === 'tool_call') exploreHandler = h; } });
  assert.equal(exploreHandler({ toolName: 'bash', input: { command: 'rg TODO src' } }), undefined, 'explore 放行只读');
  assert.equal(
    exploreHandler({ toolName: 'bash', input: { command: 'rm -rf dist' } }).block,
    true,
    'explore 拦截写命令'
  );
  // M-2：无 Git Bash 时 driver 把 bash 换成 pi 自带 powershell——守卫必须同样拦截，
  // 否则该场景下模式硬守卫整体失效
  assert.equal(
    exploreHandler({ toolName: 'powershell', input: { command: 'Remove-Item -Recurse dist' } }).block,
    true,
    'M-2：powershell 写命令同样被守卫拦截'
  );
  assert.equal(
    exploreHandler({ toolName: 'bash', input: { command: 'npm test' } }).block,
    true,
    'explore 不放行测试命令'
  );

  const judge = m.readPiMode(userData, 'judge');
  assert.deepEqual(judge.tools?.native, ['read', 'bash']);
  assert.equal(judge.guards?.bashReadOnly, true);
  assert.ok(judge.guards?.bashAllow?.length > 0, 'judge 带 bashAllow');
  assert.match(judge.persona, /visualGate/);
  const judgeGuard = g.createPiGuardExtension(judge.guards);
  let judgeHandler = null;
  judgeGuard({ on: (ev, h) => { if (ev === 'tool_call') judgeHandler = h; } });
  assert.equal(judgeHandler({ toolName: 'bash', input: { command: 'ls src' } }), undefined, 'judge 放行只读');
  assert.equal(judgeHandler({ toolName: 'bash', input: { command: 'npm test' } }), undefined, 'judge 放行 npm test');
  assert.equal(
    judgeHandler({ toolName: 'bash', input: { command: 'npm run typecheck' } }),
    undefined,
    'judge 放行 typecheck'
  );
  assert.equal(
    judgeHandler({ toolName: 'bash', input: { command: 'npm run build' } }),
    undefined,
    'judge 放行 build'
  );
  assert.equal(
    judgeHandler({ toolName: 'bash', input: { command: 'rm -rf node_modules' } }).block,
    true,
    'judge 仍拦破坏性写命令'
  );

  // 链式命令逐段全称判定：白名单按顶层切段后每段都需命中（回归：npm test && rm -rf 不得借
  // 放行正则只锚定段首而整链放行；还原修复时「拦链式破坏段」与「放行只读∪放行链」两组转红）
  assert.equal(
    judgeHandler({ toolName: 'bash', input: { command: 'npm test && rm -rf dist' } }).block,
    true,
    'judge 拦链式里的破坏段'
  );
  assert.equal(
    judgeHandler({ toolName: 'bash', input: { command: 'rm -rf dist && npm test' } }).block,
    true,
    'judge 拦顺序颠倒的链式'
  );
  assert.equal(
    judgeHandler({ toolName: 'bash', input: { command: 'npm test && npm run typecheck' } }),
    undefined,
    'judge 放行全段命中的链式'
  );
  assert.equal(
    judgeHandler({ toolName: 'bash', input: { command: 'git diff && npm test' } }),
    undefined,
    'judge 放行只读段 + 放行段的链式'
  );
  assert.equal(
    exploreHandler({ toolName: 'bash', input: { command: 'rg TODO src && rm -rf dist' } }).block,
    true,
    'explore 链式同样逐段拦截'
  );

  // ── 2. create → list/read 回读 ──
  assert.equal(
    m.createPiMode(userData, {
      id: 'code-review',
      name: '评审模式',
      description: '只做代码评审',
      persona: '你只做代码评审，不改代码。'
    }),
    null,
    '合法创建应成功'
  );
  roster = m.listPiModes(userData);
  assert.equal(roster.length, 4);
  const user = roster.find((x) => x.id === 'code-review');
  assert.equal(user.trust, 'user');
  assert.equal(user.name, '评审模式');
  const def = m.readPiMode(userData, 'code-review');
  assert.equal(def.persona, '你只做代码评审，不改代码。');
  assert.ok(fs.existsSync(path.join(m.piModesDir(userData), 'code-review.json')), '落盘为一文件一模式');

  // ── 3. 校验拒绝：非法 id / 重名 / 空 persona / 缺字段 ──
  assert.ok(m.createPiMode(userData, { id: 'Bad_ID', name: 'x', description: '', persona: 'y' }), '大写下划线 id 拒绝');
  assert.ok(m.createPiMode(userData, { id: '-abc', name: 'x', description: '', persona: 'y' }), '连字符开头 id 拒绝');
  assert.ok(
    m.createPiMode(userData, { id: 'code-review', name: 'x', description: '', persona: 'y' }),
    '重名拒绝'
  );
  assert.ok(
    m.createPiMode(userData, { id: 'empty-p', name: 'x', description: '', persona: '   ' }),
    '空 persona 拒绝'
  );
  assert.ok(
    m.createPiMode(userData, { id: 'no-name', name: '', description: '', persona: 'x' }),
    '空 name 拒绝'
  );
  assert.ok(m.validatePiModeInput({ id: 'ok', persona: '长'.repeat(8001) }), 'persona 超长拒绝');

  // ── 4. update：patch 合并 / 校验 / 缺文件 ──
  assert.equal(
    m.updatePiMode(userData, 'code-review', { persona: '评审 + 只读建议。' }),
    null,
    '合法更新'
  );
  assert.equal(m.readPiMode(userData, 'code-review').persona, '评审 + 只读建议。');
  assert.equal(m.readPiMode(userData, 'code-review').name, '评审模式', '未 patch 字段保留');
  assert.ok(m.updatePiMode(userData, 'ghost', { persona: 'x' }), '不存在模式更新拒绝');
  assert.ok(m.updatePiMode(userData, 'code-review', { persona: '' }), '更新为空 persona 拒绝');

  // ── 5. 损坏文件：list 标 broken、read 返 null ──
  fs.writeFileSync(
    path.join(m.piModesDir(userData), 'broken-mode.json'),
    '{not json',
    'utf8'
  );
  roster = m.listPiModes(userData);
  const broken = roster.find((x) => x.id === 'broken-mode');
  assert.ok(broken?.broken, '损坏模式被标记 broken');
  assert.equal(m.readPiMode(userData, 'broken-mode'), null, '损坏模式定义不可读');
  // 非法 id 文件名直接跳过（不进花名册）
  fs.mkdirSync(path.join(m.piModesDir(userData), 'Not_Valid'), { recursive: true });
  assert.ok(!m.listPiModes(userData).some((x) => x.id === 'Not_Valid'), '非法 id 目录跳过');

  // ── 6. delete ──
  assert.ok(m.deletePiMode(userData, 'ghost'), '删除不存在模式报错');
  assert.equal(m.deletePiMode(userData, 'code-review'), null, '合法删除');
  assert.ok(!m.listPiModes(userData).some((x) => x.id === 'code-review'), '删除后离册');
  assert.equal(m.readPiMode(userData, 'code-review'), null);

  // ── 7. 扩展挂载点字段：校验 + 落盘回读 + patch 合并 ──
  assert.ok(
    m.validatePiModeInput({ tools: { native: [] } }),
    'tools.native 空数组拒绝（消费端 .length 判空会反转成全量放行）'
  );
  assert.ok(
    m.validatePiModeInput({ tools: { native: ['read', 'deploy'] } }),
    'tools.native 白名单外拒绝'
  );
  assert.ok(m.validatePiModeInput({ tools: { nativeDeny: ['deploy'] } }), 'nativeDeny 白名单外拒绝');
  assert.ok(m.validatePiModeInput({ tools: { hostDeny: ['notify'] } }), 'hostDeny 非点号 id 拒绝');
  assert.ok(m.validatePiModeInput({ thinkingLevel: 'ultra' }), '非法思考档拒绝');
  assert.ok(m.validatePiModeInput({ defaultGuiMode: 'yolo' }), '非法权限档拒绝');
  assert.ok(m.validatePiModeInput({ model: {} }), 'model 空对象拒绝');
  assert.ok(m.validatePiModeInput({ temperature: 3 }), 'temperature 越界拒绝');
  assert.ok(m.validatePiModeInput({ providerHeaders: { 'X a': '1' } }), '非法请求头名拒绝');
  assert.ok(m.validatePiModeInput({ skillsPaths: [42] }), 'skillsPaths 非字符串数组拒绝');
  assert.ok(m.validatePiModeInput({ contextFiles: 'yes' }), 'contextFiles 非布尔拒绝');
  assert.equal(m.validatePiModeInput({ tools: { native: ['read', 'bash'], hostDeny: ['ui.notify'] } }), null);
  assert.equal(m.validatePiModeInput({ thinkingLevel: 'xhigh' }), null);
  assert.equal(m.validatePiModeInput({ model: { modelId: 'k3' } }), null);
  assert.equal(
    m.validatePiModeInput({
      systemPrompt: '你是极简执行器。',
      contextFiles: false,
      skillsPaths: ['C:/skills'],
      promptPaths: ['C:/prompts'],
      temperature: 0.7,
      providerHeaders: { 'X-Trace': 'abc' }
    }),
    null,
    '新挂载点字段合法值通过'
  );
  // v4：extensions/themes/scopedModels/piSettings/tools.exclude
  assert.ok(m.validatePiModeInput({ extensions: [42] }), 'extensions 非字符串数组拒绝');
  assert.ok(m.validatePiModeInput({ themes: [''] }), 'themes 空串拒绝');
  assert.ok(m.validatePiModeInput({ scopedModels: [{ providerId: 'p' }] }), 'scopedModels 缺 modelId 拒绝');
  assert.ok(
    m.validatePiModeInput({ scopedModels: [{ providerId: 'p', modelId: 'm', thinkingLevel: 'ultra' }] }),
    'scopedModels 非法思考档拒绝'
  );
  assert.ok(
    m.validatePiModeInput({ scopedModels: new Array(33).fill({ providerId: 'p', modelId: 'm' }) }),
    'scopedModels 超 32 条拒绝'
  );
  assert.ok(m.validatePiModeInput({ piSettings: [] }), 'piSettings 数组拒绝');
  assert.ok(m.validatePiModeInput({ tools: { exclude: [''] } }), 'tools.exclude 空名拒绝');
  assert.equal(
    m.validatePiModeInput({
      extensions: ['E:/exts/a.ts'],
      themes: ['E:/themes/dark.json'],
      scopedModels: [{ providerId: 'deepseek', modelId: 'deepseek-chat', thinkingLevel: 'low' }],
      piSettings: { compaction: { enabled: true, keepRecentTokens: 40000 }, retry: { maxRetries: 5 } },
      tools: { exclude: ['ui.notify'] }
    }),
    null,
    'v4 字段合法值通过'
  );
  const v4mode = {
    id: 'power',
    name: '全能模式',
    description: '扩展+设置透传',
    persona: 'p',
    extensions: ['E:/exts/a.ts'],
    themes: ['E:/themes/dark.json'],
    scopedModels: [{ providerId: 'deepseek', modelId: 'deepseek-chat' }],
    piSettings: { compaction: { enabled: false } },
    tools: { exclude: ['ui.notify'] }
  };
  assert.equal(m.createPiMode(userData, v4mode), null, 'v4 全字段创建');
  const gotV4 = m.readPiMode(userData, 'power');
  assert.deepEqual(gotV4.extensions, v4mode.extensions);
  assert.deepEqual(gotV4.themes, v4mode.themes);
  assert.deepEqual(gotV4.scopedModels, v4mode.scopedModels);
  assert.deepEqual(gotV4.piSettings, v4mode.piSettings);
  assert.deepEqual(gotV4.tools, v4mode.tools);
  assert.equal(m.updatePiMode(userData, 'power', { extensions: ['E:/exts/b.ts'] }), null);
  const gotV4b = m.readPiMode(userData, 'power');
  assert.deepEqual(gotV4b.extensions, ['E:/exts/b.ts'], 'extensions 更新生效');
  assert.deepEqual(gotV4b.piSettings, v4mode.piSettings, '其余字段保留');
  const full = {
    id: 'reviewer',
    name: '评审',
    description: '只读评审',
    persona: '只评审不改码。',
    tools: { native: ['read', 'bash'], hostDeny: ['ui.notify', 'bgtasks.spawn'] },
    thinkingLevel: 'high',
    model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
    defaultGuiMode: 'ask'
  };
  assert.equal(m.createPiMode(userData, full), null, '全字段创建');
  const got = m.readPiMode(userData, 'reviewer');
  assert.deepEqual(got.tools, full.tools, 'tools 回读');
  assert.equal(got.thinkingLevel, 'high');
  assert.deepEqual(got.model, full.model);
  assert.equal(got.defaultGuiMode, 'ask');
  assert.equal(m.updatePiMode(userData, 'reviewer', { thinkingLevel: 'off' }), null, '局部更新');
  const got2 = m.readPiMode(userData, 'reviewer');
  assert.equal(got2.thinkingLevel, 'off', '更新生效');
  assert.deepEqual(got2.tools, full.tools, '未 patch 的可选字段保留');
  assert.equal(got2.defaultGuiMode, 'ask', '未 patch 的可选字段保留');
  // 新挂载点字段全量创建 + 回读 + 局部更新合并
  const hooked = {
    id: 'executor',
    name: '极简执行器',
    description: '换基底提示+关上下文+控温',
    persona: '只执行。',
    systemPrompt: '你是极简执行器。',
    contextFiles: false,
    skillsPaths: ['C:/skills'],
    promptPaths: ['C:/prompts'],
    temperature: 0.3,
    providerHeaders: { 'X-Trace': 'abc' }
  };
  assert.equal(m.createPiMode(userData, hooked), null, '新字段创建');
  const got3 = m.readPiMode(userData, 'executor');
  assert.equal(got3.systemPrompt, hooked.systemPrompt);
  assert.equal(got3.contextFiles, false);
  assert.deepEqual(got3.skillsPaths, hooked.skillsPaths);
  assert.deepEqual(got3.promptPaths, hooked.promptPaths);
  assert.equal(got3.temperature, 0.3);
  assert.deepEqual(got3.providerHeaders, hooked.providerHeaders);
  assert.equal(m.updatePiMode(userData, 'executor', { temperature: 0.9 }), null);
  const got4 = m.readPiMode(userData, 'executor');
  assert.equal(got4.temperature, 0.9);
  assert.deepEqual(got4.providerHeaders, hooked.providerHeaders, '更新后其余字段保留');

  // ── 7.5 guards 硬守卫：校验 + 回读 + tool_call 拦截行为 ──
  assert.ok(m.validatePiModeInput({ guards: { bashDeny: ['['] } }), '不可编译正则拒绝');
  assert.ok(m.validatePiModeInput({ guards: { denyPaths: [''] } }), '空路径子串拒绝');
  assert.ok(m.validatePiModeInput({ guards: 'x' }), 'guards 非对象拒绝');
  assert.equal(
    m.validatePiModeInput({ guards: { bashDeny: ['rm\\s+-rf'], denyPaths: ['.env'] } }),
    null,
    '合法守卫通过'
  );
  const guarded = {
    id: 'guarded',
    name: '受控模式',
    description: '带硬守卫',
    persona: '守规矩。',
    guards: { bashDeny: ['rm\\s+-rf', 'git\\s+push\\s+--force'], denyPaths: ['.Env'] }
  };
  assert.equal(m.createPiMode(userData, guarded), null);
  assert.deepEqual(m.readPiMode(userData, 'guarded').guards, guarded.guards, 'guards 回读');

  const warnings = [];
  const compiled = g.compilePiModeGuards(guarded.guards, (msg) => warnings.push(msg));
  assert.equal(compiled.bashDeny.length, 2);
  assert.deepEqual(compiled.denyPaths, ['.env'], '路径保护不区分大小写');
  const brokenCompiled = g.compilePiModeGuards({ bashDeny: ['['] }, (msg) => warnings.push(msg));
  assert.equal(brokenCompiled.bashDeny.length, 0, '不可编译正则跳过');
  assert.ok(warnings.length >= 1, '跳过时留警告');

  let toolCallHandler = null;
  const factory = g.createPiGuardExtension(guarded.guards);
  factory({ on: (ev, h) => { if (ev === 'tool_call') toolCallHandler = h; } });
  assert.ok(toolCallHandler, 'tool_call 钩子已挂');
  assert.equal(
    toolCallHandler({ toolName: 'bash', input: { command: 'rm -rf /' } }).block,
    true,
    '命中 bash 黑名单即拦'
  );
  assert.equal(
    toolCallHandler({ toolName: 'bash', input: { command: 'git push --force origin main' } }).block,
    true,
    '第二条黑名单命中'
  );
  assert.equal(toolCallHandler({ toolName: 'bash', input: { command: 'ls -la' } }), undefined, '未命中放行');
  assert.equal(
    toolCallHandler({ toolName: 'write', input: { path: 'C:/x/.env' } }).block,
    true,
    '写路径命中保护'
  );
  assert.equal(toolCallHandler({ toolName: 'edit', input: { path: 'C:/x/app.ts' } }), undefined, '普通路径放行');
  assert.equal(g.createPiGuardExtension({}), null, '无规则不装守卫');

  // bashReadOnly / bashAllow 校验与白名单语义
  assert.ok(m.validatePiModeInput({ guards: { bashReadOnly: 'yes' } }), 'bashReadOnly 非布尔拒绝');
  assert.ok(m.validatePiModeInput({ guards: { bashAllow: ['['] } }), 'bashAllow 不可编译拒绝');
  assert.equal(m.validatePiModeInput({ guards: { bashReadOnly: true, bashAllow: ['^npm\\s+test'] } }), null);
  assert.ok(g.createPiGuardExtension({ bashReadOnly: true }), '仅 bashReadOnly 也装守卫');

  // ── 7.6 回合注入 / 输入变换 / 上下文瘦身：校验 + 钩子行为 ──
  const hooks = await loadTs('src/main/agentSession/drivers/pi/modeHooksExtension.ts');
  assert.ok(m.validatePiModeInput({ turnInject: 'x'.repeat(4001) }), 'turnInject 超长拒绝');
  assert.ok(m.validatePiModeInput({ inputTransforms: [{ pattern: '[', replacement: 'x' }] }), '变换正则不可编译拒绝');
  assert.ok(m.validatePiModeInput({ inputTransforms: new Array(21).fill({ pattern: 'a', replacement: 'b' }) }), '变换规则超 20 条拒绝');
  assert.ok(m.validatePiModeInput({ contextTrim: { maxToolResultChars: 10 } }), '截断上限低于 200 拒绝');
  assert.equal(m.validatePiModeInput({ turnInject: '当前时间 {{now}}', contextTrim: { maxToolResultChars: 500 } }), null);

  // 回合注入渲染：占位符替换 + before_agent_start 链式追加
  const rendered = hooks.renderTurnInject('时间 {{now}} / {{date}} / {{time}} / {{cwd}}', {
    now: new Date(2026, 7, 31, 9, 5),
    cwd: 'E:/proj'
  });
  assert.match(rendered, /2026-08-31 09:05/);
  assert.match(rendered, /E:\/proj/);
  let beforeHandler = null;
  const hooksFactory = hooks.createPiModeHooksExtension(
    { turnInject: '现在 {{time}}' },
    { cwd: 'E:/proj' }
  );
  hooksFactory({ on: (ev, h) => { if (ev === 'before_agent_start') beforeHandler = h; } });
  const beforeOut = beforeHandler({ systemPrompt: 'BASE' });
  assert.match(beforeOut.systemPrompt, /^BASE\n\n现在 \d{2}:\d{2}$/);

  // 上下文瘦身：toolResult 文本块截断，其余消息不动
  let contextHandler = null;
  const trimFactory = hooks.createPiModeHooksExtension(
    { contextTrim: { maxToolResultChars: 10 } },
    {}
  );
  trimFactory({ on: (ev, h) => { if (ev === 'context') contextHandler = h; } });
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'a'.repeat(500) }] },
    { role: 'toolResult', content: [{ type: 'text', text: 'b'.repeat(50) }] },
    { role: 'toolResult', content: [{ type: 'text', text: 'c'.repeat(50) }] }
  ];
  const trimmed = contextHandler({ messages }).messages;
  assert.equal(trimmed[0].content[0].text.length, 500, '非 toolResult 不动');
  assert.ok(trimmed[1].content[0].text.startsWith('b'.repeat(10)), '超长 toolResult 截断');
  assert.match(trimmed[1].content[0].text, /已截断/);
  assert.match(trimmed[2].content[0].text, /已截断/, '第二个超长 toolResult 同样截断');

  // 输入变换：发送前按序应用（Host 侧纯函数）
  assert.equal(
    hooks.applyInputTransforms('?quick 帮我看下', [{ pattern: '^\\?quick\\s+', replacement: '简要回答：' }]),
    '简要回答：帮我看下'
  );
  assert.equal(hooks.applyInputTransforms('原文', undefined), '原文', '无规则原样返回');
  assert.equal(
    hooks.applyInputTransforms('aaa', [{ pattern: '[', replacement: 'x' }]),
    'aaa',
    '坏正则跳过该条'
  );

  // pi-modes F-02：超规模门槛跳过 transforms（防贪婪回溯 pattern 阻塞主进程发送路径）。
  // 还原修复（删长度门）时：超长输入会被灾难性回溯正则实际处理且 skips 为空 → 红
  {
    const limit = hooks.INPUT_TRANSFORM_MAX_CHARS;
    assert.equal(typeof limit, 'number', '门槛常量已导出');
    const skips = [];
    const oversize = 'x'.repeat(limit + 1);
    assert.equal(
      hooks.applyInputTransforms(oversize, [{ pattern: '^x', replacement: 'y' }], (r) => skips.push(r)),
      oversize,
      '超门槛输入按原文返回'
    );
    assert.equal(skips.length, 1, '跳过时经 onSkip 记警告');
    assert.match(String(skips[0]), /跳过/, '警告文案交代跳过原因');
    const okSkips = [];
    assert.equal(
      hooks.applyInputTransforms('?quick 问', [{ pattern: '^\\?quick\\s+', replacement: '简答：' }], (r) => okSkips.push(r)),
      '简答：问',
      '门槛内照常应用'
    );
    assert.equal(okSkips.length, 0, '门槛内不告警');
    // 灾难性回溯正则 + 超长输入：必须被门槛拦截（同步执行不挂死即通过）
    const evil = [{ pattern: '(a+)+$', replacement: 'b' }];
    assert.equal(
      hooks.applyInputTransforms('a'.repeat(limit + 10) + 'b', evil, () => {}),
      'a'.repeat(limit + 10) + 'b',
      '灾难性回溯 pattern 在超长输入上被门槛拦截'
    );
  }

  // 模式落盘回读
  const hookedMode = {
    id: 'clocked',
    name: '带时钟模式',
    description: '每轮注入时间',
    persona: 'p',
    turnInject: '当前 {{now}}',
    inputTransforms: [{ pattern: '^\\?q\\s+', replacement: '简答：' }],
    contextTrim: { maxToolResultChars: 500 }
  };
  assert.equal(m.createPiMode(userData, hookedMode), null);
  const got5 = m.readPiMode(userData, 'clocked');
  assert.equal(got5.turnInject, hookedMode.turnInject);
  assert.deepEqual(got5.inputTransforms, hookedMode.inputTransforms);
  assert.deepEqual(got5.contextTrim, hookedMode.contextTrim);

  // ── 7b. 盘上手改的非法字段：恢复时过校验，标 broken 而不是静默透传 ──
  fs.writeFileSync(
    path.join(m.piModesDir(userData), 'hand-edited.json'),
    JSON.stringify({
      id: 'hand-edited',
      name: 'Hand',
      description: '',
      persona: 'p',
      thinkingLevel: 'ultra',
      tools: { native: ['deploy'] }
    }),
    'utf8'
  );
  roster = m.listPiModes(userData);
  const handEdited = roster.find((x) => x.id === 'hand-edited');
  assert.ok(handEdited?.broken?.includes('字段校验失败'), '盘上非法字段标 broken 并给原因');
  assert.equal(m.readPiMode(userData, 'hand-edited'), null, '坏字段模式定义不可读');

  // ── 7c. 原生工具过滤单源：driver 注册面与政策层目录共用 ──
  assert.deepEqual(
    m.filterPiNativeTools(['read', 'write', 'edit', 'bash'], { nativeTools: ['read', 'bash'] }),
    ['read', 'bash'],
    '白名单过滤'
  );
  assert.deepEqual(
    m.filterPiNativeTools(['read', 'write', 'edit', 'bash'], { nativeToolsDeny: ['bash'] }),
    ['read', 'write', 'edit'],
    '黑名单过滤'
  );
  assert.deepEqual(
    m.filterPiNativeTools(['read', 'write', 'edit', 'bash'], { nativeTools: ['read', 'bash'], nativeToolsDeny: ['read'] }),
    ['bash'],
    '白名单 + 黑名单叠加'
  );

  // ── 8. tools 装配：modes.* 四件、schema、执行回路（直调 execute） ──
  const built = tools.buildPiModeTools(userData);
  assert.deepEqual(
    built.map((t) => t.id),
    ['modes.list', 'modes.create', 'modes.update', 'modes.delete']
  );
  assert.equal(built[0].permissionClass, 'read', 'list 只读');
  for (const t of built.slice(1)) assert.equal(t.permissionClass, 'edit', '写操作走 edit 审批');
  const listOut = await built[0].execute({}, { sessionId: 's', cwd: '.' });
  assert.match(listOut, /creator/);
  const createOut = await built[1].execute(
    { id: 't1', name: 'T1', description: 'd', persona: 'p' },
    { sessionId: 's', cwd: '.' }
  );
  assert.match(createOut, /已创建/);
  const badCreate = await built[1].execute({ id: 'BAD' }, { sessionId: 's', cwd: '.' });
  assert.match(badCreate, /失败/);

  // ── 9. turnInjectStable：校验 + 落盘回读 + patch 保留 + connectExtras 透传 ──
  assert.equal(
    m.validatePiModeInput({ turnInjectStable: 'yes' }),
    'turnInjectStable 须为布尔值',
    '非布尔拒绝'
  );
  assert.equal(m.validatePiModeInput({ turnInjectStable: true }), null, '布尔通过');
  assert.ok(
    m.createPiMode(userData, {
      id: 'bad-stable',
      name: 'B',
      description: '',
      persona: 'p',
      turnInjectStable: 'yes'
    }),
    'create 路径同样拒绝非布尔'
  );
  assert.equal(
    m.createPiMode(userData, {
      id: 'stable',
      name: 'S',
      description: '',
      persona: 'p',
      turnInject: '今天是 {{date}}',
      turnInjectStable: true
    }),
    null,
    '带 stable 创建成功'
  );
  const stableDef = m.readPiMode(userData, 'stable');
  assert.equal(stableDef.turnInjectStable, true, 'stable 字段落盘回读');
  assert.deepEqual(
    m.piModeConnectExtras(stableDef),
    { ...m.piModeConnectExtras(stableDef), turnInjectStable: true },
    'connectExtras 透传 turnInjectStable'
  );
  assert.equal(m.updatePiMode(userData, 'stable', { turnInjectStable: false }), null);
  assert.equal(m.readPiMode(userData, 'stable').turnInjectStable, false, 'update 可关闭 stable');
  assert.equal(m.updatePiMode(userData, 'stable', { persona: 'p2' }), null);
  assert.equal(m.readPiMode(userData, 'stable').turnInject, '今天是 {{date}}', 'patch 缺省保留 turnInject');
  assert.equal(m.readPiMode(userData, 'stable').turnInjectStable, false, 'patch 缺省保留 stable=false');

  // ── 10. extensions 强制确认门：携带扩展路径必弹卡（权限档无关），被拒不落盘 ──
  // 门在 modes.create/update 的 handler 内（策略层之后），auto 档策略放行后仍由它拦截
  const confirmCalls = [];
  let confirmAnswer = { confirmed: false, cancelledBy: 'button' };
  const confirmStub = async (title, detail, confirmOpts) => {
    confirmCalls.push({ title, detail, confirmOpts });
    return { ...confirmAnswer };
  };
  const gated = tools.buildPiModeTools(userData, { confirmExtensions: confirmStub });
  const gCreate = gated.find((t) => t.id === 'modes.create');
  const gUpdate = gated.find((t) => t.id === 'modes.update');

  // 10a. create 携带 extensions：必弹危险卡；被拒（button）→ 不落盘、如实回拒因
  confirmCalls.length = 0;
  confirmAnswer = { confirmed: false, cancelledBy: 'button' };
  const refusedCreate = await gCreate.execute(
    { id: 'gate-ext', name: 'G', description: 'd', persona: 'p', extensions: ['E:/exts/x.ts'] },
    { sessionId: 's', cwd: '.' }
  );
  assert.equal(confirmCalls.length, 1, '携带 extensions 的 create 必弹一张确认卡');
  assert.equal(confirmCalls[0].confirmOpts.dangerous, true, '确认卡为危险门（点空白不关）');
  assert.match(confirmCalls[0].detail, /宿主权限任意代码扩展/);
  assert.match(confirmCalls[0].detail, /E:\/exts\/x\.ts/);
  assert.match(refusedCreate, /已拒绝创建/);
  assert.match(refusedCreate, /button/);
  assert.equal(m.readPiMode(userData, 'gate-ext'), null, '被拒不落盘');
  assert.ok(!fs.existsSync(path.join(m.piModesDir(userData), 'gate-ext.json')), '被拒不写文件');

  // 10b. update 携带 extensions：同样弹卡被拒 → 既有模式 extensions 不变
  assert.equal(
    m.createPiMode(userData, { id: 'gate-plain', name: 'P', description: '', persona: 'p' }),
    null
  );
  confirmCalls.length = 0;
  const refusedUpdate = await gUpdate.execute(
    { id: 'gate-plain', extensions: ['E:/exts/y.ts'] },
    { sessionId: 's', cwd: '.' }
  );
  assert.equal(confirmCalls.length, 1, '携带 extensions 的 update 必弹一张确认卡');
  assert.match(refusedUpdate, /已拒绝更新/);
  assert.equal(m.readPiMode(userData, 'gate-plain').extensions, undefined, '被拒不改既有模式');

  // 10c. auto 档同样拦：auto 档策略表对 edit 类宿主工具直接放行（审批层不拦，
  // modes.create 的唯一拦截点就是 handler 门）——策略放行 + 门被拒 ⇒ auto 档下仍不落盘
  assert.equal(
    policyShared.decideToolPermission({ mode: 'auto', permissionClass: 'edit' }),
    'auto',
    '前置事实：auto 档策略表对 edit 类放行（审批层不会拦 modes.create）'
  );
  confirmCalls.length = 0;
  const refusedInAuto = await gCreate.execute(
    { id: 'gate-auto', name: 'A', description: 'd', persona: 'p', extensions: ['E:/exts/z.ts'] },
    { sessionId: 's', cwd: '.' }
  );
  assert.equal(confirmCalls.length, 1, 'auto 档（策略放行后）handler 门仍弹卡');
  assert.match(refusedInAuto, /已拒绝创建/);
  assert.equal(m.readPiMode(userData, 'gate-auto'), null, 'auto 档被拒同样不落盘');

  // 10d. 不含 extensions 照旧免卡：create/update 均不弹卡、正常生效
  confirmCalls.length = 0;
  const plainCreate = await gCreate.execute(
    { id: 'gate-free', name: 'F', description: 'd', persona: 'p', themes: ['E:/themes/t.json'] },
    { sessionId: 's', cwd: '.' }
  );
  assert.match(plainCreate, /已创建/);
  assert.deepEqual(m.readPiMode(userData, 'gate-free').themes, ['E:/themes/t.json']);
  const plainUpdate = await gUpdate.execute(
    { id: 'gate-free', persona: 'p2' },
    { sessionId: 's', cwd: '.' }
  );
  assert.match(plainUpdate, /已更新/);
  assert.equal(confirmCalls.length, 0, '不含 extensions 的调用全程免卡');
  // extensions: []（无代码/清除扩展）同样免卡
  const clearExt = await gUpdate.execute(
    { id: 'gate-free', extensions: [] },
    { sessionId: 's', cwd: '.' }
  );
  assert.match(clearExt, /已更新/);
  assert.equal(confirmCalls.length, 0, 'extensions 空数组=无代码，不占用户一次确认');

  // 10e. 用户确认 → 正常落盘且 extensions 生效（放行路径不误伤）
  confirmAnswer = { confirmed: true };
  const okCreate = await gCreate.execute(
    { id: 'gate-ok', name: 'O', description: 'd', persona: 'p', extensions: ['E:/exts/ok.ts'] },
    { sessionId: 's', cwd: '.' }
  );
  assert.match(okCreate, /已创建/);
  assert.deepEqual(m.readPiMode(userData, 'gate-ok').extensions, ['E:/exts/ok.ts'], '确认后扩展落盘');

  // 10f. fail-closed：未接线确认通道时携带 extensions 一律拒绝，不静默放行
  const unwired = tools.buildPiModeTools(userData);
  const unwiredCreate = await unwired
    .find((t) => t.id === 'modes.create')
    .execute(
      { id: 'gate-nowire', name: 'N', description: 'd', persona: 'p', extensions: ['E:/exts/n.ts'] },
      { sessionId: 's', cwd: '.' }
    );
  assert.match(unwiredCreate, /已拒绝创建/);
  assert.match(unwiredCreate, /未接入确认卡通道/);
  assert.equal(m.readPiMode(userData, 'gate-nowire'), null, '未接线同样不落盘');

  console.log('pi-modes: 全部断言通过');
} finally {
  fs.rmSync(userData, { recursive: true, force: true });
}
