/**
 * A6/A7 工具目录寄生与真实参数 schema 自测（zcode-adoption-plan 批次 R5）：
 * ① 全量 ToolDef.parameters 结构合法性扫描（type:object / properties 为对象 /
 *    无 arguments_json 键混入 / required ⊆ properties）；
 * ② resolveToolCallArgs 双形态判定纯函数（命名参数优先 / arguments_json 兼容 / 皆空）；
 * ③ catalogSnippetFor 组内共享 + 长度帽 + 隐藏条目不进附录；
 * ④ 注册面传参形态：piProvider 源码锚（还原转红——把 parameters 折叠回泛型或摘掉
 *    双形态判定，本节即红）+ 用仓库真 pi-ai validateToolArguments 校验全部真实
 *    schema（模拟 pi 引擎对注册工具的实际校验路径）。
 * 运行: node test/catalog-tool-schema.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-schema-'));
const compile = createSharedCompiler(root, tmp);
const catalog = await import(pathToFileURL(compile('main/capabilities/catalog.ts')).href);

const {
  TOOL_DEFS,
  catalogSnippetFor,
  catalogAppendixText,
  hasNamedParameters,
  resolveToolCallArgs
} = catalog;

// pi-ai 是 ESM-only（exports 只挂 import 条件，require.resolve 拒绝）：优先走仓库
// node_modules 直拼；解析不到（如 worktree 无自己的 node_modules、依赖 hoist 在上层）
// 再退回 import.meta.resolve——它同样只认 import 条件，且以本文件为基准向上找 node_modules
const piAiEntry = path.join(root, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'index.js');
const piAiHref = fs.existsSync(piAiEntry)
  ? pathToFileURL(piAiEntry).href
  : import.meta.resolve('@earendil-works/pi-ai');
const { validateToolArguments } = await import(piAiHref);

// ---------- ① 全量 parameters 结构合法性扫描（静态 + 合成动态同规则） ----------
{
  const defs = [
    ...TOOL_DEFS,
    {
      name: 'ext.demo.ping',
      description: 'ping 目标环境',
      dangerous: false,
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
    }
  ];
  const bad = [];
  for (const def of defs) {
    const p = def.parameters;
    if (!p || p.type !== 'object') bad.push(`${def.name}: type≠object`);
    if (!p.properties || typeof p.properties !== 'object' || Array.isArray(p.properties)) {
      bad.push(`${def.name}: properties 不是对象`);
      continue;
    }
    if ('arguments_json' in p.properties) {
      bad.push(`${def.name}: properties 混入 arguments_json（会教模型用它）`);
    }
    for (const req of p.required ?? []) {
      if (!(req in p.properties)) bad.push(`${def.name}: required "${req}" 不在 properties`);
    }
  }
  assert.deepEqual(bad, [], `parameters 结构非法：\n${bad.join('\n')}`);

  // R3b run 入口规约：八域信封 schema 只含 action/params（枚举词表 + 对象参数），
  // 不得混入 arguments_json（会教模型绕过信封形态）；required 固定 [action, params]。
  {
    const { RUN_TOOL_DEFS } = await import(pathToFileURL(compile('main/capabilities/catalog/runTools.ts')).href);
    assert.equal(RUN_TOOL_DEFS.length, 12, 'eleven skill domains plus resident session management');
    for (const def of RUN_TOOL_DEFS) {
      const keys = Object.keys(def.parameters.properties).sort();
      assert.deepEqual(keys, ['action', 'params'], `${def.name}: envelope properties are exactly action/params`);
      assert.equal('arguments_json' in def.parameters.properties, false, `${def.name}: no arguments_json in the envelope`);
      assert.deepEqual(def.parameters.required, ['action', 'params'], `${def.name}: both envelope fields required`);
      assert.ok(Array.isArray(def.parameters.properties.action.enum) && def.parameters.properties.action.enum.length > 0, `${def.name}: action enum is non-empty`);
      assert.equal(def.parameters.properties.params.type, 'object', `${def.name}: params is a free object`);
      assert.equal(def.dangerous, false, `${def.name}: entry routes only, per-action gates stay on real targets`);
    }
  }

  // 形态分布：两类都非空（有真 schema 走命名注册；空 properties 走泛型兜底）
  const named = TOOL_DEFS.filter(hasNamedParameters);
  const generic = TOOL_DEFS.filter((d) => !hasNamedParameters(d));
  assert.ok(named.length > 100, `绝大多数工具带命名参数（当前 ${named.length}）`);
  assert.ok(generic.length > 0, '存在无 properties 工具（泛型兜底路径不被删）');
  for (const d of generic) {
    assert.equal(d.dangerous, false, `${d.name}: 无参工具不应是 dangerous（confirmNote 参数无归宿）`);
  }
  // 泛型兜底名单钉死：某带参工具的 properties 被误删即滑向泛型（模型失去参数结构、
  // 退回 arguments_json 猜参数），这里转红；新增真正的无参工具（合理）在此补名单
  assert.deepEqual(
    generic.map((d) => d.name).sort(),
    [
      'app.getConfig',
      'app.instances',
      'automations.list',
      'browser.tabs',
      'extensions.inspect',
      'extensions.list',
      'llm.listProviders',
      'panel.list',
      'runtimes.list',
      'scheduler.policy.get',
      'themes.list',
      'workflow.list'
    ],
    '泛型兜底名单漂移：properties 被误删滑向泛型的工具会失去命名参数 schema；新无参工具请在此补名单'
  );
  console.log(
    `ok  ① parameters 结构扫描（${defs.length} 个含 1 合成动态；命名参数 ${named.length} / 泛型兜底 ${generic.length}，名单精确断言）`
  );
}

// ---------- ② resolveToolCallArgs 双形态判定 ----------
{
  // 命名参数优先：混传时忽略 arguments_json
  const mixed = resolveToolCallArgs({ arguments_json: '{"a":1}', sessionId: 's1', limit: 5 });
  assert.ok(mixed.ok && mixed.args.sessionId === 's1' && mixed.args.limit === 5);
  assert.equal('arguments_json' in mixed.args, false, '命名形态不夹带 arguments_json');

  // 纯 arguments_json 兼容形态
  const legacy = resolveToolCallArgs({ arguments_json: '{"task":"查缺陷"}' });
  assert.ok(legacy.ok && legacy.args.task === '查缺陷');

  // arguments_json 非对象值透传（executor 以 {value} 包装承接）
  const scalar = resolveToolCallArgs({ arguments_json: '5' });
  assert.ok(scalar.ok && scalar.args === 5);

  // 皆空 → 空对象
  const empty = resolveToolCallArgs({});
  assert.ok(empty.ok && typeof empty.args === 'object' && Object.keys(empty.args).length === 0);
  const emptyJson = resolveToolCallArgs({ arguments_json: '{}' });
  assert.ok(emptyJson.ok && Object.keys(emptyJson.args).length === 0);
  const blank = resolveToolCallArgs({ arguments_json: '   ' });
  assert.ok(blank.ok && Object.keys(blank.args).length === 0);

  // 非法 JSON → ok:false（不 throw，注册面直接回错误内容）
  const bad = resolveToolCallArgs({ arguments_json: '{oops' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Invalid arguments JSON/);
  console.log('ok  ② resolveToolCallArgs 双形态（命名优先/兼容/皆空/坏 JSON）');
}

// ---------- ③ catalogSnippetFor：组共享 / 长度帽 / 隐藏条目不进附录 ----------
{
  const a = catalogSnippetFor(TOOL_DEFS.find((d) => d.name === 'sessions.observe'));
  const b = catalogSnippetFor(TOOL_DEFS.find((d) => d.name === 'sessions.integrate'));
  assert.notEqual(a,b,'组内不同动作使用不同摘要');
  assert.match(a,/List sessions or read one target/);
  for(const def of TOOL_DEFS) {
    const snippet=catalogSnippetFor(def);
    assert.ok(snippet.length>0 && snippet.length<=41,def.name);
  }
  assert.equal(catalogSnippetFor({name:'weird',description:''}),'weird');

  // 隐藏条目不进附录（R4 同源过滤）；组行（组级地图）不再出现在附录
  const full = catalogAppendixText();
  assert.doesNotMatch(full, /tools\.search/, 'R5 发现层退役：附录不再指路 tools.search');
  assert.doesNotMatch(full, /tools\.call/, 'R5 发现层退役：附录不再指路 tools.call');
  assert.match(full, /resident and registered natively/, '附录以常驻直调流程开头');
  assert.doesNotMatch(full, /\[sessions\] \d+ 个工具/, '组级地图行不在附录（已寄生进 Available tools）');
  assert.match(full, /Available families/, '指引点名行内标注位置');
  const turnVisibility = await import(pathToFileURL(compile('shared/turnVisibility.ts')).href);
  const pt = turnVisibility.resolveTurnHiddenTools('prompt-task');
  const pruned = catalogAppendixText(pt);
  assert.doesNotMatch(pruned, /- tasks\.delegate：/, '定点被裁条目从附录消失');
  assert.doesNotMatch(pruned, /- chat\.injectBrief：/);
  assert.match(pruned, /call them directly.*run entries.*skill under ~\/\.muster\/skills\//, '精简后的目录教常驻直调、run 入口与技能路径（R5 无发现层）');
  console.log(`ok  ③ snippet 组共享/长度帽 + 附录过滤（full ${full.length} 字 → pruned ${pruned.length} 字）`);
}

// ---------- ④ 注册面传参形态：源码锚 + pi 真校验路径 ----------
{
  // 还原转红自查：把 registerOneIn 的 parameters 折叠回无条件 Type.Object 泛型、
  // 或把 promptSnippet 改回 def.name、或摘掉 resolveToolCallArgs 双形态，本节即红。
  const piSrc = fs.readFileSync(path.join(root, 'src/main/agent/providers/piProvider.ts'), 'utf8');
  assert.ok(
    piSrc.includes('parameters: hasNamedParameters(registered)') &&
      piSrc.includes('registered.parameters'),
    '注册面必须按工具形态二选一：真 schema / 泛型兜底'
  );
  assert.ok(
    piSrc.includes('promptSnippet: catalogSnippetFor(def)'),
    'promptSnippet 必须用组职责标注（A6 目录页寄生）'
  );
  assert.ok(
    piSrc.includes('resolve: resolveToolCallArgs,'),
    'execute 必须经双形态判定纯函数'
  );
  assert.ok(
    piSrc.includes('JSON.stringify(resolvedArgs ?? {})'),
    '双形态结果必须落到 executor 参数'
  );

  // 用仓库真 pi-ai 校验器过一遍全部真实 schema（模拟 pi 引擎对每个注册工具的实际
  // 调用路径：validateToolArguments(tool, toolCall)——枚举/oneOf/coercion 都走真代码）。
  // 参数填充规则：required 键按 property.type 造最小合法值（enum 取首项）。
  const fill = (prop) => {
    if (prop.const !== undefined) return prop.const;
    if (Array.isArray(prop.enum)) return prop.enum[0];
    if (Array.isArray(prop.oneOf)) return fill({type:prop.type,...prop.oneOf[0]});
    switch (prop.type) {
      case 'boolean':
        return true;
      case 'number':
      case 'integer':
        return 1;
      case 'array':
        return Array.from({length:prop.minItems ?? 0},()=>fill(prop.items ?? {}));
      case 'object':
        return Object.fromEntries((prop.required ?? []).map(key=>[key,fill(prop.properties?.[key] ?? {})]));
      default:
        return 'x';
    }
  };
  let checked = 0;
  const fails = [];
  for (const def of TOOL_DEFS) {
    if (!hasNamedParameters(def)) continue;
    const args = def.name === 'panel.open' ? { path: 'README.md' } : {};
    for (const key of new Set([...(def.parameters.required ?? []), ...(def.parameters.oneOf?.[0]?.required ?? [])])) {
      const common = def.parameters.properties[key];
      const branch = def.parameters.oneOf?.[0]?.properties?.[key];
      const prop = branch ? { ...common, ...branch,
        properties: { ...common?.properties, ...branch.properties },
        required: [...new Set([...(common?.required ?? []), ...(branch.required ?? [])])] } : common;
      args[key] = prop ? fill(prop) : 'x';
    }
    if (def.name.startsWith('github.') && args.version) {
      args.version = { repository: 'team/repo', number: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };
    }
    try {
      validateToolArguments(
        { name: def.name, description: def.description, parameters: def.parameters },
        { name: def.name, arguments: args }
      );
      checked++;
    } catch (e) {
      fails.push(`${def.name}: ${String(e.message).split('\n').slice(0, 2).join(' | ')}`);
    }
  }
  assert.deepEqual(fails, [], `pi 校验拒绝的 schema：\n${fails.join('\n')}`);
  const validate = (name,args) => validateToolArguments(catalog.getToolDef(name), {name,arguments:args});
  for(const schedule of [{kind:'once',at:'2030-01-01T09:00:00+08:00'},{kind:'daily',time:'09:00'},{kind:'weekly',time:'09:00',weekdays:[1,5]},{kind:'interval',intervalMinutes:15}]) {
    validate('automations.create',{name:'review',runtime:'pi',prompt:'Review pending work',schedule});
  }
  assert.throws(()=>validate('automations.create',{name:'x',runtime:'pi',prompt:'x',schedule:{kind:'weekly',time:'09:00'}}),/Validation failed/);
  assert.throws(()=>validate('sessions.setArchived',{sessionIds:[],archived:true}),/Validation failed/);
  assert.throws(()=>validate('sessions.create',{task:'x',isolation:'false'}),/Validation failed/);
  for (const name of ['sessions.create','runs.delegate']) {
    const base = name === 'runs.delegate' ? {runId:'run',task:'work'} : {task:'work'};
    assert.throws(()=>validate(name,base),/Validation failed/, name+' requires an explicit isolation choice');
    assert.throws(()=>validate(name,{...base,isolation:'auto'}),/Validation failed/);
    validate(name,{...base,isolation:'shared'});
    validate(name,{...base,isolation:'isolated',isolationGroups:[{rootId:'root',relativePath:'',repoSet:[]}]});
    assert.throws(()=>validate(name,{...base,isolation:'isolated',isolationGroups:[{rootId:'root',relativePath:''}]}),/Validation failed/);
  }
  validate('browser.setViewport', {tabId:'tab',reset:true});
  validate('browser.setViewport', {tabId:'tab',width:800,height:600});
  assert.throws(()=>validate('browser.setViewport',{tabId:'tab'}),/Validation failed/);
  assert.throws(()=>validate('browser.setViewport',{tabId:'tab',reset:true,width:800,height:600}),/Validation failed/);
  assert.throws(()=>validate('browser.setViewport',{tabId:'tab',reset:true,width:800}),/Validation failed/);
  validate('askQuestion',{questions:[{question:'Choose',options:[{label:'A'}],multiSelect:true}]});

  // oneOf 抽查：sessions.list 的 archived boolean|string 枚举不被 pi 拒（计划风险项闭环）
  const sessionsList = TOOL_DEFS.find((d) => d.name === 'sessions.observe');
  const oneOfOut = validateToolArguments(
    { name: 'sessions_observe', description: '', parameters: sessionsList.parameters },
    { name: 'sessions_observe', arguments: { archived: true, limit: 5 } }
  );
  assert.equal(oneOfOut.archived, true, 'oneOf boolean 分支直通');
  console.log(`ok  ④ 注册形态源码锚 + pi-ai 真校验（${checked} 个真 schema 全过，含 oneOf 抽查）`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('ok   catalog-tool-schema.mjs');
