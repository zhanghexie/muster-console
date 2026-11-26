import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-activity-'));
try {
  const compile = createSharedCompiler(process.cwd(), tmp);
  const { UsageStatsService } = await import(pathToFileURL(compile('main/usage/service.ts')).href);
  const { mergeUsageDays, emptyUsageDay, usageDayKey } = await import(pathToFileURL(compile('shared/usageStats.ts')).href);
  let days = {}, failures = [];
  const store = { loadUsageStats: () => structuredClone(days), saveUsageStats: v => { days = structuredClone(v); },
    loadUsageLlmCalls: () => [], saveUsageLlmCalls: () => {},
    loadUsageToolFailures: () => failures, saveUsageToolFailures: v => { failures = structuredClone(v); } };
  const usage = new UsageStatsService(store);
  usage.recordSessionCreated('agent', 'pi');
  assert.equal(Object.keys(mergeUsageDays(Object.values(usage.getDays())).activeSessions).length, 0);
  const info = { name: '旧会话', runtime: 'pi', workspaceId: 'w' };
  usage.recordSessionActivity('same', info); usage.recordSessionActivity('same', info);
  assert.equal(Object.keys(mergeUsageDays(Object.values(usage.getDays())).activeSessions).length, 1);
  const a = emptyUsageDay(), b = emptyUsageDay();
  a.activeSessions = { same: { ...info, lastActiveAt: 100 } };
  b.activeSessions = { same: { ...info, lastActiveAt: 200 }, other: { ...info, lastActiveAt: 201 } };
  const merged = mergeUsageDays([b, a]);
  assert.equal(Object.keys(merged.activeSessions).length, 2, '跨日不是每日数量相加');
  assert.equal(merged.activeSessions.same.lastActiveAt, 200);
  usage.recordToolCall('fs.read', false, { error: '401 Bearer secret-value api_key=key-value sk-secret123 \"api_key\":\"json-secret\"' });
  usage.recordToolCall('fs.read', false, { cancelled: true });
  usage.recordToolCall('fs.read', true);
  const today = usageDayKey(Date.now());
  const rows = usage.getToolFailures(today, today);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter(r => r.cancelled).length, 1);
  assert.ok(rows.some(r => r.error.includes('[REDACTED]')));
  assert.ok(!JSON.stringify(rows).includes('secret-value'));
  assert.ok(!JSON.stringify(rows).includes('key-value'));
  assert.ok(!JSON.stringify(rows).includes('json-secret'));
  assert.equal(usage.getToolFailures('2000-01-01', '2000-01-02').length, 0);
  // Basic 凭据和带空格/转义字符的密码也必须整体脱敏，不能只遮首个词。
  usage.recordToolCall('fs.read', false, { error: `Authorization: Basic dXNlcjpwYXNz\n"password":"my secret"\npassword='two words'\napi_key=unquoted secret value` });
  const privateRows = usage.getToolFailures(today, today);
  for (const secret of ['dXNlcjpwYXNz', 'my secret', 'two words', 'unquoted secret value']) {
    assert.ok(!JSON.stringify(privateRows).includes(secret), `凭据不得出现在展示数据: ${secret}`);
    assert.ok(!JSON.stringify(failures).includes(secret), `凭据不得出现在持久化数据: ${secret}`);
  }
  failures = privateRows.filter(r => !r.error.includes('Authorization:'));
  const restored = new UsageStatsService(store);
  assert.equal(restored.getToolFailures(today, today).length, 2, '重启保留失败原因');
  assert.equal(Object.keys(mergeUsageDays(Object.values(restored.getDays())).activeSessions).length, 1, '重启保留活动');
  failures = Array.from({ length: 1005 }, (_, i) => ({ id: String(i), name: 'fs.read', error: 'x', at: Date.now() - i, cancelled: false }));
  failures.push({ id: 'old', name: 'fs.read', error: 'expired', at: Date.now() - 31 * 86400000 });
  const capped = new UsageStatsService(store);
  assert.equal(failures.length, 1000);
  assert.equal(capped.getToolFailures(today, today).length, 1000);
  assert.ok(!JSON.stringify(failures).includes('expired'));
  // 真实 usage IPC 装配：不再依赖退役任务管理器，范围数据统一下发。
  const electronDir = path.join(tmp, 'node_modules', 'electron');
  fs.mkdirSync(electronDir, { recursive: true });
  fs.writeFileSync(path.join(electronDir, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js' }));
  fs.writeFileSync(path.join(electronDir, 'index.js'), 'export const ipcMain = { handle: (name, fn) => globalThis.__usageHandlers.set(name, fn) };');
  globalThis.__usageHandlers = new Map();
  const { registerUsageIpc } = await import(pathToFileURL(compile('main/ipc/usage.ts')).href);
  registerUsageIpc({ usage: restored, tasks: new Proxy({}, { get() { throw Error('不得查询无头任务'); } }) });
  const event = { sender: { id: 1, isDestroyed: () => false, send() {} } };
  const payload = await globalThis.__usageHandlers.get('usage:summary')(event, { fromKey: today, toKey: today });
  assert.equal(payload.toolFailures.length, 2);
  assert.equal(Object.keys(payload.rangeTotal.activeSessions).length, 1);
  assert.deepEqual(payload.headlessRuns, []);
  const emptyPayload = await globalThis.__usageHandlers.get('usage:summary')(event, { fromKey: '2000-01-01', toKey: '2000-01-01' });
  assert.equal(emptyPayload.toolFailures.length, 0);
  assert.equal(Object.keys(emptyPayload.rangeTotal.activeSessions).length, 0);
  delete globalThis.__usageHandlers;
  // 提取并执行真实入口回调，外部 IO 用小边界模拟。
  const ts = createRequire(import.meta.url)('typescript');
  function findNode(file, predicate) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    let found;
    function visit(node) { if (predicate(node, source)) found = node.getText(source); ts.forEachChild(node, visit); }
    visit(source); return found;
  }
  const inputFile = path.resolve('src/main/ipc/sessions.ts');
  let inputCallback;
  const source = ts.createSourceFile(inputFile, fs.readFileSync(inputFile, 'utf8'), ts.ScriptTarget.ES2022, true);
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'ipcMain.on' && node.arguments[0]?.text === 'pty:input')
      inputCallback = node.arguments[1].getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  const activities = [], writes = [];
  const input = new Function('ctx', 'desktopTurnGrants', ts.transpileModule(`return (${inputCallback});`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)({
    pty: { write: (...args) => { writes.push(args); return true; } },
    sessions: { clearCliSuggestedReplies() {}, get: id => id === 'terminal' ? {id, name:'终端', runtime:'claude', workspaceId:'w'} : undefined },
    usage: { recordSessionActivity: (...args) => activities.push(args) }
  }, { nextUserMessage() {} });
  input(null, 'terminal', '\x1b[?1;2c'); input(null, 'terminal', '\x1b[A');
  assert.equal(activities.length, 0, '设备应答与方向键不算活跃提交');
  input(null, 'terminal', 'hello\r'); input(null, 'missing', '\r');
  assert.equal(activities.length, 1);
  assert.equal(activities[0][0], 'terminal'); assert.equal(writes.length, 4);
  const executeSource = findNode(path.resolve('src/main/capabilities/executor.ts'), node => ts.isFunctionDeclaration(node) && node.name?.text === 'executeTool').replace(/^export /, '');
  // runUsageRecordName 是 executor 的模块内辅助（run 入口展开为真实目标名）；本用例
  // 只锁 recordToolCall 转发合同，注入恒等 stub（fs.read 非 run 入口本就原样返回）
  const execute = new Function('executeToolInner', 'getToolDef', 'isNetworkSourceTool', 'markTurnNetworkTaint', 'runUsageRecordName',
    ts.transpileModule(`return (${executeSource});`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(
    async () => ({ok:false,error:'实际工具错误',cancelled:true}), name => name === 'fs.read', () => false, () => {}, (n) => n);
  const calls = [];
  const ctx = {usage:{recordToolCall:(...args)=>calls.push(args)}};
  await execute(ctx, 'fs.read', '{"neverPersist":"call arguments"}');
  assert.deepEqual(calls, [['fs.read', false, {error:'实际工具错误',cancelled:true}]], '真实执行器传递错误和取消，不传参数');
  await execute(ctx, 'unknown.tool', '{}'); assert.equal(calls.length, 1, '未知工具不污染统计');
  console.log('ok usage activity, failures, persistence, retention, IPC, PTY filtering and executor forwarding');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
