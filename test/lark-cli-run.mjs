/**
 * R3 回归（审计 2026-10-02）：runCli 的 stdin/child/timer 失败统一收尾。
 * 真实加载 src/main/feishu/larkCli.ts（Electron 与 spawn 为 stub 边界），覆盖：
 * 异步 EPIPE、同步 write 抛错、spawn 失败、error/close 乱序、timeout——
 * 一次 settle、及时失败、计时器与 child 正确清理、日志不含输入 secret。
 * 还原修复即红：去掉 stdin error 监听或同步 write 的 try/catch，对应用例失败。
 * Run: node test/lark-cli-run.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const Module = require('node:module');
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: filename
    }).outputText,
    filename
  );

// fixture 里种一个可被 resolveCliExe 找到的假 lark-cli（spawn 被 stub，不会真跑）
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-cli-run-'));
const fakeBinDir = path.join(fixture, 'node_modules', '@larksuite', 'cli', 'bin');
fs.mkdirSync(fakeBinDir, { recursive: true });
fs.writeFileSync(path.join(path.dirname(fakeBinDir), 'package.json'), JSON.stringify({ name: '@larksuite/cli', version: '0' }));
fs.writeFileSync(path.join(fakeBinDir, process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli'), '');

const fakeElectron = { app: { getPath: () => fixture, getAppPath: () => fixture } };

/** 逐用例注入的 fake spawn 结果 */
let spawnImpl = null;
const spawnCalls = [];
const realChildProcess = require('node:child_process');
const overrides = new Map([
  ['electron', fakeElectron],
  [
    'node:child_process',
    {
      ...realChildProcess,
      spawn: (...args) => {
        spawnCalls.push(args);
        return spawnImpl(...args);
      }
    }
  ]
]);
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename && path.resolve(path.dirname(parent.filename), request) === path.join(root, 'src/main/agentSession/process/controlledChild')) {
    return { createControlledChild: (...args) => {
      spawnCalls.push(args); const child = spawnImpl(...args);
      const closed = new Promise(resolve => child.once('close', resolve));
      return { child, started: true, ready: Promise.resolve(), reclaim: async () => { child.kill(); await closed; } };
    } };
  }
  if (overrides.has(request)) return overrides.get(request);
  return originalLoad.apply(this, arguments);
};
const cli = require(path.join(root, 'src/main/feishu/larkCli.ts'));
Module._load = originalLoad;

// 全局异常侦测：任何逃逸（修复前的 R3 形态）立即失败退出，不被顶层 await 静默吞掉
const uncaught = [];
process.on('uncaughtException', (e) => {
  uncaught.push(e);
  console.error('检测到逃逸 uncaughtException:', e && (e.stack || e));
  process.exit(1);
});
const rejections = [];
process.on('unhandledRejection', (r) => {
  rejections.push(String(r));
  console.error('检测到逃逸 unhandledRejection:', r);
  process.exit(1);
});

const SECRET = 'synthetic-secret-do-not-leak';
const PHONE_PROFILE = 'muster-phone-fixture';

/** 最小 fake child：EventEmitter + 三个流（含 write/end）+ kill */
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), {
      destroyed: false,
      write() {
        return true;
      },
      end() {},
      destroy() {
        this.destroyed = true;
      }
    }),
    stdout: Object.assign(new EventEmitter(), { setEncoding() {} }),
    stderr: Object.assign(new EventEmitter(), { setEncoding() {} }),
    killed: false,
    kill() {
      this.killed = true;
    }
  });
  return child;
}

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ✓ ${name}`);
};
const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));
/** 进程内悬挂 Timeout 计数（finish 后 timer 未清会留下） */
const timeoutHandles = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

// ── 异步 EPIPE：写入后 CLI 关闭管道 → 立即失败，不等 close/timeout ──
{
  const child = fakeChild();
  spawnImpl = () => child;
  const p = cli.runCli(['config', 'init'], { input: `${SECRET}\n`, timeoutMs: 5_000, profile: PHONE_PROFILE });
  let settled = false;
  p.then(() => {
    settled = true;
  });
  await settle(5);
  let syncThrow = null;
  try {
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  } catch (e) {
    syncThrow = e; // 还原形态（无 stdin 监听）时 EventEmitter 会在 emit 处同步 throw
  }
  assert.equal(syncThrow, null, 'stdin error 必须被 runCli 挂的监听接住，而不是从 emit 处同步抛出');
  await settle(10);
  assert.ok(settled, 'EPIPE 后及时 settle（不等 close/timeout）');
  assert.equal(child.killed, true, 'stdin 失败时终止存活的 child（不残留进程）');
  assert.ok(child.stdin.destroyed, 'stdin 流被释放');
  const res = await p;
  assert.equal(res.code, -1);
  assert.ok(res.stderr.includes('stdin'), `stderr 说明 stdin 失败：${res.stderr}`);
  assert.ok(!res.stderr.includes(SECRET) && !res.stdout.includes(SECRET), '结果不含输入 secret');
  assert.equal(uncaught.length, 0, '无 EventEmitter 异常逃逸（修复前 listener=0 会 throw）');
  // close 迟到：幂等，不改结果
  child.emit('close', 0);
  const res2 = await p;
  assert.equal(res2.code, -1, '迟到 close 不改写结果（一次 settle）');
  ok('异步 EPIPE：立即失败收口（code -1、stderr 含 stdin:、无 uncaught、迟到 close 幂等）');
}

// ── 同步 write 抛错（写已销毁流）→ 失败收尾 ──
{
  const child = fakeChild();
  spawnImpl = () => child;
  child.stdin.write = () => {
    throw new Error('write after destroyed');
  };
  const res = await cli.runCli(['probe'], { input: SECRET, timeoutMs: 5_000, profile: PHONE_PROFILE });
  assert.equal(res.code, -1);
  assert.ok(res.stderr.includes('stdin write'));
  assert.ok(!res.stderr.includes(SECRET));
  assert.equal(uncaught.length, 0);
  ok('同步 write 异常：收口为失败（code -1），secret 不进日志');
}

// ── spawn 失败：error(ENOENT) 先于 close ──
{
  const child = fakeChild();
  spawnImpl = () => child;
  const p = cli.runCli(['probe'], { timeoutMs: 5_000, profile: PHONE_PROFILE });
  child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  child.emit('close', -1);
  const res = await p;
  assert.equal(res.code, -1);
  assert.ok(res.stderr.includes('ENOENT'));
  assert.equal(uncaught.length, 0);
  ok('spawn 失败（error→close 顺序）：一次失败收尾');
}

// ── close 先、error 后（乱序）──
{
  const child = fakeChild();
  spawnImpl = () => child;
  const p = cli.runCli(['probe'], { input: SECRET, timeoutMs: 5_000, profile: PHONE_PROFILE });
  child.stdout.emit('data', '{"ok":true}');
  child.emit('close', 0);
  child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })); // close 后迟到的流错误
  const res = await p;
  assert.equal(res.code, 0, '正常 close 的结果不被迟到的 stdin error 改写');
  assert.equal(res.stdout, '{"ok":true}');
  assert.equal(uncaught.length, 0, 'close 后的迟到 stdin error 也被监听接住');
  ok('close→error 乱序：结果取首个事件（code 0），迟到流错误无 uncaught');
}

// ── timeout：kill 被调、timer 清理 ──
{
  const child = fakeChild();
  spawnImpl = () => child;
  const before = timeoutHandles();
  const p = cli.runCli(['probe'], { timeoutMs: 60, profile: PHONE_PROFILE });
  const res = await p;
  assert.equal(res.code, -2);
  assert.equal(child.killed, true, '超时 kill 自己创建的 child');
  await settle(5);
  assert.ok(timeoutHandles() <= before, 'finish 后 timeout 计时器已清理');
  child.emit('close', null); // kill 后 close 迟到：幂等
  ok('timeout：code -2、kill 自有 child、计时器清理、迟到 close 幂等');
}

// ── 正常路径行为保持：stdin end + 输出聚合 ──
{
  const child = fakeChild();
  spawnImpl = () => child;
  const writes = [];
  child.stdin.write = (d) => {
    writes.push(d);
    return true;
  };
  child.stdin.end = () => {
    child.stdin.emit('close');
  };
  const p = cli.runCli(['config', 'init'], { input: `${SECRET}\n`, timeoutMs: 5_000, profile: PHONE_PROFILE });
  child.stdout.emit('data', '{"ok":true,"data":{"x":1}}');
  child.emit('close', 0);
  const res = await p;
  assert.equal(res.code, 0);
  assert.deepEqual(writes, [`${SECRET}\n`], '凭证仍走 stdin（不改命令行参数）');
  assert.equal(JSON.parse(res.stdout).ok, true);
  assert.equal(child.killed, true, 'finish 统一入口对已退出 child 的 kill 是幂等 no-op，不阻碍正常路径');
  const spawnArgs = spawnCalls.at(-1);
  assert.ok(!spawnArgs[1].some((a) => String(a).includes(SECRET)), '命令行参数不含 secret');
  ok('正常路径保持：凭证走 stdin、输出聚合、命令行无 secret');
}

// The phone's dedicated profile reaches the actual subprocess for both auth and ordinary calls.
for (const profile of [PHONE_PROFILE, 'muster-phone-other']) {
  const child = fakeChild(); spawnImpl = () => child;
  const running = cli.runCli(['whoami', '--json'], { profile, timeoutMs: 1000 });
  assert.deepEqual(spawnCalls.at(-1)[1].slice(0, 2), ['--profile', profile]);
  assert.equal(spawnCalls.at(-1)[2].windowsHide, true);
  child.emit('close', 0); await running;
  const nextChild = fakeChild(); spawnImpl = () => nextChild;
  const onboarding = cli.startConfigInitNew(() => {}, profile);
  const args = spawnCalls.at(-1)[1];
  assert.deepEqual(args.slice(0, 2), ['--profile', profile]);
  assert.equal(args[args.indexOf('--name') + 1], profile, 'new credentials must be stored in the same dedicated profile');
  assert.ok(args.includes('--new'));
  nextChild.emit('close', 0); assert.equal((await onboarding.promise).ok, true);
}
ok('两个手机连接分别明确传入自己的 profile');

for (const profile of [PHONE_PROFILE, 'muster-phone-other']) {
  const child = fakeChild(); spawnImpl = () => child;
  const stream = cli.startEventConsume('im.message.receive_v1', () => {}, () => {}, undefined, true, profile);
  assert.deepEqual(spawnCalls.at(-1)[1].slice(0, 2), ['--profile', profile]);
  assert.deepEqual(spawnCalls.at(-1)[1].slice(-2), ['--as', 'bot']);
  spawnImpl = () => { const stopped = fakeChild(); queueMicrotask(() => stopped.emit('close', 0)); return stopped; };
  stream.stop();
  assert.deepEqual(spawnCalls.at(-1)[1], ['--profile', profile, 'event', 'stop'], 'stopping the phone must never stop the scheduler daemon');
}
ok('手机收信和停止事件流均限定自有 profile');

{
  const before = spawnCalls.length;
  for (const profile of [undefined, '', '  ', '-other', 'broken\0profile']) {
    const cliResult = await cli.runCli(['auth', 'status', '--json'], { profile });
    assert.equal(cliResult.code, -1);
    assert.match(cli.cliErrorDetail(cliResult), /Channels.*重新接入/);
    const onboarding = cli.startConfigInitNew(() => assert.fail('unexpected onboarding URL'), profile);
    assert.match((await onboarding.promise).error, /Channels.*重新接入/);
    await onboarding.stopAndWait();
    const exits = [];
    const stream = cli.startEventConsume('im.message.receive_v1', () => assert.fail('unexpected line'), (...args) => exits.push(args),
      undefined, true, profile, true);
    await stream.stopAndWait();
    assert.deepEqual(exits.map(([code]) => code), [-1]);
    assert.match(exits[0][1], /Channels.*重新接入/);
  }
  assert.equal(spawnCalls.length, before, 'invalid profiles never start a subprocess');
  ok('接入、鉴权命令与监听缺少有效 profile 时拒绝启动');
}

{
  const png = Buffer.from('fixture-qr');
  const content = 'https://example.test/authorize';
  spawnImpl = (_exe, argv, options) => {
    assert.deepEqual(argv.slice(0, 3), ['auth', 'qrcode', content]);
    assert.equal(argv.includes('--profile'), false);
    fs.writeFileSync(path.join(options.cwd, argv[argv.indexOf('-o') + 1]), png);
    const child = fakeChild();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  assert.equal(await cli.makeQrDataUrl(content), `data:image/png;base64,${png.toString('base64')}`);
  ok('纯二维码生成不绑定连接 profile');
}

{
  const child = fakeChild(); spawnImpl = () => child;
  const diagnostics = [], exits = [];
  cli.startEventConsume('im.message.receive_v1', () => {}, (code, error) => exits.push({ code, error }), line => diagnostics.push(line), true, 'muster-phone-fixture');
  child.stderr.emit('data', '[event] rea');
  assert.deepEqual(diagnostics, [], 'a partial readiness marker is not a complete diagnostic');
  child.stderr.emit('data', 'dy event_key=im.message.receive_v1\r\n[source] connected\nlast diagnostic');
  assert.deepEqual(diagnostics, ['[event] ready event_key=im.message.receive_v1', '[source] connected']);
  child.emit('close', 3);
  assert.equal(diagnostics.at(-1), 'last diagnostic'); assert.equal(exits.length, 1);
  ok('跨 stderr 数据块的 ready 行完整传递，退出时补齐末行');
}

// agent-apps F-03：close 尾冲必须按 \n 拆行逐行回调——ready 标记前混排其他行时
// 行级语义（onReady 的 startsWith('[event] ready ')）不被整块尾冲吞掉。
// 时序构造：drain 中途抛错把 stderrBuf 冻结成「多行无尾换行」残余（模拟 close
// 先于按行 drain 到达的流竞态）；还原修复（close 整块回调）时第二个断言转红。
{
  const child = fakeChild(); spawnImpl = () => child;
  const diagnostics = [];
  let throwOnce = true;
  cli.startEventConsume('im.message.receive_v1', () => {}, () => {}, line => {
    if (throwOnce) { throwOnce = false; throw new Error('drain interrupted'); }
    diagnostics.push(line);
  }, true, 'muster-phone-fixture');
  try {
    child.stderr.emit('data', 'noise\n[src] connected\n[event] ready event_key=im.message.receive_v1');
  } catch { /* drain 中断：残余多行留在 stderrBuf */ }
  child.emit('close', 0);
  assert.ok(diagnostics.includes('[src] connected'), '残余按行拆分：前置行逐行回调');
  assert.ok(
    diagnostics.includes('[event] ready event_key=im.message.receive_v1'),
    '残余按行拆分：无尾换行的 ready 行独立成行送达（不被整块尾冲吞掉）'
  );
  ok('close 尾冲按 \\n 拆行逐行回调，ready 标记不被吞（agent-apps F-03）');
}

{
  const streamChild = fakeChild(), daemonStop = fakeChild();
  let count = 0;
  spawnImpl = () => ++count === 1 ? streamChild : daemonStop;
  const stream = cli.startEventConsume('im.message.receive_v1', () => {}, () => {}, undefined, true, 'muster-phone-shutdown');
  let stopped = false;
  const stopping = stream.stopAndWait().then(() => { stopped = true; });
  assert.equal(streamChild.stdin.destroyed, true);
  await settle(1); assert.equal(stopped, false, 'stdin cancellation is not process completion');
  streamChild.emit('close', 0);
  await settle(1); assert.equal(stopped, false, 'stream close must also await daemon stop');
  daemonStop.emit('close', 0); await stopping;
  assert.equal(stopped, true);
  ok('event stream shutdown awaits child close and the profile daemon stop');
}

{
  const { claimFeishuConsumer } = require(path.join(root, 'src/main/feishu/consumerArbiter.ts'));
  const appId = 'cli_fixture_shared';
  const sdk = claimFeishuConsumer(appId, 'dsh:fixture');
  let rejected;
  spawnImpl = () => {
    const child = fakeChild();
    queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify({ appId, identities: { bot: { available: true } } }));
      child.emit('close', 0);
    });
    return child;
  };
  const conflict = new Promise(resolve => { rejected = resolve; });
  const attempts = spawnCalls.length;
  const duplicate = cli.startEventConsume('im.message.receive_v1', () => {}, (_, why) => rejected(why), undefined, true, 'phone', true);
  assert.match(await conflict, /同一个飞书应用/);
  assert.equal(spawnCalls.length, attempts + 1, 'conflicting listener only probes the profile');
  assert.deepEqual(spawnCalls.at(-1)[1], ['--profile', 'phone', 'auth', 'status', '--json']);
  await duplicate.stopAndWait();
  sdk();

  const streamChild = fakeChild(), daemonStop = fakeChild();
  const runStatus = spawnImpl;
  let calls = 0;
  spawnImpl = () => ++calls === 1 ? runStatus() : calls === 2 ? streamChild : daemonStop;
  const allowed = cli.startEventConsume('im.message.receive_v1', () => {}, () => {}, undefined, true, PHONE_PROFILE, true);
  await settle(1);
  assert.equal(calls, 2);
  assert.throws(() => claimFeishuConsumer(appId, 'dsh:fixture'), { code: 'feishu-account-in-use' });
  const stopping = allowed.stopAndWait();
  await settle(1);
  streamChild.emit('close', 0);
  assert.throws(() => claimFeishuConsumer(appId, 'dsh:fixture'), { code: 'feishu-account-in-use' });
  daemonStop.emit('close', 0);
  await stopping;
  claimFeishuConsumer(appId, 'dsh:fixture')();
  ok('同一飞书 AppID 的 SDK 与 CLI profile 只能有一个消费者，确认 daemon 停止后可交接');
}
assert.equal(cli.cliErrorDetail({ code: 3, stdout: '', stderr: '[event] connecting...\n' + JSON.stringify({ ok: false, error: { code: 999, message: 'Auth method is not supported.' }, _notice: { update: { message: 'new CLI available' } } }, null, 2) }), 'code 999：Auth method is not supported.');
ok('事件日志前缀和更新提示不能遮住真实鉴权错误');

assert.equal(uncaught.length, 0, '全程零 uncaughtException');
assert.equal(rejections.length, 0, '全程零 unhandledRejection');
console.log(`lark-cli-run: ${passed} 组断言全绿`);
fs.rmSync(fixture, { recursive: true, force: true });
