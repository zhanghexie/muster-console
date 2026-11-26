/**
 * 调度侧工具隐藏回归：
 * 1) SCHEDULER_HIDDEN_TOOL_NAMES 静态标记面（schedulerHidden def）；
 * 2) Bug A 执行面：无头 prompt-task 轮（runAsHeadlessTurn）下，run 入口展开出被裁
 *    真实目标（workflow.run action start、automations 域任一 action）与直接点名路径
 *    一律拒绝（英文错误、说明因当前轮隐藏）；正常轮不受影响。
 * 运行: node test/scheduler-hidden-tools.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-tools-'));
const compile = createSharedCompiler(process.cwd(), tmp);
const load = p => import(pathToFileURL(compile(p)).href);
const HIDDEN_REJECT = /hidden for the current turn.*headless prompt-task/s;
try {
  const electronDir = path.join(tmp, 'node_modules', 'electron');
  fs.mkdirSync(electronDir, { recursive: true });
  fs.appendFileSync(path.join(electronDir, 'index.cjs'), `module.exports.app.getPath = () => ${JSON.stringify(tmp)};\n`);
  const catalog = await load('main/capabilities/catalog.ts');
  assert.deepEqual([...catalog.SCHEDULER_HIDDEN_TOOL_NAMES], ['sessions.requestIntegrate']);
  assert.equal(catalog.getCatalogInfo().tools.find(t => t.name === 'host.sessions.requestIntegrate').workerVisible, true);
  for (const name of ['sessions.create', 'sessions.observe', 'sessions.message', 'mcp.search', 'mcp.call']) {
    assert.ok(!catalog.getToolDef(name).schedulerHidden);
  }
  const { sessionsHost } = await load('main/capabilities/hosts/sessions.ts');
  const { runAsSchedulerTool } = await load('main/agent/agentScope.ts');
  const names = [];
  const ctx = { resolveBubbleWorkspaceId: () => 'ws', renameAgentSession: async (ws, name) => { names.push([ws, name]); return { ok: true }; } };
  assert.deepEqual(await runAsSchedulerTool(() => sessionsHost['sessions.rename'](ctx, { name: '调度标题' })), { renamed: true, name: '调度标题' });
  assert.deepEqual(names, [['ws', '调度标题']]);
  ctx.renameAgentSession = async () => ({ ok: false, error: 'rename rejected' });
  await assert.rejects(() => runAsSchedulerTool(() => sessionsHost['sessions.rename'](ctx, { name: '失败不能冒成功' })), /rename rejected/);

  // ---------- Bug A 执行面：无头 prompt-task 轮的 run 展开/直调一律过隐藏面 ----------
  const entry = compile('main/capabilities/executor.ts');
  // stub 掉带外部依赖的 host 模块（本节只断言隐藏拒绝/放行，不触内置 handler）
  const execSrc = fs.readFileSync(path.join(process.cwd(), 'src/main/capabilities/executor.ts'), 'utf8');
  for (const [, exports, filename] of execSrc.matchAll(/import \{ ([^}]+) \} from '\.\/hosts\/([^']+)';/g)) {
    const body = exports.split(',').map((name) => `export const ${name.trim()} = {};`).join('\n');
    fs.writeFileSync(path.join(tmp, `main/capabilities/hosts/${filename}.mjs`), body);
  }
  const { executeTool } = await import(pathToFileURL(entry).href);
  const { runAsHeadlessTurn } = await load('main/agent/turnScope.ts');
  const stubCtx = {}; // 拒绝路径在触碰 ctx 之前返回；放行路径落到 handler 缺失报错

  // workflow.run 展开出被裁动词 start → 拒绝（英文、点名当前轮隐藏）
  const wfStart = await runAsHeadlessTurn(() =>
    executeTool(stubCtx, 'workflow.run', JSON.stringify({ action: 'start', params: { name: 'demo' } })));
  assert.equal(wfStart.ok, false, 'prompt-task 轮 workflow.run action=start 必须被拒');
  assert.match(wfStart.error, HIDDEN_REJECT, '错误信息英文且说明因当前轮隐藏');
  // automations 域整组隐藏：run 入口任一 action（含读）都被拒
  const autoList = await runAsHeadlessTurn(() =>
    executeTool(stubCtx, 'automations.run', JSON.stringify({ action: 'list', params: {} })));
  assert.equal(autoList.ok, false, 'prompt-task 轮 automations.run（整组隐藏域）必须被拒');
  assert.match(autoList.error, HIDDEN_REJECT);
  // 绕过入口名检查的路径：直接点名退役动词 / 整组工具，同样拒绝
  const directVerb = await runAsHeadlessTurn(() =>
    executeTool(stubCtx, 'workflow.start', JSON.stringify({ name: 'demo' })));
  assert.equal(directVerb.ok, false);
  assert.match(directVerb.error, HIDDEN_REJECT, '直接点名被裁动词同样拒绝');
  const groupTool = await runAsHeadlessTurn(() => executeTool(stubCtx, 'runtimes.list', '{}'));
  assert.match(groupTool.error, HIDDEN_REJECT, '整组隐藏工具直调同样拒绝');
  // 隐藏面之外的读动词不被执行面误伤（workflow.list 不在隐藏面，走过复核后落后续解析）
  const readVerb = await runAsHeadlessTurn(() =>
    executeTool(stubCtx, 'workflow.run', JSON.stringify({ action: 'list', params: {} })));
  assert.doesNotMatch(String(readVerb.error), HIDDEN_REJECT, '未裁动词不被执行面误伤');
  // 正常轮（无无头上下文）不受影响：同一调用不触发隐藏拒绝
  const normalTurn = await executeTool(stubCtx, 'workflow.run', JSON.stringify({ action: 'start', params: { name: 'demo' } }));
  assert.doesNotMatch(String(normalTurn.error), HIDDEN_REJECT, '正常轮不受执行面影响');
  const normalDirect = await executeTool(stubCtx, 'automations.run', JSON.stringify({ action: 'list', params: {} }));
  assert.doesNotMatch(String(normalDirect.error), HIDDEN_REJECT, '正常轮直调不受执行面影响');
  console.log('ok   scheduler-hidden-tools: 无头轮 run 展开/直调隐藏面执行复核');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
