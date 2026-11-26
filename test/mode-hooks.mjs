/**
 * Pi 模式钩子纯逻辑：stable snapshot 注入（prompt cache 友好）+ 上下文瘦身截断落盘句柄。
 * 运行: node test/mode-hooks.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-hooks-'));
const src = path.join(root, 'src/main/agentSession/drivers/pi/modeHooksExtension.ts');
const out = path.join(tmp, 'modeHooksExtension.mjs');
{
  const { outputText } = ts.transpileModule(fs.readFileSync(src, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: src
  });
  fs.writeFileSync(out, outputText, 'utf8');
}
const mh = await import(pathToFileURL(out, { windows: true }).href);

// ---- renderTurnInject 基础 ----
const t10 = new Date(2026, 8, 1, 10, 5);
const t11 = new Date(2026, 8, 1, 11, 5);
const nextDay = new Date(2026, 8, 2, 9, 0);
assert.ok(
  mh.renderTurnInject('现在 {{now}} / {{date}} / {{time}} / {{cwd}}', { now: t10, cwd: '/w' }).includes(
    '2026-09-01 10:05'
  ),
  'now 占位符'
);
assert.ok(
  mh.renderTurnInject('{{cwd}}', {}).includes('{{cwd}}'),
  '未知 cwd 原样保留'
);

// ---- stable snapshot：同日逐字节相同，翻日才重渲染 ----
const tpl = '汇报时间 {{now}}';
const first = mh.stableTurnInject(undefined, tpl, { now: t10, cwd: '/w' });
const second = mh.stableTurnInject(first, tpl, { now: t11, cwd: '/w' });
assert.equal(first.text, '汇报时间 2026-09-01 10:05');
assert.equal(second.text, first.text, '同日 11 点仍复用 10 点渲染结果（字节相同）');
assert.equal(second.dayKey, first.dayKey);
const rolled = mh.stableTurnInject(second, tpl, { now: nextDay, cwd: '/w' });
assert.equal(rolled.text, '汇报时间 2026-09-02 09:00', '翻日重渲染');
assert.notEqual(rolled.dayKey, second.dayKey);

// ---- trimToolResults：截断 + persist 句柄 ----
const mkMsgs = (text) => [{ role: 'toolResult', content: [{ type: 'text', text }] }];
const long = 'x'.repeat(101);
const trimmed = mh.trimToolResults(mkMsgs(long), 100);
assert.match(trimmed[0].content[0].text, /已截断.*原 101 字符/, '纯截断标记');

const persisted = [];
const withPersist = mh.trimToolResults(mkMsgs(long), 100, (full) => {
  persisted.push(full);
  return '/cache/abc.txt';
});
assert.deepEqual(persisted, [long], 'persist 收到全文');
assert.match(
  withPersist[0].content[0].text,
  /全文已存盘：\/cache\/abc\.txt.*read 工具/,
  '标记带落盘路径与 read 指引'
);
// 短块不截断不落盘；非 toolResult 消息不动
let calls = 0;
const mixed = [
  { role: 'user', content: [{ type: 'text', text: long }] },
  { role: 'toolResult', content: [{ type: 'text', text: 'short' }] },
  { role: 'toolResult', content: [{ type: 'text', text: long }] }
];
mh.trimToolResults(mixed, 100, () => {
  calls += 1;
  return '';
});
assert.equal(calls, 1, '只对超长 toolResult 落盘');
assert.equal(mixed[1].content[0].text, 'short');
assert.equal(mixed[0].content[0].text, long, 'user 消息不动');

// ---- makeTrimPersister：真 fs 落盘 + 内容寻址去重 ----
const trimDir = path.join(tmp, 'trim-cache', 'sess1');
const persist = mh.makeTrimPersister(trimDir);
const p1 = persist(long);
assert.ok(fs.existsSync(p1), '全文已写盘');
assert.equal(fs.readFileSync(p1, 'utf8'), long);
const p2 = persist(long);
assert.equal(p2, p1, '同内容同路径（内容寻址去重）');
assert.equal(persist('y'.repeat(101)) !== p1, true, '不同内容不同路径');
assert.equal(
  fs.readdirSync(trimDir).some((f) => f.endsWith('.tmp')),
  false,
  '无残留临时文件'
);
// 不可写目录静默降级为空串（trimDir 是已存在的普通文件 → mkdir 失败）
const blocker = path.join(tmp, 'blocker-file');
fs.writeFileSync(blocker, 'not a dir', 'utf8');
const badPersist = mh.makeTrimPersister(blocker);
assert.equal(badPersist(long), '', '落盘失败返回空串（降级纯截断）');

// ---- 工厂接线：stable 注入字节稳定 / trim 走真落盘 ----
function fakePi() {
  const handlers = {};
  return {
    on(ev, fn) {
      handlers[ev] = fn;
    },
    handlers
  };
}
{
  const factory = mh.createPiModeHooksExtension(
    { turnInject: 'time {{now}}', turnInjectStable: true },
    { cwd: '/w' }
  );
  const pi = fakePi();
  factory(pi);
  const r1 = pi.handlers.before_agent_start({ systemPrompt: 'BASE' });
  const r2 = pi.handlers.before_agent_start({ systemPrompt: 'BASE' });
  assert.equal(r1.systemPrompt, r2.systemPrompt, 'stable：两轮注入逐字节相同');
  assert.match(r1.systemPrompt, /^BASE\n\ntime \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
}
{
  const factory = mh.createPiModeHooksExtension({ turnInject: 'time {{time}}' }, { cwd: '/w' });
  const pi = fakePi();
  factory(pi);
  const r1 = pi.handlers.before_agent_start({ systemPrompt: 'BASE' });
  assert.ok(r1.systemPrompt.startsWith('BASE'), '缺省每轮重渲染路径可用');
}
{
  // pi>=1.2 起 idle 的 sendCustomMessage({triggerTurn:true})（memory 回执/安全审查）
  // 也进 before_agent_start；custom run 不注入回合模板与记忆，维持结构化 run 的提示面
  const injectFactory = mh.createPiModeHooksExtension(
    { turnInject: 'time {{now}}', turnInjectStable: true },
    { cwd: '/w' }
  );
  const pi = fakePi();
  injectFactory(pi);
  assert.equal(
    pi.handlers.before_agent_start({ systemPrompt: 'BASE', messageType: 'custom' }),
    undefined,
    'custom run 跳过回合注入'
  );
  assert.match(
    pi.handlers.before_agent_start({ systemPrompt: 'BASE', messageType: 'user' }).systemPrompt,
    /time \d{4}-\d{2}-\d{2}/,
    'user run 正常注入'
  );
  const memory = { read: () => 'MEM', version: () => 'v1' };
  const memFactory = mh.createPiModeHooksExtension(undefined, { cwd: '/w', memory });
  const pi2 = fakePi();
  memFactory(pi2);
  assert.equal(
    pi2.handlers.before_agent_start({ systemPrompt: 'BASE', messageType: 'custom' }),
    undefined,
    'custom run 跳过记忆段'
  );
  assert.match(
    pi2.handlers.before_agent_start({ systemPrompt: 'BASE', messageType: 'user' }).systemPrompt,
    /MEM/,
    'user run 带记忆段'
  );
}
{
  const factory = mh.createPiModeHooksExtension(
    { contextTrim: { maxToolResultChars: 100 } },
    { trimDir }
  );
  const pi = fakePi();
  factory(pi);
  const msgs = mkMsgs(long);
  const r = pi.handlers.context({ messages: msgs });
  assert.match(r.messages[0].content[0].text, /全文已存盘：/, 'context 钩子接入落盘句柄');
  const storedPath = r.messages[0].content[0].text.match(/全文已存盘：(.+?)（/)[1];
  assert.ok(fs.existsSync(storedPath), '句柄指向的文件真实存在');
}
{
  const pi = fakePi();
  const factory = mh.createPiModeHooksExtension(undefined, {});
  assert.equal(factory, null, '两项都没配不装扩展');
}

// ---- onInjectChange：逐轮注入变化上报（Harness 透明·逐轮注入追踪） ----
{
  // stable 回合注入：首轮报基线；同日重渲染字节相同不报；翻日重渲染才报
  const reports = [];
  const factory = mh.createPiModeHooksExtension(
    { turnInject: 'time {{now}}', turnInjectStable: true },
    {
      cwd: '/w',
      onInjectChange: (source, text) => reports.push([source, text])
    }
  );
  const pi = fakePi();
  factory(pi);
  pi.handlers.before_agent_start({ systemPrompt: 'BASE' });
  pi.handlers.before_agent_start({ systemPrompt: 'BASE' });
  assert.deepEqual(reports, [['回合注入', reports[0][1]]], 'stable：首轮报基线，同日不重复报');
  pi.handlers.before_agent_start({ systemPrompt: 'BASE' });
  assert.equal(reports.length, 1, '同日第三轮仍不报');
  assert.ok(reports[0][0] === '回合注入' && /time \d{4}-/.test(reports[0][1]), '上报带来源与渲染文本');
}
{
  // 非 stable 回合注入：逐轮重渲染（时间占位符），只报首轮基线，不逐轮刷屏
  const reports = [];
  const factory = mh.createPiModeHooksExtension(
    { turnInject: 'time {{now}}' },
    { cwd: '/w', onInjectChange: (source, text) => reports.push([source, text]) }
  );
  const pi = fakePi();
  factory(pi);
  pi.handlers.before_agent_start({ systemPrompt: 'BASE' });
  pi.handlers.before_agent_start({ systemPrompt: 'BASE' });
  pi.handlers.before_agent_start({ systemPrompt: 'BASE' });
  assert.equal(reports.length, 1, '非 stable：只报首轮基线');
}
{
  // 记忆注入：首轮报基线；同版本不报；版本变化（记忆写入）才报；空记忆不报
  let version = 'v1';
  let memory = '记忆内容 A';
  const reports = [];
  const factory = mh.createPiModeHooksExtension(
    {},
    {
      memory: { read: () => memory, version: () => version },
      onInjectChange: (source, text) => reports.push([source, text])
    }
  );
  const pi = fakePi();
  factory(pi);
  const r1 = pi.handlers.before_agent_start({ systemPrompt: 'BASE' });
  assert.ok(r1.systemPrompt.includes('记忆内容 A'), '记忆注入进系统提示');
  assert.equal(reports.length, 1, '记忆首轮报基线');
  assert.equal(reports[0][0], '记忆段');
  assert.ok(reports[0][1].includes('记忆内容 A'), '上报的是渲染后文本');
  pi.handlers.before_agent_start({ systemPrompt: 'BASE' });
  assert.equal(reports.length, 1, '同版本不重复报');
  memory = '记忆内容 A\n新增一行';
  version = 'v2';
  const r3 = pi.handlers.before_agent_start({ systemPrompt: 'BASE' });
  assert.ok(r3.systemPrompt.includes('新增一行'), '版本变化重渲染');
  assert.equal(reports.length, 2, '记忆变化才报');
  assert.ok(reports[1][1].includes('新增一行'));
  // 空记忆：钩子静默缺席，不上报
  memory = '';
  version = 'v3';
  pi.handlers.before_agent_start({ systemPrompt: 'BASE' });
  assert.equal(reports.length, 2, '空记忆不报');
}
{
  // 上报回调抛异常不影响注入主链路（旁路纪律）
  const factory = mh.createPiModeHooksExtension(
    { turnInject: 'time {{now}}', turnInjectStable: true },
    {
      cwd: '/w',
      onInjectChange: () => {
        throw new Error('上报通道炸了');
      }
    }
  );
  const pi = fakePi();
  factory(pi);
  const r = pi.handlers.before_agent_start({ systemPrompt: 'BASE' });
  assert.ok(r.systemPrompt.startsWith('BASE'), '上报故障不影响注入');
}

console.log('mode-hooks: ok');
