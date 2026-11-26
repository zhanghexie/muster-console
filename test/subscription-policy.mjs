/**
 * 调度订阅策略（agent-comms-evolution-plan C1）：
 * - 纯函数：内置默认规则与改造前硬编码行为（shouldUplinkOrchEvent）逐 kind 等价；用户规则优先；
 *   数组/布尔匹配；底线事件不可静音；解析宽容/严格口径（拼错字段整条丢弃、保留前缀改名、钳位、底线提示）
 * - 事件泵：mute / digest（只捎带不唤醒）/ 底线兜底 / 守卫阈值与合并窗口随策略
 * - 事件泵归并后保存邮箱；订阅通知的存信、去重和回声守卫见 facts-subscribe-workspace.mjs
 * - 存储与工具：原子写 + 变更历史 + 外部改文件后缓存失效；scheduler.policy.set 身份门 / reason 必填 / 输入有错拒写
 * 运行: node test/subscription-policy.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-policy-'));
const compile = createSharedCompiler(root, tmp);

const policyMod = await import(pathToFileURL(compile('shared/subscriptionPolicy.ts')).href);
const {
  BUILTIN_POLICY_RULES,
  decidePolicyAction,
  effectivePolicyGuards,
  effectivePolicyTiming,
  emptySubscriptionPolicy,
  parseSubscriptionPolicy,
  describeSubscriptionPolicy,
  SUBSCRIPTION_POLICY_FILE
} = policyMod;
const { ORCH_EVENT_KINDS, shouldUplinkOrchEvent, aggregateOrchEvents } = await import(
  pathToFileURL(compile('shared/notifyQueue.ts')).href
);
const { OrchestratorEventPump } = await import(pathToFileURL(compile('main/orchestrator/events.ts')).href);
const { SubscriptionPolicyStore } = await import(
  pathToFileURL(compile('main/orchestrator/subscriptionPolicyStore.ts')).href
);
const {setAgentMessagesUserDataDir,readAgentMessageLedger,readAgentMessageBody}=await import(pathToFileURL(compile('main/metaAgent/messageStore.ts')).href);
setAgentMessagesUserDataDir(path.join(tmp,'userdata'));
const { subscriptionPolicyHost } = await import(
  pathToFileURL(compile('main/capabilities/hosts/subscriptionPolicy.ts')).href
);
const { runAsSchedulerTool } = await import(pathToFileURL(compile('main/agent/agentScope.ts')).href);

const policy = (raw) => {
  const r = parseSubscriptionPolicy(raw);
  assert.deepEqual(r.warnings, [], `测试策略应无告警：${r.warnings.join('；')}`);
  return r.policy;
};

// ---------- 1) 内置默认 ≡ 改造前硬编码（shouldUplinkOrchEvent） ----------
{
  for (const kind of ORCH_EVENT_KINDS) {
    // workflow 是 C1 之后新增的种类，改造前无对应硬编码（默认行为见 test/workflow.mjs）
    if (kind === 'fact' || kind === 'workflow') continue;
    const triggers = kind === 'phase' ? ['needs_you', 'error', 'done', undefined] : [undefined];
    for (const trigger of triggers) {
      const d = decidePolicyAction({ kind, ...(trigger ? { trigger } : {}) }, null);
      const legacy = shouldUplinkOrchEvent(kind, { phaseTrigger: trigger });
      assert.equal(d.action === 'wake', legacy, `${kind}${trigger ? `/${trigger}` : ''} 默认判定与旧硬编码一致`);
      assert.notEqual(d.action, 'digest', '内置默认不产生 digest');
    }
  }
  assert.equal(decidePolicyAction({ kind: 'fact', factKind: 'pipeline.verdict' }).action, 'wake', '订阅事实默认唤醒');
  assert.equal(decidePolicyAction({ kind: 'event.subscription', factKind: 'gitlab', trigger: 'issue' }).action, 'wake');
  assert.equal(
    decidePolicyAction({ kind: 'fact', factKind: 'session.phase', trigger: 'needs_you', orchestrated: true }).action,
    'mute',
    '编排会话相位事实由 phase 事件覆盖，免重复'
  );
  assert.equal(
    decidePolicyAction({ kind: 'fact', factKind: 'session.phase', trigger: 'needs_you', orchestrated: false }).action,
    'wake',
    '手工会话相位事实保持改造前行为（仍唤醒）'
  );
  assert.equal(BUILTIN_POLICY_RULES.at(-1).id, 'builtin.default');
  console.log('ok: 内置默认规则与改造前硬编码逐 kind 等价');
}

// ---------- 2) 用户规则优先 / 数组与布尔匹配 / 底线兜底 ----------
{
  const p = policy({
    rules: [
      { id: 'quiet', match: { kind: ['slot_free', 'commit'] }, action: 'digest' },
      { id: 'manual-phase', match: { kind: 'fact', orchestrated: false }, action: 'mute' },
      { id: 'hush-all-phase', match: { kind: 'phase' }, action: 'mute' }
    ]
  });
  assert.deepEqual(decidePolicyAction({ kind: 'slot_free' }, p), { action: 'digest', ruleId: 'quiet', floorOverride: false });
  assert.equal(decidePolicyAction({ kind: 'commit' }, p).action, 'digest', '数组任一命中');
  assert.equal(decidePolicyAction({ kind: 'fact', factKind: 'pipeline.verdict' }, p).action, 'mute', 'orchestrated 缺省视为 false');
  const floor = decidePolicyAction({ kind: 'phase', trigger: 'needs_you' }, p);
  assert.deepEqual(floor, { action: 'wake', ruleId: 'hush-all-phase', floorOverride: true }, '底线事件被静音规则命中仍唤醒');
  assert.equal(decidePolicyAction({ kind: 'phase', trigger: 'done' }, p).action, 'mute', '非底线相位照规则静音');
  const sourcePolicy = policy({ rules: [{ id: 'gitlab-digest', match: { kind: 'event.subscription', factKind: 'gitlab' }, action: 'digest' }] });
  assert.equal(decidePolicyAction({ kind: 'event.subscription', factKind: 'gitlab', trigger: 'issue' }, sourcePolicy).action, 'digest');
  assert.equal(decidePolicyAction({ kind: 'event.subscription', factKind: 'github', trigger: 'issue' }, sourcePolicy).action, 'wake');
  console.log('ok: 用户规则优先 + 数组/布尔匹配 + 底线兜底');
}

// ---------- 3) 解析：宽容读 / 告警分级 ----------
{
  const bad = parseSubscriptionPolicy({
    rules: [
      { id: 'typo', match: { kind: 'phase', tirgger: 'done' }, action: 'mute' },
      { id: 'unknown-kind', match: { kind: 'poll' }, action: 'mute' },
      { id: 'bad-action', match: {}, action: 'shout' },
      { id: 'builtin.mine', match: { kind: 'commit' }, action: 'wake' },
      { match: { kind: 'merge_blocked' }, action: 'mute' },
      { id: 'dup', match: { kind: 'turn_end' }, action: 'digest' },
      { id: 'dup', match: { kind: 'commit' }, action: 'digest' }
    ],
    timing: { mergeWindowMs: 1000, maxWaitMs: 2000 },
    guards: { heartbeatMs: 60_000, needsYouMs: 3_600_000, heartbeat: false }
  });
  const ids = bad.policy.rules.map((r) => r.id);
  assert.deepEqual(ids, ['user.mine', 'rule-5', 'dup', 'dup-2'], `拼错字段/未知 kind/坏动作整条丢弃，保留前缀改名，缺 id 补号，重名加后缀：${ids}`);
  assert.ok(bad.warnings.some((w) => w.includes('tirgger')), '拼错字段有告警');
  assert.ok(bad.warnings.some((w) => w.includes('poll')), '未知 kind 有告警');
  assert.ok(bad.warnings.some((w) => w.includes('builtin.')), '保留前缀有告警');
  assert.ok(bad.notices.some((n) => n.includes('rule-5')), '静音合入被挡：底线提示进 notices 不进 warnings');
  assert.equal(bad.policy.timing.mergeWindowMs, 5_000, '合并窗口钳到下界');
  assert.equal(bad.policy.timing.maxWaitMs, 5_000, 'maxWait 钳后不小于窗口');
  assert.equal(bad.policy.guards.heartbeatMs, 5 * 60_000, '心跳阈值钳到下界');
  assert.equal(bad.policy.guards.needsYouMs, 3_600_000);
  assert.ok(bad.warnings.some((w) => w.includes('heartbeat')), '未知守卫字段有告警并指路 rules');

  const broken = parseSubscriptionPolicy('{not json');
  assert.deepEqual(broken.policy.rules, []);
  assert.equal(broken.warnings.length, 1, '坏 JSON 按空策略处理并告警');

  assert.deepEqual(effectivePolicyTiming(emptySubscriptionPolicy()), { mergeWindowMs: 25_000, maxWaitMs: 45_000 });
  assert.deepEqual(effectivePolicyGuards(null), { heartbeatMs: 15 * 60_000, needsYouMs: 30 * 60_000 });
  const desc = describeSubscriptionPolicy(bad.policy, { warnings: bad.warnings });
  assert.equal(desc.file, SUBSCRIPTION_POLICY_FILE);
  assert.ok(Array.isArray(desc.floor) && desc.floor.length >= 5, '全貌带底线清单');
  assert.ok(desc.eventKinds.fact, '全貌带事件种类词表');
  console.log('ok: 解析宽容读（丢弃/改名/钳位）+ 告警与底线提示分级');
}

// ---------- 事件泵工具 ----------
const wsDir = path.join(tmp, 'ws');
fs.mkdirSync(wsDir, { recursive: true });

function makeCtx({ sessions = [], sent = [] } = {}) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return {
    sessions: {
      broadcastMessagesChanged() {},
      get: (id) => byId.get(id),
      list: () => sessions,
      listByWorkspace: (ws) => sessions.filter((s) => s.workspaceId === ws)
    },
    workspaces: { list: () => [{ id: 'ws1', path: path.join(tmp, 'source'), controlRoot: wsDir }] },
    config: { get: () => ({ workspaces: [{ id: 'ws1', path: path.join(tmp, 'source'), controlRoot: wsDir }] }) },
    orchestrator: {
      isBusy: () => false,
      send: async (text, wsId) => {
        sent.push({ text, wsId });
      }
    }
  };
}

function makePump(ctx, pol, extra = {}) {
  const timers = [];
  const pump = new OrchestratorEventPump({
    ctx,
    now: extra.now ?? (() => 1_000),
    setTimeout: (_fn, ms) => {
      timers.push(ms);
      return 0;
    },
    clearTimeout: () => {},
    enabled: () => true,
    policyFor: () => pol,
    ...extra.deps
  });
  return { pump, timers };
}

// ---------- 4) 泵：mute / digest 捎带 / digest 不单独唤醒 ----------
{
  const pol = policy({
    rules: [
      { id: 'quiet-settle', match: { kind: 'settle_warn' }, action: 'digest' },
      { id: 'no-slot', match: { kind: 'slot_free' }, action: 'mute' }
    ]
  });
  const sent = [];
  const { pump } = makePump(makeCtx({ sent }), pol);
  pump.enqueue({ kind: 'slot_free', workspaceId: 'ws1', detail: '可补位' });
  assert.deepEqual(pump.peek('ws1'), [], 'mute 不入队');
  pump.enqueue({ kind: 'settle_warn', workspaceId: 'ws1', detail: '任务可能悬挂 t-9' });
  assert.deepEqual(pump.peek('ws1'), [], 'digest 不进唤醒队列');
  assert.equal(pump.peekDigest('ws1').length, 1, 'digest 进顺带段');
  assert.equal(await pump.flush('ws1'), 'skip', '只有顺带事件时不唤醒');
  assert.equal(sent.length, 0);
  assert.equal(pump.peekDigest('ws1').length, 1, '不唤醒时顺带事件保留');

  pump.enqueue({ kind: 'merge_blocked', workspaceId: 'ws1', detail: '主仓脏文件挡住合入：a.ts' });
  assert.equal(await pump.flush('ws1'), 'send');
  const mail=readAgentMessageLedger(wsDir,'ws1').messages.at(-1);
  assert.equal(mail.to,'orchestrator:ws1');
  const body=readAgentMessageBody(wsDir,'ws1',mail);
  assert.match(body,/合入被挡/);
  assert.match(body,/顺带（订阅策略设为 digest/);
  assert.match(body,/任务可能悬挂 t-9/,'顺带内容随唤醒事件持久化');
  assert.deepEqual(pump.peekDigest('ws1'), [], '发送后顺带段清空');

  const plain = aggregateOrchEvents([{ id: 'x', kind: 'merge_blocked', workspaceId: 'ws1', ts: 1, key: 'k' }]);
  assert.doesNotMatch(plain, /顺带/, '无顺带事件时消息形态与改造前一致');
  console.log('ok: 泵 mute / digest 捎带 / 仅 digest 不唤醒');
}

// ---------- 5) 泵：底线兜底 ----------
{
  const pol = policy({ rules: [{ id: 'hush', match: {}, action: 'mute' }] });
  const s = { id: 'w1', name: 'W1', workspaceId: 'ws1', orchestrated: true };
  const { pump } = makePump(makeCtx({ sessions: [s] }), pol);
  pump.onFlip({ sessionId: 'w1', workspaceId: 'ws1', sessionName: 'W1', trigger: 'needs_you', ts: 1_000 });
  pump.enqueue({ kind: 'turn_error', workspaceId: 'ws1', sessionId: 'w1', detail: '网络中断' });
  pump.enqueue({ kind: 'heartbeat_stale', workspaceId: 'ws1', sessionId: 'w1', detail: '15 分钟无活动' });
  const kinds = pump.peek('ws1').map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['phase', 'turn_error'], '全静音规则下底线事件仍入队，非底线（心跳）被静音');
  console.log('ok: 泵底线兜底（needs_you / turn_error 静音无效）');
}

// ---------- 7) 泵：守卫阈值与合并窗口随策略 ----------
{
  const s = {
    id: 'w1',
    name: 'W1',
    workspaceId: 'ws1',
    type: 'terminal',
    launchKind: 'agent',
    lifecycle: 'working',
    orchestrated: true
  };
  let now = 1_000;
  const pol = policy({ guards: { heartbeatMs: 5 * 60_000 }, timing: { mergeWindowMs: 8_000, maxWaitMs: 20_000 } });
  const { pump, timers } = makePump(makeCtx({ sessions: [s] }), pol, { now: () => now });
  pump.onTurnEnd('w1');
  now = 1_000 + 6 * 60_000;
  pump.tickGuards();
  assert.equal(pump.peek('ws1').filter((e) => e.kind === 'heartbeat_stale').length, 1, '心跳阈值取策略的 5 分钟（默认 15 分钟时不会报）');
  assert.equal(timers.at(-1), 8_000, '合并窗口取策略的 8s');
  console.log('ok: 泵守卫阈值与合并窗口随策略');
}

// ---------- 10) 存储：原子写 + 变更历史 + 外部修改缓存失效 ----------
{
  const wsRoot = fs.mkdtempSync(path.join(tmp, 'store-'));
  const store = new SubscriptionPolicyStore();
  assert.deepEqual(store.get(wsRoot).rules, [], '无文件=空策略');
  const p = policy({ rules: [{ id: 'a', match: { kind: 'slot_free' }, action: 'digest' }] });
  store.write(wsRoot, p, { by: 'scheduler', reason: '补位不急', now: 5_000 });
  const onDisk = JSON.parse(fs.readFileSync(store.filePath(wsRoot), 'utf8'));
  assert.equal(onDisk.reason, '补位不急');
  assert.equal(onDisk.rules[0].id, 'a');
  assert.equal(store.get(wsRoot).rules.length, 1);
  const hist = fs.readFileSync(store.historyPath(wsRoot), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(hist.length, 1);
  assert.deepEqual(hist[0].previous.rules, [], '历史记下改前全文');
  assert.equal(hist[0].next.rules[0].id, 'a');

  fs.writeFileSync(store.filePath(wsRoot), JSON.stringify({ rules: [{ id: 'b', match: { kind: 'commit' }, action: 'wake' }, { id: 'c', match: {}, action: 'wake' }] }));
  assert.deepEqual(store.get(wsRoot).rules.map((r) => r.id), ['b', 'c'], '人直接改文件后读到新内容');

  store.noteHit(wsRoot, 'b', 'wake', 9_000);
  store.noteHit(wsRoot, 'b', 'wake', 9_500);
  assert.deepEqual(store.getStats(wsRoot).b, { hits: 2, lastAt: 9_500, byAction: { wake: 2 } });
  console.log('ok: 存储原子写 + 变更历史 + 外部修改生效 + 命中计数');
}

// ---------- 11) 工具：身份门 / reason 必填 / 拒写坏输入 / 写入并通知 ----------
{
  const wsRoot = fs.mkdtempSync(path.join(tmp, 'tool-'));
  const source = fs.mkdtempSync(path.join(tmp, 'tool-source-'));
  const pushed = [];
  const ctx = {
    config: { get: () => ({ workspaces: [{ id: 'wsT', path: source, controlRoot: wsRoot, roots: [{ id: 'a', path: wsRoot }, { id: 'b', path: source }], defaultRootId: 'b' }], activeWorkspaceId: 'wsT', workspace: source }) },
    notify: { push: (x) => pushed.push(x) }
  };
  const set = subscriptionPolicyHost['scheduler.policy.set'];
  const get = subscriptionPolicyHost['scheduler.policy.get'];
  const rules = [{ id: 'quiet', match: { kind: 'slot_free' }, action: 'digest' }];
  assert.throws(() => set(ctx, { rules, reason: 'x' }), /仅调度/, 'Worker/UI 直调被拒');
  await assert.rejects(runAsSchedulerTool(async () => set(ctx, { rules })), /reason/, 'reason 必填');
  await assert.rejects(
    runAsSchedulerTool(async () => set(ctx, { rules: [{ match: { kidn: 'slot_free' }, action: 'mute' }], reason: 'x' })),
    /策略未写入/,
    '拼错字段拒写（不做半截生效）'
  );
  const file = path.join(wsRoot, ...SUBSCRIPTION_POLICY_FILE.split('/'));
  assert.equal(fs.existsSync(file), false, '拒写时不落盘');

  const r = await runAsSchedulerTool(async () => set(ctx, { rules, timing: { mergeWindowMs: 10_000 }, reason: '补位不急' }));
  assert.equal(r.ok, true);
  assert.equal(r.effective.timing.mergeWindowMs, 10_000);
  assert.ok(fs.existsSync(file), '写入策略文件');
  assert.equal(pushed.length, 1, '改策略进通知历史');
  assert.equal(pushed[0].toast, false, '不弹桌面 toast');
  assert.match(pushed[0].text, /补位不急/);

  assert.ok(!fs.existsSync(path.join(source, '.muster')), '订阅策略不写默认源码根');
  await assert.rejects(runAsSchedulerTool(async () => get(ctx, { workspaceId: 'missing' })), /workspace/);
  const floorNote = await runAsSchedulerTool(async () =>
    set(ctx, { rules: [{ id: 'hush', match: {}, action: 'mute' }], reason: '试试全静音' })
  );
  assert.ok(floorNote.notices?.length, '可能命中底线的规则照写但附提示');

  const view = await runAsSchedulerTool(async () => get(ctx, {}));
  assert.equal(view.userRules[0].id, 'hush');
  assert.equal(view.reason, '试试全静音');
  console.log('ok: 工具身份门 / reason 必填 / 坏输入拒写 / 写入并留痕');
}

// ---------- 12) F-01：读失败（stat 成功、readFileSync 抛）不写缓存，下次重读 ----------
{
  const wsRoot = fs.mkdtempSync(path.join(tmp, 'f01-'));
  const file = new SubscriptionPolicyStore().filePath(wsRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(file); // 目录占位：statSync 成功、readFileSync 抛 EISDIR（Windows/POSIX 皆可复现）
  const store = new SubscriptionPolicyStore();
  let warns = 0; const origWarn = console.warn; console.warn = () => { warns++; };
  let first;
  try { first = store.load(wsRoot); } finally { console.warn = origWarn; }
  assert.ok(first.warnings.some((w) => w.includes('读取失败')), '读失败按空策略并给告警');
  assert.equal(warns, 1, '首读告警一次');
  // 同 mtime/size 二次读：若坏结果被缓存则不再重读（0 次告警）；修复后必须重读（1 次）
  let warns2 = 0; console.warn = () => { warns2++; };
  let second;
  try { second = store.load(wsRoot); } finally { console.warn = origWarn; }
  assert.ok(second.warnings.some((w) => w.includes('读取失败')), '二次读仍按空策略');
  assert.equal(warns2, 1, '读失败不得写缓存：同指纹二次 load 必须重读并再次告警');
  // 坏档修复后（mtime 变化）能读回真实用户规则
  fs.rmSync(file, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ rules: [{ id: 'u1', match: { kind: 'slot_free' }, action: 'digest' }] }));
  const third = store.load(wsRoot);
  assert.deepEqual(third.warnings, [], '修复后正常解析');
  assert.ok(third.policy.rules.some((r) => r.id === 'u1'), '修复后用户规则生效');
  console.log('ok: 读失败不缓存，下次重读（F-01）');
}

console.log('subscription-policy: all ok');
