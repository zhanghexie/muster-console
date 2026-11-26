/**
 * 网关 WS 协议纯函数测试：心跳帧解析 / hello+filter caps 过滤 / 可靠 outbox 语义 /
 * token 来源 / last-good 候选地址 / 半开判定。
 * Run: node test/ws-protocol.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-protocol-'));
const compile = createSharedCompiler(root, tmp);
const proto = await import(pathToFileURL(compile('shared/wsProtocol.ts')).href);

const {
  HEARTBEAT_TIMEOUT_MS,
  TOKEN_REJECT_COOLDOWN_MS,
  RELIABLE_FLUSH_ATTEMPTS_MAX,
  encodeHello,
  encodePing,
  encodePong,
  encodeFilter,
  parseClientControl,
  parseClientFrame,
  normalizeCaps,
  capsDropList,
  shouldDropChannel,
  mergeDropList,
  isReliableSend,
  sendReliability,
  outboxEnqueue,
  outboxOnDisconnect,
  outboxFlush,
  extractCookieToken,
  resolveWebToken,
  shouldAdoptUrlToken,
  createCandidateState,
  pickConnectBase,
  onConnectSuccess,
  onConnectFailure,
  isHalfOpen,
  defaultWebCaps
} = proto;

let passed = 0;
const ok = (cond, label) => {
  assert.ok(cond, label);
  passed++;
};

/* ── 控制帧编解码 ── */
ok(parseClientControl(JSON.parse(encodePing())).kind === 'ping', 'ping 帧往返');
ok(parseClientControl(JSON.parse(encodePong())).kind === 'pong', 'pong 帧往返');
const hello = parseClientControl(JSON.parse(encodeHello({ terminal: false, stream: true })));
ok(hello?.kind === 'hello' && hello.caps.terminal === false && hello.caps.stream === true, 'hello caps 往返');
const filt = parseClientControl(JSON.parse(encodeFilter(['pty:data', '', 'agent:token'])));
ok(filt?.kind === 'filter' && filt.drop.join(',') === 'pty:data,agent:token', 'filter drop 归一（空串剔除）');
ok(parseClientControl({ t: 'invoke', id: 1 }) === null, '业务帧不是控制帧');
ok(parseClientControl(null) === null, 'null 非控制帧');
ok(parseClientControl('ping') === null, '裸串非控制帧');
ok(parseClientControl({ t: 'hello', caps: { terminal: 'no', stream: 1 } }).caps, '畸形 caps 归一为 {}');
assert.deepEqual(normalizeCaps({ terminal: true, extra: 1 }), { terminal: true }, 'caps 多余字段不透传');
passed++;

/* ── caps → 丢弃列表 / 广播过滤 ── */
assert.deepEqual(capsDropList({ terminal: true, stream: true }), [], '全量兴趣不丢');
passed++;
assert.deepEqual(capsDropList({}), [], '缺省 caps 视为全量');
passed++;
assert.deepEqual(defaultWebCaps({ mobile: false }), { terminal: true, stream: true }, '桌面 web 全量');
passed++;
assert.deepEqual(defaultWebCaps({ mobile: true }), { terminal: false, stream: false }, '手机丢终端+流式');
passed++;
const mobileDrop = capsDropList(defaultWebCaps({ mobile: true }));
ok(mobileDrop.includes('pty:data'), '手机 drop 含 pty:data');
ok(mobileDrop.includes('agent:token') && mobileDrop.includes('agent:thinking'), '手机 drop 含流式热区');
ok(!mobileDrop.includes('agent:message') && !mobileDrop.includes('agent:history'), '手机保留 message/history 对账');

ok(shouldDropChannel(null, 'pty:data') === false, '未声明 caps 不丢（向后兼容）');
ok(shouldDropChannel(undefined, 'agent:token') === false, 'undefined drop 不丢');
ok(shouldDropChannel([], 'pty:data') === false, '空 drop 不丢');
ok(shouldDropChannel(mobileDrop, 'pty:data') === true, '命中 drop 丢弃');
ok(shouldDropChannel(mobileDrop, 'agent:message') === false, '未命中不丢');
assert.deepEqual(mergeDropList(['a'], null), ['a'], '无 filter 用 caps');
passed++;
assert.deepEqual(mergeDropList(['a'], ['b']), ['b'], '显式 filter 整表覆盖');
passed++;

/* ── send 可靠性 ── */
ok(isReliableSend('ui:confirm:abc') && sendReliability('ui:confirm:abc') === 'reliable', 'ui:confirm: 可靠');
ok(isReliableSend('ui:dialog:xyz') && isReliableSend('terminal:capture:1'), 'ui:dialog:/terminal:capture: 可靠');
ok(!isReliableSend('pty:input') && sendReliability('pty:input') === 'unreliable', 'pty:input 不可靠');
ok(!isReliableSend('sessions:touch-used'), 'sessions:touch-used 不可靠');

/* ── outbox：可靠保留 / 不可靠丢弃 / flush 部分失败 ── */
const rel = { text: '{"t":"send"}', reliable: true, channel: 'ui:confirm:r1' };
const unr = { text: '{"t":"send"}', reliable: false, channel: 'pty:input' };
let box = outboxEnqueue([], rel);
box = outboxEnqueue(box, unr);
ok(box.length === 2, 'enqueue 保留两条');
const kept = outboxOnDisconnect(box);
ok(kept.length === 1 && kept[0].reliable, '断线只留可靠帧');
ok(kept[0].channel === 'ui:confirm:r1', '保留的是审批回执');

// 容量满优先丢不可靠
let full = [];
for (let i = 0; i < 5; i++) full = outboxEnqueue(full, { text: `u${i}`, reliable: false, channel: 'pty:input' }, 3);
ok(full.length === 3 && full[0].text === 'u2', '容量满丢最旧不可靠');

// flush 全成功
const sent = [];
const flushOk = outboxFlush(outboxEnqueue([], rel), (t) => sent.push(t));
ok(sent.length === 1 && flushOk.remaining.length === 0 && flushOk.giveUp.length === 0, 'flush 全成功消费掉');

// flush 中途抛错：剩余保留（含当前失败项）
const items = [
  { text: '1', reliable: true, channel: 'ui:confirm:a', attempts: 0 },
  { text: '2', reliable: true, channel: 'ui:confirm:b', attempts: 0 },
  { text: '3', reliable: false, channel: 'pty:input', attempts: 0 }
];
const sent2 = [];
const flushFail = outboxFlush(items, (t) => {
  if (t === '2') throw new Error('boom');
  sent2.push(t);
});
ok(sent2.join(',') === '1', '中途失败前的已发出');
ok(flushFail.remaining.map((x) => x.text).join(',') === '2,3', '失败帧及之后保留在 outbox');
ok(flushFail.remaining[0].attempts === 1, '失败帧 attempts+1');
ok(flushFail.giveUp.length === 0, '首败不放弃');

// 可靠帧累计超限 → giveUp
const almost = [{ text: 'x', reliable: true, channel: 'ui:confirm:z', attempts: RELIABLE_FLUSH_ATTEMPTS_MAX - 1 }];
const flushGive = outboxFlush(almost, () => {
  throw new Error('still dead');
});
ok(flushGive.giveUp.length === 1 && flushGive.remaining.length === 0, '可靠帧超限放弃并给用户错误');

// 不可靠失败不 giveUp（可丢）
const unrFail = outboxFlush([{ text: 'p', reliable: false, channel: 'pty:input', attempts: 99 }], () => {
  throw new Error('x');
});
ok(unrFail.giveUp.length === 0 && unrFail.remaining.length === 1, '不可靠帧失败不 giveUp');

/* ── token：query > Cookie > 空；不读 localStorage ── */
assert.equal(resolveWebToken('?token=abc', ''), 'abc', 'query 优先');
passed++;
assert.equal(resolveWebToken('', 'ma_web_token=cook'), 'cook', 'Cookie 次之');
passed++;
assert.equal(resolveWebToken('?token=abc', 'ma_web_token=cook'), 'abc', 'query 压过 Cookie');
passed++;
assert.equal(resolveWebToken('', ''), '', '都无则空');
passed++;
assert.equal(extractCookieToken('a=1; ma_web_token=zzz; b=2'), 'zzz', 'Cookie 解析');
passed++;
assert.equal(extractCookieToken('ma_web_token='), '', '空 Cookie 值');
passed++;
ok(shouldAdoptUrlToken('old', '?token=new') === true, 'URL 新 token 应立即采用');
ok(shouldAdoptUrlToken('old', '?token=old') === false, '同 token 不切换');
ok(shouldAdoptUrlToken('old', '') === false, '无 query 不切换');
ok(TOKEN_REJECT_COOLDOWN_MS <= 10_000, '4001 冷却应约 5s（不再是 60s）');

/* ── 候选地址：last-good 优先 + 覆盖地址不粘死 ── */
const defaults = ['ws://a/ws', 'ws://b/ws'];
let cs = createCandidateState({ override: 'ws://sticky/ws', defaults });
ok(cs.overrideOnly && pickConnectBase(cs) === 'ws://sticky/ws', '覆盖地址初始试它');
cs = onConnectSuccess(cs, 'ws://sticky/ws');
ok(cs.lastGood === 'ws://sticky/ws' && pickConnectBase(cs) === 'ws://sticky/ws', '成功后 last-good 优先');

// last-good 失败 → 轮换其它（含 defaults），不再只盯 sticky
cs = onConnectFailure(cs, defaults);
ok(cs.preferLastGood === false, 'last-good 失败后不再偏好');
ok(pickConnectBase(cs) !== 'ws://sticky/ws' || cs.candidates.length > 1, '失败后可轮到其它候选');
ok(cs.candidates.includes('ws://a/ws') && cs.candidates.includes('ws://b/ws'), '回退并入 defaultCandidates');

// 从未成功 + 唯一覆盖地址失败 → defaults 优先、旧 IP 到队尾
let sticky = createCandidateState({ override: 'ws://old-ip/ws', defaults });
sticky = onConnectFailure(sticky, defaults);
ok(sticky.overrideOnly === false, '覆盖地址失败后不再 overrideOnly');
ok(pickConnectBase(sticky) === 'ws://a/ws', '下一家先试 default（不粘旧 IP）');
ok(sticky.candidates[sticky.candidates.length - 1] === 'ws://old-ip/ws', '旧覆盖地址放轮换末尾');

// 多候选环形轮换
let multi = createCandidateState({ override: null, defaults });
ok(pickConnectBase(multi) === 'ws://a/ws', '默认从第一家起');
multi = onConnectFailure(multi, defaults);
ok(pickConnectBase(multi) === 'ws://b/ws', '失败轮换下一家');
multi = onConnectFailure(multi, defaults);
ok(pickConnectBase(multi) === 'ws://a/ws', '环形回到第一家');
multi = onConnectSuccess(multi, 'ws://b/ws');
ok(pickConnectBase(multi) === 'ws://b/ws', '成功地址成为 last-good');

/* ── 半开判定 ── */
ok(isHalfOpen(0, Date.now()) === true, '从未收帧视为半开');
ok(isHalfOpen(1000, 1000 + HEARTBEAT_TIMEOUT_MS - 1) === false, '窗口内不半开');
ok(isHalfOpen(1000, 1000 + HEARTBEAT_TIMEOUT_MS + 1) === true, '超 2 周期半开');

/* ── 全帧解码 parseClientFrame（R1，审计 2026-10-02）：合法 JSON 不一定是协议对象 ── */
ok(parseClientFrame(null) === null, 'null 不是协议帧');
ok(parseClientFrame([1, 2]) === null, '数组不是协议帧');
ok(parseClientFrame(42) === null, '数字不是协议帧');
ok(parseClientFrame('hello') === null, '裸串不是协议帧');
ok(parseClientFrame(true) === null, '布尔不是协议帧');
ok(parseClientFrame({ t: 'unknown' }) === null, '未知 t 静默丢弃');
ok(parseClientFrame({ t: 'invoke' }) === null, 'invoke 缺 id 丢弃');
ok(parseClientFrame({ t: 'invoke', id: 'x', channel: 'a:b' }) === null, 'invoke id 非数字丢弃');
ok(parseClientFrame({ t: 'invoke', id: NaN, channel: 'a:b' }) === null, 'invoke id NaN 丢弃');
ok(parseClientFrame({ t: 'invoke', id: 1, channel: 7 }) === null, 'invoke channel 非字符串丢弃');
ok(parseClientFrame({ t: 'send', channel: 7 }) === null, 'send channel 非字符串丢弃');
{
  const inv = parseClientFrame({ t: 'invoke', id: 3, channel: 'app:version', args: [] });
  assert.equal(inv.kind, 'invoke');
  assert.equal(inv.id, 3);
  assert.equal(inv.channel, 'app:version');
  ok(!!inv, '合法 invoke 帧解码出类型化分支');
  const snd = parseClientFrame({ t: 'send', channel: 'pty:input', args: 'not-array' });
  assert.equal(snd.kind, 'send');
  assert.deepEqual(snd.args, [], 'send args 非数组归一 []');
  const snd2 = parseClientFrame({ t: 'send', channel: 'pty:input', args: ['k'] });
  assert.deepEqual(snd2.args, ['k']);
  ok(true, '合法 send 帧解码 + args 归一');
  const ping = parseClientFrame(JSON.parse(encodePing()));
  assert.equal(ping.kind, 'ping');
  const hello = parseClientFrame(JSON.parse(encodeHello({ terminal: false })));
  assert.equal(hello.kind, 'hello');
  assert.equal(hello.caps.terminal, false);
  ok(true, '控制帧（ping/hello）在同一解码入口可用');
}

console.log(`ws-protocol: ${passed} 项断言全部通过`);
