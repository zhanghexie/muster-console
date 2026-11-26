import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-discovery-'));
const compile = createSharedCompiler(root, tmp);
const read = relative => import(pathToFileURL(compile(relative)).href);
try {
  const discovery = await read('shared/toolDiscovery.ts');
  const { filterResidentHostTools } = await read('main/agentSession/tools/discovery.ts');
  const { decideToolCallPermission } = await read('main/agentSession/tools/policy.ts');
  const { TOOL_DEFS } = await read('main/capabilities/catalog/registry.ts');
  const { listHostToolIds, getHostToolMeta } = await read('shared/hostTools/index.ts');

  // ---------- GUI Worker surface: resident filter keeps residents + native registrations, no proxies ----------
  const seen = [];
  const candidates = [
    { id: 'sessions.observe', description: 'Observe sessions', parameters: { type: 'object' }, permissionClass: 'read', execute: async () => 'observed' },
    { id: 'bgtasks.shell', description: 'Background run', parameters: { type: 'object' }, permissionClass: 'shell', execute: async () => 'shell' },
    { id: 'browser.click', description: 'Retired direct browser name', parameters: { type: 'object' }, permissionClass: 'browser', execute: async () => 'clicked' },
    ...['mcp', 'modes.set'].map(id => ({ id, description: 'native tool', parameters: { type: 'object' },
      permissionClass: 'dynamic', execute: async () => { seen.push(id); return id; } }))
  ];
  const tools = filterResidentHostTools(candidates);
  // R5：发现层退役——tools.search/tools.call 不再生成；常驻清单内与无 meta 的原生注册保留；
  // 带 meta 但不在常驻清单的条目（如退役的 browser 直调名）被过滤，不可达
  assert.deepEqual(tools.map(tool => tool.id), ['sessions.observe', 'bgtasks.shell', 'mcp', 'modes.set']);
  assert.ok(!tools.some(tool => tool.id.startsWith('tools.')), 'no discovery proxy pair is synthesized');
  assert.ok(!tools.some(tool => tool.id === 'browser.click'), 'retired direct browser names stay unreachable');
  assert.equal(await tools.find(tool => tool.id === 'mcp').execute({}, { sessionId: 'trusted', cwd: root }), 'mcp', 'native registration untouched');
  assert.equal(seen.pop(), 'mcp');

  // ---------- resident lists: end-state roster (R4 minus the retired discovery pair; +intent to worker 2026-10-23) ----------
  const scheduler = discovery.residentHostToolIds('scheduler'), worker = discovery.residentHostToolIds('worker');
  // 数量为当前实现快照：域壳化后 panel/desktop 各由 5 项并为 1 项（-8，两角色各减）。
  // 若增减工具，请同时确认 preset ⊆ 常驻不变量与本断言一致。
  assert.equal(worker.length, 55); assert.equal(scheduler.length, 73);
  assert.equal(new Set(scheduler).size, scheduler.length, '调度清单无重复');
  assert.equal(new Set(worker).size, worker.length, 'Worker 清单无重复');
  assert.ok(worker.includes('turnChanges.trackFiles') && scheduler.includes('turnChanges.trackFiles'));
  for (const preset of ['gui-full', 'acp-subset']) assert.ok(listHostToolIds(preset).includes('turnChanges.trackFiles'));
  assert.ok(!listHostToolIds('pty-allowlist').includes('turnChanges.trackFiles'));
  for (const id of ['panel.run', 'desktop.run', 'github.run']) {
    assert.ok(worker.includes(id) && scheduler.includes(id), `${id} is resident for both roles`);
    assert.equal(getHostToolMeta(id)?.permissionClass, 'read');
    assert.equal(getHostToolMeta(id)?.bind, 'actor');
    for (const preset of ['gui-full', 'pty-allowlist', 'acp-subset']) assert.ok(listHostToolIds(preset).includes(id));
  }
  // 域壳化：原五项保留为内部真源（供 run 展开后判档），不再投影到任何面。
  for (const id of ['panel.list', 'panel.open', 'panel.split', 'panel.focus', 'panel.close']) {
    assert.ok(!worker.includes(id) && !scheduler.includes(id), `${id} is reachable only through panel.run`);
    assert.equal(getHostToolMeta(id)?.permissionClass, id === 'panel.list' ? 'read' : 'edit');
    assert.equal(getHostToolMeta(id)?.bind, 'actor');
    for (const preset of ['gui-full', 'pty-allowlist', 'acp-subset']) assert.ok(!listHostToolIds(preset).includes(id));
  }
  for (const id of ['desktop.list', 'desktop.look', 'desktop.act', 'desktop.focus', 'desktop.launch']) {
    assert.ok(!worker.includes(id) && !scheduler.includes(id), `${id} is reachable only through desktop.run`);
    assert.equal(getHostToolMeta(id)?.permissionClass, id === 'desktop.act' || id === 'desktop.focus' || id === 'desktop.launch' ? 'edit' : 'read');
    assert.equal(getHostToolMeta(id)?.bind, 'actor');
    for (const preset of ['gui-full', 'pty-allowlist', 'acp-subset']) assert.ok(!listHostToolIds(preset).includes(id));
  }
  assert.ok(worker.includes('waitFor') && scheduler.includes('waitFor'));
  for (const id of ['events.list', 'events.read']) assert.ok(worker.includes(id) && scheduler.includes(id));
  assert.ok(scheduler.includes('events.resolveLaunch') && !worker.includes('events.resolveLaunch'));
  for (const id of ['feedback.propose', 'feedback.history', 'feedback.assess']) {
    assert.ok(worker.includes(id) && scheduler.includes(id));
    for (const preset of ['gui-full', 'pty-allowlist', 'acp-subset']) assert.ok(listHostToolIds(preset).includes(id));
  }
  for(const id of ['memory.get','memory.journalGet','memory.confirm'])assert.ok(worker.includes(id)&&scheduler.includes(id),`${id} must be reachable in both interactive roles`);
  assert.ok(listHostToolIds('pty-allowlist').includes('memory.get')&&listHostToolIds('pty-allowlist').includes('memory.journalGet'));
  assert.ok(!listHostToolIds('pty-allowlist').includes('memory.confirm'),'CLI mixed text is not user confirmation');
  assert.ok(worker.includes('extensions.run'), 'extension authoring is available to workers');
  assert.ok(worker.includes('ui.suggestReplies') && scheduler.includes('ui.suggestReplies'));
  assert.ok(worker.includes('ui.reminders') && scheduler.includes('ui.reminders'));
  for (const preset of ['gui-full', 'pty-allowlist', 'acp-subset']) assert.ok(listHostToolIds(preset).includes('ui.reminders'));
  assert.ok(listHostToolIds('gui-full').includes('ui.suggestReplies'));
  assert.ok(listHostToolIds('acp-subset').includes('ui.suggestReplies'));
  assert.ok(listHostToolIds('pty-allowlist').includes('ui.suggestReplies'));
  assert.ok(worker.includes('intent'), 'intent 已开放 Worker（2026-10-23）');
  // 发现层退役：双角色清单均不再含 tools.search / tools.call
  for (const list of [scheduler, worker]) for (const retired of ['tools.search', 'tools.call']) assert.ok(!list.includes(retired), `${retired} retired from the model surface`);
  for (const list of [scheduler, worker]) for (const paused of ['runtimes.register', 'runtimes.registerDriver', 'runtimes.driverTrustStatus'])
    assert.ok(!list.includes(paused), `${paused} must be absent while dynamic registration is paused`);
  // R2 browser 域 run 化：直调名从 Worker 常驻枚举消失，browser.run 单入口出现
  assert.ok(worker.includes('browser.run'), 'browser.run 常驻');
  assert.ok(!worker.includes('browser.click') && !worker.includes('browser.screenshot'), 'browser 直调名退出常驻枚举');
  for (const id of ['askQuestion','sessions.review','sessions.integrate','terminal.write','terminal.capture']) assert.ok(scheduler.includes(id));
  assert.ok(!scheduler.includes('sessions.requestIntegrate'), 'requestIntegrate 留在 Worker 面（catalog schedulerHidden）');
  // R4 调度新增直调抽查：会话编排、观察与事件、记忆、智能界面、调度策略、UI 问询、网关、应用、事件审核、intent
  for (const id of ['sessions.interrupt','sessions.run','sessions.completeAndArchive','sessions.delete',
    'sessions.setArchived','sessions.rename','sessions.isolate','ui.notify','sessions.search','llm.quota','attachments.convert',
    'events.subscribe','events.unsubscribe','events.register','events.emit',
    'memory.search','memory.list','memory.note','memory.remember','memory.journal','memory.correct','memory.correctionStatus','ui.render','ui.inspect','scheduler.policy.get','scheduler.policy.set',
    'ui.confirm','ui.prompt','web.fetch','git.refreshRepos','app.getConfig','app.instances','events.review','intent']) {
    assert.ok(scheduler.includes(id), `R4 调度常驻缺 ${id}`);
  }
  // run 入口常驻（动作词表由各入口 schema 枚举承载）；dispatch.run 属调度专属，必须在场但不得进 Worker 面。
  for (const id of ['browser.run','workflow.run','runtimes.run','automations.run','themes.run','dispatch.run','llm.run','extensions.run','desktop.run','panel.run']) {
    assert.ok(scheduler.includes(id), `run 入口缺 ${id}`);
  }
  assert.ok(!worker.includes('dispatch.run'), '本地 CLI 派活入口只给调度身份');
  // R4 Worker 新增直调抽查（观察与事件/记忆/智能界面/摘要共享/后台任务/持久执行）
  for (const id of ['sessions.setArchived','sessions.rename','sessions.isolate','ui.notify','sessions.search','llm.quota',
    'attachments.convert','events.subscribe','events.unsubscribe','events.register','events.emit',
    'memory.search','memory.list','memory.note','memory.remember','memory.journal','memory.correct','memory.correctionStatus',
    'ui.render','ui.inspect','share.set','bgtasks.shell','bgtasks.wait','bgtasks.list','bgtasks.kill','node_repl.js']) {
    assert.ok(worker.includes(id), `R4 Worker 常驻缺 ${id}`);
  }
  // B1 MCP 中转两工具全角色常驻（未配置 server 时 search 空清单不报错）
  for (const id of ['mcp.search','mcp.call']) assert.ok(scheduler.includes(id) && worker.includes(id), `${id} 双角色常驻`);
  assert.match(discovery.searchToolDirectory([{name:'mcp.call',description:'',parameters:{}}], { query: '' }).groups, /mcp=third-party MCP servers/);
  // R4：事件订阅族从按需转常驻（§2.1 观察与事件 / §2.2 观察与事件剩余）
  for (const id of ['events.subscribe','events.unsubscribe']) assert.ok(scheduler.includes(id) && worker.includes(id), `${id} 双角色常驻`);

  // ---------- R5 invariant: preset surface ⊆ resident list（加工具忘进清单即红） ----------
  for (const preset of ['gui-full', 'pty-allowlist', 'acp-subset']) {
    const presetIds = listHostToolIds(preset);
    for (const id of presetIds) {
      assert.ok(worker.includes(id), `${preset} projects ${id} but the worker resident list does not include it — unlisted tools are unreachable since R5`);
    }
  }
  // Worker 清单内每一项都在某个 preset 投影里（清单与 preset 互相不悬空）
  const presetUnion = new Set(['gui-full', 'pty-allowlist', 'acp-subset'].flatMap(preset => listHostToolIds(preset)));
  for (const id of worker) assert.ok(presetUnion.has(id), `worker resident ${id} appears in no preset projection`);
  // 调度清单内每一项都有 catalog 注册面且非 schedulerHidden（bgtasks/node_repl 类内联 meta 仅 Worker 面）
  for (const id of scheduler) {
    const def = TOOL_DEFS.find(t => t.name === id);
    assert.ok(def, `scheduler resident ${id} has no catalog definition`);
    assert.ok(!def.schedulerHidden, `scheduler resident ${id} is schedulerHidden and can never surface`);
  }
  // 发现层退役后 meta 里不得再残留 discovery 组条目
  for (const retired of ['tools.search', 'tools.call']) assert.equal(getHostToolMeta(retired), undefined, `${retired} left no hostTool meta residue`);

  // ---------- dynamic-tools reachability: scheduler registration gate admits active ext.* entries ----------
  // Bug B 修复：tools.call 代理退役后，调度面调用 ext.<name> 的通路 = 常驻注册面纳入
  // 当前活跃动态工具（piProvider 注册时枚举 registry；中途新建走 onChange 补注册）。
  // 还原转红：把 isSchedulerRegisterableTool 的 ext.* 放行撤掉，本组即红。
  for (const id of ['ext.demo.ping', 'ext.any.thing']) {
    assert.equal(discovery.isSchedulerRegisterableTool(id), true, `${id}（活跃动态条目）可进调度注册面`);
  }
  for (const id of ['workflow.run', 'sessions.observe', 'browser.run']) {
    assert.equal(discovery.isSchedulerRegisterableTool(id), true, `${id} 常驻名单成员可注册`);
  }
  for (const id of ['workflow.start', 'automations.create', 'browser.click', 'llm.quota']) {
    assert.equal(discovery.isSchedulerRegisterableTool(id), id === 'llm.quota', `${id} retired 动词/非名单项不得混入注册门`);
  }

  // ---------- internal catalog directory query (diagnostic utility; paging/budget stays bounded) ----------
  const large = Array.from({length:3}, (_,i)=>({name:`test.${i}`,description:'d'.repeat(4700),parameters:{type:'object'}}));
  const page = discovery.searchToolDirectory(large,{includeSchema:true});
  assert.equal(page.tools.length, 1); assert.equal(page.nextOffset, 1, 'schema pages stay bounded without dropping the next entry');
  assert.equal(discovery.searchToolDirectory(large,{includeSchema:true,offset:page.nextOffset}).tools[0].name,'test.1');
  assert.match(JSON.parse(JSON.stringify(discovery.searchToolDirectory(large,{query:'no-such-capability'}))).hint, /enumerate/);

  // ---------- MCP relay policy stays on the decision table ----------
  const mcpPolicy = (mode, engineName, cls) => decideToolCallPermission({ mode, planExecuting: false,
    engineToolName: engineName, input: { server: 's', tool: 't', args: {} }, cwd: root,
    hostToolIds: ['mcp.search','mcp.call'], hostClassOf: () => cls, userRules: [] });
  assert.equal(mcpPolicy('ask','mcp_call','dynamic').decision, 'deny', 'ask 只读门下中转调用拒绝');
  assert.equal(mcpPolicy('default','mcp_call','dynamic').decision, 'prompt', '默认模式中转调用过审批卡（外部工具执行需用户可见）');
  assert.equal(mcpPolicy('ask','mcp_search','read').decision, 'auto', '发现类只读放行');
  // 发现层退役：tools.call 代理名不再有专门展开分支（未知工具 fail closed）
  const retiredProxy = decideToolCallPermission({ mode: 'ask', planExecuting: false,
    engineToolName: 'tools_call', input: { name: 'sessions.observe', arguments: {} }, cwd: root,
    hostToolIds: [], hostClassOf: () => 'dynamic', userRules: [] });
  assert.equal(retiredProxy.decision, 'prompt', 'retired proxy name is an unknown tool (fail closed at prompt, no expansion branch)');

  console.log('tool-discovery: OK (resident-only surface, preset-visible ⊆ resident invariant, roster checks, directory utility paging, MCP relay policy)');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
