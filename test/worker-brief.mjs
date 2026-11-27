/**
 * Worker 简报纯函数 + cursor-cli appendPrompt + cmd 引号。
 * Run: node test/worker-brief.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-brief-'));
const compile = createSharedCompiler(root, tmp);

const { buildHostIntro, buildTaskBriefText, WORKER_DELEGATION_CONTRACT } = await import(
  'file:///' + compile('shared/workerBrief.ts').replace(/\\/g, '/')
);
const { INJECTION_REGISTRY } = await import(
  'file:///' + compile('main/agent/injection-registry.ts').replace(/\\/g, '/')
);
const delegationSource = INJECTION_REGISTRY.find(entry => entry.id === 'worker.turn-prefix.delegation-authority');
assert.equal(delegationSource?.target, 'worker');
assert.equal(delegationSource?.channel, 'turn-prefix');
assert.equal(delegationSource?.mode, 'conditional');
assert.equal(delegationSource?.survivesCompact, false);

const intro = buildHostIntro();
const brief = buildTaskBriefText('Investigate', { memorySection: 'Existing preference' });
assert.match(intro, /【Muster Console】\nNo task assigned yet\./);
assert.doesNotMatch(intro, /^Task:/m);
assert.match(brief, /Task: Investigate[\s\S]*Workspace memory \(snapshot\)[\s\S]*Existing preference/);
assert.ok(brief.includes(WORKER_DELEGATION_CONTRACT));
assert.doesNotMatch(intro, /scheduler is your task authority/, 'an empty session has not yet been assigned a delegated task');
assert.match(brief, /scheduler is your task authority.*task scope, acceptance criteria, and implementation details/);
assert.match(brief, /Send task questions to the scheduler with host\.mail\.send to=scheduler, or to=parent when you have a parent session/);
assert.match(brief, /do not ask the user to confirm changes to task scope, acceptance criteria, or implementation details/);
assert.match(brief, /Only irreversible actions require explicit user approval: integration or merge, push, publication, credential changes, data deletion, and external sending/);
assert.match(brief, /Respect explicit user instructions and existing tool permissions/);
assert.ok(intro.length < 1980, 'keep the static CLI introduction compact with the reminder workflow');

for (const input of [intro, brief]) {
  assert.match(input, /MUSTER_HOST=1/);
  assert.match(input, /Authorization: Bearer.*MUSTER_SESSION_TOKEN.*GET MUSTER_TOOL_URL.*POST \{"name":"host\.tool\.name","arguments":\{\}\}/);
  assert.match(input, /host_sessions_setStatus.*MUSTER_STATUS_URL.*能继续就继续。.*普通对话自然结束即可。.*需要你 = needs_you，完成 = done/);
  assert.doesNotMatch(input, /phase.{0,8}idle|use idle|report idle/i);
  assert.match(input, /kind=notice.*keep working.*kind=ask.*kind=handoff.*host\.waitFor.*keep working/);
  assert.match(input, /isolated worktree.*commit before needs_you.*host\.sessions\.requestIntegrate after explicit user approval/);
  assert.match(input, /search first with host\.memory\.search/);
  assert.doesNotMatch(input, /host\.memory\.remember/);
  assert.match(input, /Use host\.memory\.journal for decisions, findings, or handoffs worth revisiting/);
  assert.match(input, /Proactively submit lasting facts or preferences the user shares via host\.memory\.note/);
  assert.match(input, /Read ~\/\.muster\/skills\/memory\/SKILL\.md before your first memory tool call.*If the skill is unreadable, use registered tools/);
  assert.match(input, /host_ui_suggestReplies.*once/);
  assert.match(input, /host\.ui\.reminders \(if available\).*action=add before replying.*chat to-do.*user still needs to/);
  assert.ok(input.includes('Use fenced `mermaid` blocks in Markdown deliverables'));
  assert.match(input, /If available, use host\.ui\.render when filtering/);
  assert.doesNotMatch(input, /HOST(?:-EXT)?\.md|nextCursor|changes, verification, risks and leftovers|300 UTF-16 code units/);
}

const { appendPrompt, resolveLaunch } = await import(
  'file:///' + path.join(root, 'src/main/runtime/builtins/scripts/cursor-cli.mjs').replace(/\\/g, '/')
);
const {
  appendCliPrompt,
  INJECT_PROMPT_PREFIX,
  injectFileFromPromptArg,
  writeInjectPrompt
} = await import(
  'file:///' +
    path.join(root, 'src/main/runtime/builtins/scripts/_helpers.mjs').replace(/\\/g, '/')
);

function assertInjectFileArg(extra, body) {
  assert.equal(extra[extra.length - 2], '--');
  const promptArg = extra[extra.length - 1];
  assert.ok(promptArg.startsWith(INJECT_PROMPT_PREFIX), promptArg);
  const file = injectFileFromPromptArg(promptArg);
  assert.ok(fs.existsSync(file), file);
  assert.equal(fs.readFileSync(file, 'utf8'), body.endsWith('\n') ? body : `${body}\n`);
}

{
  const extra = ['--model', 'auto', '-f'];
  assert.equal(appendPrompt({ prompt: 'fixture task', extraArgs: extra }), true);
  assert.equal(extra[0], '--model');
  assertInjectFileArg(extra, 'fixture task');
  const empty = [];
  appendPrompt({ prompt: '  ', extraArgs: empty });
  assert.deepEqual(empty, []);
  const multi = [];
  const multiText = '【Muster Console】\n你是被拉起的 Worker。\nfixture task。';
  appendPrompt({ prompt: multiText, extraArgs: multi });
  assertInjectFileArg(multi, multiText.replace(/\r\n/g, '\n').trim());
  assert.doesNotMatch(multi.at(-1), / \| /);
  console.log('ok: cursor-cli appendPrompt 一律落盘');
}

{
  const extra = [];
  appendCliPrompt({ prompt: 'hello', extraArgs: extra });
  assertInjectFileArg(extra, 'hello');
  const claude = await import(
    'file:///' +
      path.join(root, 'src/main/runtime/builtins/scripts/claude-code.mjs').replace(/\\/g, '/')
  );
  const cextra = [];
  claude.appendPrompt({ prompt: 'hi', extraArgs: cextra });
  assertInjectFileArg(cextra, 'hi');
  const w = writeInjectPrompt('abc');
  assert.equal(w.promptArg, `${INJECT_PROMPT_PREFIX}${w.file}`);
  assert.equal(fs.readFileSync(w.file, 'utf8'), 'abc\n');
  console.log('ok: 短句也落盘（cursor/claude/helper）');
}

{
  const cursor = path.join(tmp, process.platform === 'win32' ? 'cursor-agent.cmd' : 'cursor-agent');
  fs.writeFileSync(cursor, '', { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = tmp;
  const launch = resolveLaunch({ sessionId: 'abc-123', extraArgs: ['--model', 'auto'] });
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  if (process.platform === 'win32') {
    assert.equal(launch.command, 'cmd.exe');
    // win 下经解析的绝对路径 + 引号形态（chcp 65001 包装），不钉引用格式
    assert.match(launch.args[3], /cursor-agent/);
    assert.match(launch.args[3], /--resume abc-123 --model auto/);
    assert.doesNotMatch(launch.args[3], /(^|[^\w-])agent /);
  } else {
    assert.equal(launch.command, cursor);
    assert.deepEqual(launch.args, ['--resume', 'abc-123', '--model', 'auto']);
  }
  console.log('ok: cursor-cli resolveLaunch 用 cursor-agent');
}

const { wrapWinCmd } = await import(
  'file:///' +
    path.join(root, 'src/main/runtime/builtins/scripts/_helpers.mjs').replace(/\\/g, '/')
);
{
  const flags = wrapWinCmd(['agent', '--resume', 'abc-123', '--model', 'auto', '-f']);
  if (process.platform === 'win32') {
    assert.equal(flags.command, 'cmd.exe');
    assert.match(flags.args[3], /agent --resume abc-123 --model auto -f/);
    const withPrompt = wrapWinCmd([
      'agent',
      '--resume',
      'id',
      '--',
      '请使用 UTF-8 编码读取并立即执行任务文件：C:\\Users\\a\\injects\\x.md'
    ]);
    assert.match(withPrompt.args[3], / -- /);
    assert.match(withPrompt.args[3], /"请使用 UTF-8 编码读取并立即执行任务文件：C:\\Users\\a\\injects\\x.md"/);
    const nl = wrapWinCmd(['agent', '【Muster Console】\n第二行']);
    assert.equal(nl.args[3].includes('\n'), false, 'cmd /c 参数不得含换行');
    assert.match(nl.args[3], /第二行/);
  } else {
    assert.equal(flags.command, 'agent');
  }
  console.log('ok: wrapWinCmd quoting');
}

const { escapeCmdArg, winCmdLaunchArgs } = await import(
  'file:///' + compile('main/encoding/winUtf8.ts').replace(/\\/g, '/')
);
{
  assert.equal(escapeCmdArg('--model'), '--model');
  assert.equal(escapeCmdArg('-f'), '-f');
  assert.equal(escapeCmdArg('abc-123'), 'abc-123');
  assert.equal(escapeCmdArg('hello world'), '"hello world"');
  const prompt = '请阅读：C:\\Users\\a\\x.md';
  assert.equal(escapeCmdArg(prompt), `"${prompt}"`);
  assert.equal(escapeCmdArg('第一行\n第二行').includes('\n'), false);
  const line = winCmdLaunchArgs(['agent', '--resume', 'id', '--', prompt]);
  assert.match(line[3], / -- /);
  assert.match(line[3], /"请阅读：C:\\Users\\a\\x.md"/);
  console.log('ok: escapeCmdArg');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] worker-brief');
