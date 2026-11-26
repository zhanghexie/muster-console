/**
 * RuntimeHost seed + list
 * 运行: node test/runtime-host.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const compileTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-compile-'));
const compile = createSharedCompiler(root, compileTmp);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ud-'));
const builtinsDir = path.join(root, 'src/main/runtime/builtins');

// 期望: RuntimeHost 可从 builtinsDir seed 到 userData/agent-runtimes
// 树式转译：host 及其依赖（type-only ./types、shared/i18n）自动镜像带上
const hostOut = compile('main/runtime/host.ts');
const { RuntimeHost } = await import(pathToFileURL(hostOut).href);
const host = new RuntimeHost({ userDataDir: userData, builtinsDir });
await host.ensureSeeded();
const list = host.list();
assert.equal(list.find(e => e.id === 'pi')?.label, 'Muster Core', 'new Core seed uses the current product name');
for (const storedLabel of ['Pi', 'MetaAgent Core', 'My Core Label']) {
  const registryFile = path.join(userData, 'agent-runtimes', 'registry.json');
  const stored = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  stored.runtimes.find(e => e.id === 'pi').label = storedLabel;
  fs.writeFileSync(registryFile, JSON.stringify(stored));
  const reopened = new RuntimeHost({ userDataDir: userData, builtinsDir });
  await reopened.ensureSeeded();
  const expected = storedLabel === 'My Core Label' ? storedLabel : 'Muster Core';
  assert.equal(reopened.get('pi')?.label, expected, 'known current-product defaults normalize; custom labels survive reload');
  assert.equal(reopened.list().find(e => e.id === 'pi')?.label, expected);
  assert.equal(JSON.parse(fs.readFileSync(registryFile, 'utf8')).runtimes.find(e => e.id === 'pi').label, expected, 'normalization persists only the current registry');
}
assert.ok(list.some((e) => e.id === 'cursor-cli'));
for (const id of ['cursor-cli', 'claude-code', 'opencode', 'codex', 'gemini']) {
  assert.equal(list.find((e) => e.id === id)?.enabled, true, `${id} must be enabled in a fresh registry`);
}
assert.ok(fs.existsSync(path.join(userData, 'agent-runtimes', 'scripts', 'cursor-cli.mjs')));
for (const id of ['cursor-cli', 'claude-code', 'opencode']) {
  assert.equal(list.find((e) => e.id === id)?.uiHints, undefined, `${id} 种子不再包含旧输入法配置`);
}
// T5.3 新 builtin：codex/gemini 脚本随 seed 拷入，条目 surface=pty
for (const id of ['codex', 'gemini']) {
  const e = list.find((x) => x.id === id);
  assert.ok(e, `seed 应含 ${id}`);
  assert.equal(e.surface ?? 'pty', 'pty');
  assert.ok(
    fs.existsSync(path.join(userData, 'agent-runtimes', 'scripts', `${id}.mjs`)),
    `seed 应拷贝 ${id}.mjs`
  );
}
console.log('ok: seed + list');

// 共享 helper 须随 seed 拷到 userData（脚本 import './_helpers.mjs'）
assert.ok(
  fs.existsSync(path.join(userData, 'agent-runtimes', 'scripts', '_helpers.mjs')),
  'seed 应拷贝 _helpers.mjs'
);
console.log('ok: seed copies _helpers');

// 已有 registry（Task 1 升级路径）：缺 _helpers 时 ensureSeeded 应补拷
const upgradeUd = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ud-upgrade-'));
const upgradeRoot = path.join(upgradeUd, 'agent-runtimes');
const upgradeScripts = path.join(upgradeRoot, 'scripts');
fs.mkdirSync(upgradeScripts, { recursive: true });
const seedReg = JSON.parse(fs.readFileSync(path.join(builtinsDir, 'registry.json'), 'utf8'));
fs.writeFileSync(
  path.join(upgradeRoot, 'registry.json'),
  JSON.stringify({ version: 1, runtimes: seedReg.runtimes }, null, 2)
);
for (const e of seedReg.runtimes) {
  if (e.manifest) continue;
  // chat（GUI）runtime 无脚本，不参与脚本拷贝
  if ((e.surface ?? 'pty') === 'chat' || !e.script) continue;
  fs.copyFileSync(
    path.join(builtinsDir, 'scripts', e.script),
    path.join(upgradeScripts, e.script)
  );
}
assert.ok(
  !fs.existsSync(path.join(upgradeScripts, '_helpers.mjs')),
  '升级场景预设：registry 在但 _helpers 缺失'
);
const upgradeHost = new RuntimeHost({ userDataDir: upgradeUd, builtinsDir });
await upgradeHost.ensureSeeded();
assert.ok(
  fs.existsSync(path.join(upgradeScripts, '_helpers.mjs')),
  'ensureSeeded 应补拷缺失的 _helpers.mjs'
);
console.log('ok: ensureSeeded repairs missing _helpers');

// The new CLI default applies to untouched old seeds, without overriding a
// deliberate user disable or changing an unrelated custom registration.
const defaultsUd = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cli-defaults-'));
const defaultsRoot = path.join(defaultsUd, 'agent-runtimes');
fs.mkdirSync(defaultsRoot, { recursive: true });
const defaultsReg = JSON.parse(JSON.stringify(seedReg));
const untouched = defaultsReg.runtimes.find(e => e.id === 'codex');
untouched.enabled = false;
untouched.updatedAt = 0;
const userDisabled = defaultsReg.runtimes.find(e => e.id === 'claude-code');
userDisabled.enabled = false;
userDisabled.updatedAt = 42;
fs.writeFileSync(path.join(defaultsRoot, 'registry.json'), JSON.stringify(defaultsReg));
const defaultsHost = new RuntimeHost({ userDataDir: defaultsUd, builtinsDir });
await defaultsHost.ensureSeeded();
assert.equal(defaultsHost.get('codex')?.enabled, true, 'untouched old CLI seed adopts enabled default');
assert.equal(defaultsHost.get('claude-code')?.enabled, false, 'explicitly disabled builtin stays disabled');

// 已有 registry：旧输入法配置保留在磁盘但不再迁移；更新时明确拒绝已移除参数。
const hintsUd = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ud-hints-'));
const hintsRoot = path.join(hintsUd, 'agent-runtimes');
const hintsScripts = path.join(hintsRoot, 'scripts');
fs.mkdirSync(hintsScripts, { recursive: true });
const staleReg = JSON.parse(JSON.stringify(seedReg));
const claudeEntry = staleReg.runtimes.find((e) => e.id === 'claude-code');
claudeEntry.uiHints = { imePrompt: '>', imeStatusRows: 2 };
claudeEntry.label = 'My Claude Label';
claudeEntry.extraArgs = ['--custom-flag'];
fs.writeFileSync(
  path.join(hintsRoot, 'registry.json'),
  JSON.stringify({ version: 1, runtimes: staleReg.runtimes }, null, 2)
);
for (const e of staleReg.runtimes) {
  if (e.manifest) continue;
  if ((e.surface ?? 'pty') === 'chat' || !e.script) continue;
  fs.copyFileSync(
    path.join(builtinsDir, 'scripts', e.script),
    path.join(hintsScripts, e.script)
  );
}
const hintsHost = new RuntimeHost({ userDataDir: hintsUd, builtinsDir });
await hintsHost.ensureSeeded();
const migratedClaude = hintsHost.get('claude-code');
assert.deepEqual(migratedClaude?.uiHints, { imePrompt: '>', imeStatusRows: 2 });
assert.equal(migratedClaude?.label, 'My Claude Label', '升级不得覆盖用户 label');
assert.deepEqual(migratedClaude?.extraArgs, ['--custom-flag'], '升级不得覆盖 extraArgs');
await assert.rejects(
  hintsHost.update('claude-code', { uiHints: { imePrompt: '>' } }),
  /uiHints/,
  '旧调用必须收到错误，不得静默返回成功'
);
const hintsRegOnDisk = JSON.parse(
  fs.readFileSync(path.join(hintsRoot, 'registry.json'), 'utf8')
);
const diskClaude = hintsRegOnDisk.runtimes.find((e) => e.id === 'claude-code');
assert.deepEqual(diskClaude.uiHints, { imePrompt: '>', imeStatusRows: 2 }, '保留用户注册文件的旧字段');
console.log('ok: legacy IME hints are not migrated and cannot be updated');

const cwd = process.cwd();
for (const id of ['codex', 'opencode', 'claude-code']) {
  const probe = await host.resolveLaunch(id, 'start', '__probe__', cwd, [], undefined, true);
  assert.equal(probe.env, undefined, 'probe cannot create transport credentials');
  assert.equal(probe.dispose, undefined, 'probe must not own a server or MCP bridge');
}
for (const [id, override] of [
  ['claude-code', ['--continue']], ['cursor-cli', ['--workspace', cwd]],
  ['codex', ['--cd=' + cwd]], ['gemini', ['-r', 'latest']], ['opencode', ['--session=ses_other']]
]) {
  for (const mode of ['resume', 'new']) {
    await assert.rejects(host.resolveLaunch(id, mode, 'saved-id', cwd, override), /remove .* from the runtime arguments/);
  }
}
await assert.rejects(host.resolveLaunch('codex', 'new', 'saved-id', cwd, ['resume', 'old-id']), /remove resume/);

// 真实 claude-code.mjs：无 jsonl 时 canResume 为 false
const claudeHref = pathToFileURL(path.join(builtinsDir, 'scripts', 'claude-code.mjs')).href;
const claude = await import(claudeHref);
assert.equal(typeof claude.canResume, 'function');
const prevHome = process.env.USERPROFILE;
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-claude-home-'));
process.env.USERPROFILE = fakeHome;
try {
  assert.equal(claude.canResume({ cwd, sessionId: 'no-such-session' }), false);
} finally {
  if (prevHome === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevHome;
}
console.log('ok: claude canResume missing jsonl');

// OpenCode may create a session when an ID is absent. A plausible ID alone is insufficient.
const opencodeHref = pathToFileURL(path.join(builtinsDir, 'scripts', 'opencode.mjs')).href;
const opencode = await import(opencodeHref);
for (const sessionId of [undefined, '', 'legacy', 'ses_0123456789abcdef01234567']) {
  assert.equal(await opencode.checkResume({ cwd, sessionId }, () => assert.fail('unbound ID must not contact OpenCode')), 'unbound');
}
const openCodeId = 'ses_01JABC0123456789ABCDEFGH';
const openCodeInput = { cwd, sessionId: openCodeId };
const openCodeLookup = response => async (requestCwd, action) => {
  assert.equal(requestCwd, cwd);
  return action(async (route, options) => {
    assert.equal(route, `/session/${openCodeId}?directory=${encodeURIComponent(cwd)}`);
    assert.equal(options?.method ?? 'GET', 'GET');
    if (response instanceof Error) throw response;
    return response;
  });
};
assert.equal(await opencode.checkResume(openCodeInput, openCodeLookup({ id: openCodeId })), 'attempt');
assert.equal(await opencode.checkResume(openCodeInput, openCodeLookup(Object.assign(new Error('not found'), { httpStatus: 404 }))), 'missing');
await assert.rejects(opencode.checkResume(openCodeInput, openCodeLookup({ id: 'ses_different' })), /requested session identity/);
await assert.rejects(opencode.checkResume(openCodeInput, openCodeLookup(Object.assign(new Error('not authorized'), { httpStatus: 401 }))), /not authorized/);
assert.deepEqual(await host.checkTerminalResume('opencode', cwd, 'ses_0123456789abcdef01234567'), { status: 'unbound' });
console.log('ok: OpenCode checks the exact native session before allowing a resume attempt');

// normalizeRuntimeKey：查 host，未知 id 抛错，不再静默落到 cursor-cli
const registryOut = compile('main/runtime/registry.ts');
const { normalizeRuntimeKey } = await import(pathToFileURL(registryOut).href);
assert.equal(normalizeRuntimeKey('cursor-cli', host), 'cursor-cli');
assert.equal(normalizeRuntimeKey(undefined, host, 'claude-code'), 'claude-code');
assert.throws(() => normalizeRuntimeKey('not-registered', host), /未注册/);
assert.throws(() => normalizeRuntimeKey('not-registered', host, 'cursor-cli'), /未注册/);
assert.throws(() => normalizeRuntimeKey(undefined, host), /未指定/);
assert.throws(() => normalizeRuntimeKey('   ', host, '   '), /未指定/);
console.log('ok: normalizeRuntimeKey looks up host');

// restoreBuiltins 恢复已删 builtin id
const restoreUd = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-restore-'));
const restoreHost = new RuntimeHost({ userDataDir: restoreUd, builtinsDir });
await restoreHost.ensureSeeded();
assert.ok(restoreHost.get('cursor-cli'));
const restoreScripts = path.join(restoreUd, 'agent-runtimes', 'scripts');
restoreHost.remove('cursor-cli');
assert.equal(restoreHost.get('cursor-cli'), undefined);
assert.ok(
  !fs.existsSync(path.join(restoreScripts, 'cursor-cli.mjs')),
  'remove 后 builtin 脚本应不存在'
);
const restoredOne = restoreHost.restoreBuiltins(['cursor-cli']);
assert.equal(restoredOne.length, 1);
assert.equal(restoredOne[0].id, 'cursor-cli');
assert.ok(restoreHost.get('cursor-cli'));
assert.ok(fs.existsSync(path.join(restoreScripts, 'cursor-cli.mjs')));
console.log('ok: restoreBuiltins restores removed builtin');

// P1-5：remove builtin 后「重启」（同 userDataDir 新实例跑 ensureSeeded →
// migrateBuiltinHints 按种子补回条目），脚本文件也必须一并恢复——补回条目的版本与
// 种子相等，seedVer > curVer 的复制分支走不到，旧实现留下「有条目无脚本」→ 预检
// 永远 script_missing，与「builtin 会被补回」的自愈语义矛盾
{
  const p15Ud = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-p15-'));
  const p15Host = new RuntimeHost({ userDataDir: p15Ud, builtinsDir });
  await p15Host.ensureSeeded();
  p15Host.remove('opencode');
  assert.ok(
    !fs.existsSync(path.join(p15Ud, 'agent-runtimes', 'scripts', 'opencode.mjs')),
    'remove 后脚本应删除'
  );
  const p15Host2 = new RuntimeHost({ userDataDir: p15Ud, builtinsDir });
  await p15Host2.ensureSeeded();
  assert.ok(p15Host2.get('opencode'), '重启后条目按种子补回');
  assert.ok(
    fs.existsSync(path.join(p15Ud, 'agent-runtimes', 'scripts', 'opencode.mjs')),
    'P1-5：补回条目时脚本文件也恢复（不再有条目无脚本）'
  );
  console.log('ok: restart after remove restores script file (P1-5)');
}

// restoreBuiltins() 无 ids 恢复全部 builtin
const restoreAllUd = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-restore-all-'));
const restoreAllHost = new RuntimeHost({ userDataDir: restoreAllUd, builtinsDir });
await restoreAllHost.ensureSeeded();
for (const id of ['cursor-cli', 'claude-code', 'opencode']) {
  restoreAllHost.remove(id);
  assert.equal(restoreAllHost.get(id), undefined);
}
const builtinCount = seedReg.runtimes.filter((e) => e.builtin).length;
const restoredAll = restoreAllHost.restoreBuiltins();
assert.equal(restoredAll.length, builtinCount);
for (const id of ['cursor-cli', 'claude-code', 'opencode']) {
  assert.ok(restoreAllHost.get(id), `restore all 应恢复 ${id}`);
  assert.ok(
    fs.existsSync(path.join(restoreAllUd, 'agent-runtimes', 'scripts', `${id}.mjs`)),
    `restore all 应拷回 ${id}.mjs`
  );
}
console.log('ok: restoreBuiltins restores all builtins');

// F-02（agent-runtime-registration）：registry.json 损坏 → ensureSeeded/reload 不再裸抛
// SyntaxError 炸启动链；回落 builtin 种子 + registry.json.bad 现场副本 + console.warn
{
  const corruptUd = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ud-corrupt-'));
  const corruptRoot = path.join(corruptUd, 'agent-runtimes');
  fs.mkdirSync(path.join(corruptRoot, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(corruptRoot, 'registry.json'), '{"version":1,"runtimes":[{"id":"broken"');
  const warns = []; const origWarn = console.warn; console.warn = (...a) => warns.push(a.join(' '));
  let corruptHost;
  try {
    corruptHost = new RuntimeHost({ userDataDir: corruptUd, builtinsDir });
    await corruptHost.ensureSeeded(); // 修复前：SyntaxError 沿 ensureSeeded 上抛
  } finally { console.warn = origWarn; }
  const corruptList = corruptHost.list();
  assert.ok(corruptList.some((e) => e.id === 'cursor-cli'), '回落 builtin 种子');
  assert.ok(!corruptList.some((e) => e.id === 'broken'), '不得读出坏档内容');
  assert.ok(fs.existsSync(path.join(corruptRoot, 'registry.json.bad')), '保留 registry.json.bad 现场副本');
  assert.ok(fs.readFileSync(path.join(corruptRoot, 'registry.json'), 'utf8').includes('"broken"'), '原坏档不被覆盖');
  assert.ok(warns.some((w) => w.includes('registry.json') && w.includes('解析失败')), 'console.warn 诊断');
  corruptHost.reload(); // 直接 reload 同样回落不抛
  assert.ok(corruptHost.list().some((e) => e.id === 'cursor-cli'), 'reload 后仍是 builtin 种子');
  console.log('ok: corrupt registry falls back to builtin seed with .bad copy (F-02)');
}
