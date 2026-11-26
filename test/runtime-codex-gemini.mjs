/**
 * T5.3 codex/gemini pty runtime 脚本合同测试（内置脚本约定）+ hooks 白名单。
 * Run: node test/runtime-codex-gemini.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = path.join(root, 'src/main/runtime/builtins/scripts');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-codex-gemini-'));

const codex = await import(pathToFileURL(path.join(scriptsDir, 'codex.mjs')).href);
const gemini = await import(pathToFileURL(path.join(scriptsDir, 'gemini.mjs')).href);

// ---------- 1) 内置脚本合同：必导出 allocate + resolveLaunch，allocate 返回非空 sessionId ----------
{
  for (const [name, mod] of [
    ['codex', codex],
    ['gemini', gemini]
  ]) {
    assert.equal(typeof mod.allocate, 'function', `${name}.allocate 必须是函数`);
    assert.equal(typeof mod.resolveLaunch, 'function', `${name}.resolveLaunch 必须是函数`);
    const ws = fs.mkdtempSync(path.join(tmp, `ws-${name}-`));
    const { sessionId } = await mod.allocate({ cwd: ws });
    assert.ok(typeof sessionId === 'string' && sessionId.trim().length > 0, `${name}.allocate 未返回 sessionId`);
  }
  console.log('ok: 内置脚本合同（必导出 + allocate 返回 sessionId）');
}

// ---------- 2) resolveLaunch resume 语义矩阵 ----------
function assertBareLaunch(launch, bin, extraArgs) {
  if (process.platform === 'win32') {
    assert.equal(launch.command, 'cmd.exe');
    const line = launch.args[3];
    const prefix = 'chcp 65001>nul & ';
    assert.ok(line.startsWith(prefix), line);
    const command = line.slice(prefix.length).match(/^(?:"([^"]+)"|(\S+))/);
    assert.equal(path.basename(command?.[1] ?? command?.[2] ?? '').replace(/\.(cmd|exe)$/i, ''), bin, line);
    assert.doesNotMatch(line, /resume/, '占位 id 不得带 resume（会直接报错退出）');
  } else {
    assert.equal(path.basename(launch.command), bin);
    assert.deepEqual(launch.args, extraArgs ?? []);
  }
}

{
  // codex：占位 → 裸 codex；真实 id → codex resume <id>；fork → codex fork <src>
  const pending = `codex-pending-11111111-2222-3333-4444-555555555555`;
  assertBareLaunch(codex.resolveLaunch({ probe: true, mode: 'start', sessionId: pending, extraArgs: [] }), 'codex');
  const real = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const resume = codex.resolveLaunch({ probe: true, mode: 'resume', sessionId: real, extraArgs: ['--model', 'gpt-5.1'] });
  if (process.platform === 'win32') {
    assert.match(resume.args[3], / resume a1b2c3d4-e5f6-7890-abcd-ef1234567890 --model gpt-5\.1/);
  } else {
    assert.deepEqual(resume.args, ['resume', real, '--model', 'gpt-5.1']);
  }
  const startReal = codex.resolveLaunch({ probe: true, mode: 'start', sessionId: real, extraArgs: [] });
  if (process.platform === 'win32') {
    assert.match(startReal.args[3], / resume a1b2c3d4/);
  } else {
    assert.deepEqual(startReal.args, ['resume', real]);
  }
  const fork = codex.resolveLaunch({ probe: true,
    mode: 'fork',
    sessionId: pending,
    extraArgs: [],
    forkFromSessionId: real
  });
  if (process.platform === 'win32') {
    assert.match(fork.args[3], / fork a1b2c3d4-e5f6-7890-abcd-ef1234567890/);
  } else {
    assert.deepEqual(fork.args, ['fork', real]);
  }
  // filterExtraArgs：假值过滤
  const filtered = codex.resolveLaunch({ probe: true, mode: 'start', sessionId: pending, extraArgs: [null, '', undefined] });
  if (process.platform !== 'win32') assert.deepEqual(filtered.args, []);

  // gemini：占位 → 裸 gemini；真实 id → gemini --resume <id>；无原生 fork → 裸启动
  const gPending = `gemini-pending-11111111-2222-3333-4444-555555555555`;
  assertBareLaunch(gemini.resolveLaunch({ mode: 'start', sessionId: gPending, extraArgs: [] }), 'gemini');
  const gResume = gemini.resolveLaunch({ mode: 'resume', sessionId: real, extraArgs: [] });
  if (process.platform === 'win32') {
    assert.match(gResume.args[3], /gemini --resume a1b2c3d4-e5f6-7890-abcd-ef1234567890/);
  } else {
    assert.deepEqual(gResume.args, ['--resume', real]);
  }
  const gFork = gemini.resolveLaunch({
    mode: 'fork',
    sessionId: gPending,
    extraArgs: [],
    forkFromSessionId: real
  });
  assertBareLaunch(gFork, 'gemini');
  console.log('ok: resolveLaunch 语义矩阵（占位/真实/fork/extraArgs 过滤）');
}

// ---------- 3) codex appendPrompt 落盘；gemini appendPrompt=false（TTY 键入回落） ----------
{
  const { INJECT_PROMPT_PREFIX, injectFileFromPromptArg } = await import(
    pathToFileURL(path.join(scriptsDir, '_helpers.mjs')).href
  );
  const extra = [];
  assert.equal(codex.appendPrompt({ prompt: 'fixture task', extraArgs: extra }), true);
  assert.equal(extra[extra.length - 2], '--');
  const file = injectFileFromPromptArg(extra[extra.length - 1]);
  assert.ok(file.startsWith(INJECT_PROMPT_PREFIX) === false && fs.existsSync(file), file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'fixture task\n');
  const geminiArgs = [];
  assert.equal(gemini.appendPrompt({ prompt: 'x', extraArgs: geminiArgs }), true);
  assert.equal(geminiArgs[0], '--prompt-interactive');
  assert.equal(fs.readFileSync(injectFileFromPromptArg(geminiArgs[1]), 'utf8'), 'x\n');
  console.log('ok: appendPrompt（codex 落盘短指令 / gemini 原生交互 prompt）');
}

// ---------- 4) canResume：占位恒 false；真实 rollout/chats 文件存在才 true ----------
{
  const fakeHome = fs.mkdtempSync(path.join(tmp, 'home-'));
  const prevCodex = process.env.CODEX_HOME;
  const prevGemini = process.env.GEMINI_CLI_HOME;
  process.env.CODEX_HOME = path.join(fakeHome, '.codex');
  process.env.GEMINI_CLI_HOME = path.join(fakeHome, '.gemini');
  const realId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  try {
    // 无存储：占位与真实 id 都 false
    assert.equal(codex.canResume({ sessionId: `codex-pending-${realId}` }), false);
    assert.equal(codex.canResume({ sessionId: realId }), false);
    assert.equal(gemini.canResume({ sessionId: `gemini-pending-${realId}` }), false);
    assert.equal(gemini.canResume({ sessionId: realId }), false);

    // codex：sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl 存在 → true
    const dayDir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '09', '15');
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(path.join(dayDir, `rollout-2026-09-15T10-00-00-${realId}.jsonl`), '{}\n');
    assert.equal(codex.canResume({ sessionId: realId }), true);
    assert.equal(codex.canResume({ sessionId: 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz' }), false);

    // gemini：tmp/<project_hash>/chats/<id>.json 存在 → true
    const chats = path.join(process.env.GEMINI_CLI_HOME, 'tmp', 'abc123', 'chats');
    fs.mkdirSync(chats, { recursive: true });
    fs.writeFileSync(path.join(chats, `${realId}.json`), '{}\n');
    assert.equal(gemini.canResume({ sessionId: realId }), true);
    assert.equal(gemini.canResume({ sessionId: 'yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy' }), false);
  } finally {
    if (prevCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodex;
    if (prevGemini === undefined) delete process.env.GEMINI_CLI_HOME;
    else process.env.GEMINI_CLI_HOME = prevGemini;
  }
  console.log('ok: canResume（占位 false / 真实存储探测）');
}

// ---------- 5) codex hooks 安装：结构 / activity 映射 / 合并纪律 / 去重 / 卸载 ----------
{
  const ws = fs.mkdtempSync(path.join(tmp, 'ws-hooks-'));
  const hooksPath = path.join(ws, '.codex', 'hooks.json');

  // 预置用户已有 hooks 与其它键
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(
    hooksPath,
    JSON.stringify(
      {
        other: { keep: true },
        hooks: {
          Stop: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-stop' }] }],
          PreToolUse: [{ hooks: [{ type: 'command', command: 'echo user-pre' }] }]
        }
      },
      null,
      2
    ),
    'utf8'
  );

  codex.ensureCodexHooks({ cwd: ws });
  const after1 = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  assert.deepEqual(after1.other, { keep: true }, '保留非 hooks 键');
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop']) {
    assert.ok(Array.isArray(after1.hooks[ev]), `装 ${ev}`);
  }
  const ourStop = after1.hooks.Stop.find((g) => g.hooks.some((h) => h.command.includes('muster-hook-v1')));
  assert.ok(ourStop, 'Stop 装了我们的条目');
  assert.equal(ourStop.hooks[0].command.split(' ').at(-2), 'idle', 'Stop → idle');
  assert.equal(ourStop.hooks[0].timeout, 10);
  const ourPr = after1.hooks.PermissionRequest[0].hooks[0];
  assert.equal(ourPr.command.split(' ').at(-2), 'blocked', 'PermissionRequest → blocked');
  const ourUps = after1.hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(ourUps.command.split(' ').at(-2), 'active', 'UserPromptSubmit → active');
  // 用户条目保留
  assert.ok(
    after1.hooks.Stop.some((g) => g.hooks?.some((h) => h.command === 'echo user-stop')),
    '用户 Stop hook 保留'
  );
  assert.ok(after1.hooks.PreToolUse, '用户 PreToolUse 保留（我们不装该事件）');

  // 重复运行去重
  codex.ensureCodexHooks({ cwd: ws });
  const after2 = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  const ours = after2.hooks.Stop.filter((g) => g.hooks.some((h) => h.command.includes('muster-hook-v1')));
  assert.equal(ours.length, 1, '重复 allocate 不追加重复条目');

  // 卸载：只删自己的
  const res = codex.uninstallDetectHooks({ cwd: ws });
  assert.ok(res.removed >= 4, `应移除全部 4 条（实际 ${res.removed}）`);
  const after3 = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  assert.ok(
    after3.hooks.Stop.some((g) => g.hooks?.some((h) => h.command === 'echo user-stop')),
    '卸载后用户 Stop hook 保留'
  );
  assert.ok(!after3.hooks.SessionStart && !after3.hooks.PermissionRequest && !after3.hooks.UserPromptSubmit, '我们的空事件键清掉');
  assert.deepEqual(after3.other, { keep: true });
  console.log('ok: codex hooks 安装/映射/合并/去重/卸载');
}

// ---------- 6) hooks 白名单：只用 _helpers.mjs 的 agentHookCommand（只报 activity+event，禁自造 URL） ----------
{
  const { agentHookCommand, HOOK_MARKER } = await import(
    pathToFileURL(path.join(scriptsDir, '_helpers.mjs')).href
  );
  const VALID_ACTIVITIES = new Set(['active', 'idle', 'waiting_input', 'blocked']);
  const ws = fs.mkdtempSync(path.join(tmp, 'ws-white-'));
  const { events } = codex.ensureCodexHooks({ cwd: ws });
  const top = JSON.parse(fs.readFileSync(path.join(ws, '.codex', 'hooks.json'), 'utf8'));
  const installed = [];
  for (const ev of events) {
    for (const g of top.hooks[ev] ?? []) {
      for (const h of g.hooks ?? []) installed.push({ ev, cmd: h.command });
    }
  }
  assert.ok(installed.length >= 4);
  for (const { ev, cmd } of installed) {
    assert.ok(cmd.includes(HOOK_MARKER), `hook 命令须带 ${HOOK_MARKER} 标记: ${cmd}`);
    assert.match(cmd, /^node ".*_agent-hook\.mjs" /, `hook 命令须经 node _agent-hook.mjs: ${cmd}`);
    const parts = cmd.split(' ');
    const activity = parts[parts.length - 2];
    const event = parts[parts.length - 1];
    assert.ok(VALID_ACTIVITIES.has(activity), `activity 须在白名单 ${[...VALID_ACTIVITIES]}: ${cmd}`);
    assert.ok(/^[a-z0-9-]+$/.test(event), `event 须是短横线事件名: ${cmd}`);
    assert.ok(!/https?:\/\/|curl |MUSTER_STATUS_URL/.test(cmd), 'hook 命令禁止自造 URL');
    // 与 helper 生成的规范形完全一致
    assert.equal(cmd, agentHookCommand(activity, event), 'hook 命令必须由 agentHookCommand 拼装');
  }

  // 源码级白名单：hooks 一律经 agentHookCommand。
  const codexSrc = fs.readFileSync(path.join(scriptsDir, 'codex.mjs'), 'utf8');
  assert.match(codexSrc, /from '\.\/_helpers\.mjs'/, 'codex 须经 _helpers.mjs');
  assert.match(codexSrc, /agentHookCommand/, 'codex hooks 须用 agentHookCommand');
  const geminiSrc = fs.readFileSync(path.join(scriptsDir, 'gemini.mjs'), 'utf8');
  assert.match(geminiSrc, /agentHookCommand/);
  const geminiWs = fs.mkdtempSync(path.join(tmp, 'gemini-hooks-'));
  const file = path.join(geminiWs, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hooks: { AfterAgent: [{ hooks: [{ type: 'command', command: 'echo user' }] }] }, other: true }));
  gemini.ensureDetectHooks({ cwd: geminiWs }); gemini.ensureDetectHooks({ cwd: geminiWs });
  const settings = JSON.parse(fs.readFileSync(file));
  assert.equal(settings.hooks.BeforeAgent.length, 1, 'repeat install is idempotent');
  assert.match(settings.hooks.BeforeAgent[0].hooks[0].command, /active before-agent/);
  assert.match(settings.hooks.AfterAgent[1].hooks[0].command, /idle after-agent/);
  assert.equal(gemini.uninstallDetectHooks({ cwd: geminiWs }).removed, 2);
  const cleaned = JSON.parse(fs.readFileSync(file));
  assert.equal(cleaned.other, true);
  assert.equal(cleaned.hooks.AfterAgent[0].hooks[0].command, 'echo user');
  gemini.resolveLaunch({ mode: 'resume', sessionId: 'real-session', cwd: geminiWs, extraArgs: [], probe: true });
  assert.equal(JSON.parse(fs.readFileSync(file)).hooks.BeforeAgent, undefined, 'availability probe does not install hooks');
  gemini.resolveLaunch({ mode: 'resume', sessionId: 'real-session', cwd: geminiWs, extraArgs: [] });
  assert.equal(JSON.parse(fs.readFileSync(file)).hooks.BeforeAgent.length, 1, 'restored pre-upgrade sessions receive authoritative hooks too');
  console.log('ok: hooks 白名单（agentHookCommand 规范形 + activity 集合 + 无自造 URL）');
}

// ---------- 7) builtin registry 白名单：条目齐全、surface=pty、脚本存在、id 合法 ----------
{
  const reg = JSON.parse(fs.readFileSync(path.join(root, 'src/main/runtime/builtins/registry.json'), 'utf8'));
  const byId = new Map(reg.runtimes.map((e) => [e.id, e]));
  for (const id of ['codex', 'gemini']) {
    const e = byId.get(id);
    assert.ok(e, `registry 缺 ${id}`);
    assert.equal(e.builtin, true);
    assert.equal(e.surface, 'pty');
    assert.equal(e.script, `${id}.mjs`);
    assert.ok(fs.existsSync(path.join(scriptsDir, e.script)), `${e.script} 应存在`);
    assert.match(e.id, /^[a-zA-Z][a-zA-Z0-9_-]*$/, 'id 须满足 register 安全格式');
    assert.ok(typeof e.builtinScriptVersion === 'number' && e.builtinScriptVersion >= 1, '开箱脚本版本 >= 1');
  }
  // ids 唯一
  const ids = reg.runtimes.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'runtime id 不得重复');
  console.log('ok: builtin registry 白名单（codex/gemini 条目 + 脚本落盘）');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] runtime-codex-gemini');
