import { installFakeOwnedBackground } from './helpers/background-pty.mjs';
/**
 * 后台任务（子代理/后台终端/定时器）纯逻辑：共享合同 + PTY launch 构造 + 消息装配。
 * 运行: node test/bg-tasks.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-tasks-'));

/** 递归解析相对依赖的编译装载（单文件 load() 解析不了 shellTask 的相对依赖） */
const compileTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-tasks-compile-'));
const compile = createSharedCompiler(root, compileTmp);
const loadViaCompiler = async (rel) => import(pathToFileURL(compile(rel.replace(/^src\//, ''))).href);

async function load(rel) {
  const entry = path.join(root, rel);
  const out = path.join(tmp, path.basename(rel).replace(/\.ts$/, '.mjs'));
  const { outputText } = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: entry
  });
  fs.writeFileSync(out, outputText, 'utf8');
  return import(pathToFileURL(out));
}

const bg = await load('src/shared/backgroundTasks.ts');
const launch = await load('src/main/shell/bgLaunch.ts');
const transcript = await load('src/main/agentSession/background/transcript.ts');
const caps = await loadViaCompiler('src/shared/agentRuntimeCapabilities.ts');

{
  const { buildBgTaskTools } = await loadViaCompiler('src/main/agentSession/tools/backgroundTasks.ts');
  const started = [];
  const tools = buildBgTaskTools({ bgTasks: {
    spawnShell(...args) { started.push(args); return { ok: true, id: 'sh-1' }; },
    addTimer(...args) { started.push(args); return { ok: true, id: 'tm-1' }; }
  } });
  const run = (id, args) => tools.find(t => t.id === id).execute(args, { sessionId: 'me', cwd: '/work' });
  const body = 'long user text '.repeat(500).trim();
  for (const [args, policy] of [[{}, '静默'], [{ wake: true }, 'success'], [{ wake: true, wakeOn: 'fail' }, 'fail'], [{ wake: true, wakeOn: 'always' }, 'always']]) {
    assert.equal(await run('bgtasks.shell', { command: body, ...args }), `后台命令已启动（sh-1），唤醒策略：${policy}`);
    assert.equal(started.at(-1)[2], body);
  }
  assert.equal(await run('bgtasks.wait', { reason: body, delaySec: 90 }), '定时器已设（tm-1），90000 ms 后唤醒');
  assert.deepEqual(started.at(-1), ['me', 90000, body]);
}

// ---- 摘要构建 ----
const mk = (over) => ({
  id: 't-1',
  parentSessionId: 's1',
  kind: 'shell',
  label: '构建',
  detail: 'npm run build',
  status: 'done',
  createdAt: 1,
  unread: true,
  pendingDigest: true,
  wake: false,
  ...over
});
const digest = bg.buildBgTaskDigest([
  mk({ summary: '编译通过' }),
  mk({ id: 't-2', status: 'error', exitCode: 1, summary: 'TS 报错' })
]);
assert.ok(digest.includes('[后台任务结果通知'), 'digest 带标题');
assert.ok(digest.includes('t-1') && digest.includes('编译通过'), 'digest 含成功摘要');
assert.ok(digest.includes('t-2') && digest.includes('TS 报错'), 'digest 含失败摘要');
assert.equal(bg.buildBgTaskDigest([mk({ pendingDigest: false })]), null, '无待注入返回 null');
assert.equal(bg.buildBgTaskDigest([mk({ status: 'running' })]), null, '运行中不进摘要');

// ---- 摘要截断 ----
assert.ok(bg.truncateBgText('x'.repeat(700)).length < 700, '超长截断');

// ---- 定时解析 ----
assert.equal(bg.parseTimerDelayMs(undefined, 90), 90000, 'delaySec 直通');
assert.equal(bg.parseTimerDelayMs('not-a-time', undefined), null, '非法时间');
assert.equal(bg.parseTimerDelayMs(undefined, undefined), null, '全缺省');
const past = new Date(Date.now() - 3600_000).toISOString();
const pastDelta = bg.parseTimerDelayMs(past, undefined);
assert.equal(pastDelta, null, '过去时刻无效');
const future = new Date(Date.now() + 60_000).toISOString();
assert.ok(bg.parseTimerDelayMs(future, undefined) > 50_000, 'ISO 未来时刻');

// ---- PTY launch 构造 ----
const shell = (id) => ({ id, label: id, command: `C:/bin/${id}.exe`, args: [] });
assert.deepEqual(launch.bgCommandLaunch(shell('cmd'), 'echo hi').args, ['/d', '/s', '/c', 'echo hi']);
assert.ok(launch.bgCommandLaunch(shell('powershell'), 'echo hi').args.includes('-NonInteractive'));
assert.deepEqual(launch.bgCommandLaunch(shell('git-bash'), 'echo hi').args, ['-lc', 'echo hi']);
// POSIX 档：登录非交互跑一条命令即退
assert.deepEqual(launch.bgCommandLaunch(shell('zsh'), 'echo hi').args, ['-l', '-c', 'echo hi']);
assert.deepEqual(launch.bgCommandLaunch(shell('bash'), 'echo hi').args, ['-l', '-c', 'echo hi']);
assert.equal(launch.bgPtyId('t-abc'), 'bg-t-abc');

// ---- 后台命令选档（t-4：bash 优先 + 强制 PowerShell；不改 profiles[0] 终端默认语义）----
const winProfiles = [shell('powershell'), shell('pwsh'), shell('cmd'), shell('git-bash'), shell('wsl')];
// auto：有 git-bash 档优先（Windows 探测序里 powershell 恒在前，profiles[0] 永是 PowerShell）
assert.equal(launch.pickBgShellProfile(winProfiles, 'auto')?.id, 'git-bash', 'auto 优先 git-bash');
assert.equal(launch.pickBgShellProfile(winProfiles)?.id, 'git-bash', '缺省即 auto');
// auto：无 git-bash（含 POSIX）回落 profiles[0]，不空抛
assert.equal(launch.pickBgShellProfile([shell('zsh'), shell('bash')], 'auto')?.id, 'zsh', '无 git-bash 回落 profiles[0]');
assert.equal(launch.pickBgShellProfile([], 'auto'), null, '全空返回 null');
// powershell：强制 powershell 档；缺了退 pwsh；再退 profiles[0] 兜底
assert.equal(launch.pickBgShellProfile(winProfiles, 'powershell')?.id, 'powershell', '强制取 powershell');
assert.equal(
  launch.pickBgShellProfile([shell('pwsh'), shell('git-bash')], 'powershell')?.id,
  'pwsh',
  '无 powershell 退 pwsh'
);
assert.equal(
  launch.pickBgShellProfile([shell('git-bash')], 'powershell')?.id,
  'git-bash',
  '都没有退 profiles[0] 兜底'
);
// 回归拦截（t-4 原 bug）：只看 profiles[0] 时 Windows 后台任务永远选 PowerShell
assert.notEqual(launch.pickBgShellProfile(winProfiles, 'auto')?.id, 'powershell', 'auto 不再落 PowerShell');

// ---- 后台终端自然退出：退出监听必须退订（A2-1-1 泄漏修复）----
{
  const shellTask = await loadViaCompiler('main/agentSession/background/shellTask.ts');
  const exitListeners = new Set();
  const ctx = {
    config: { get: () => ({ shell: { bgShellMode: 'auto' } }) },
    pty: {
      addExitListener: (fn) => {
        exitListeners.add(fn);
        return () => exitListeners.delete(fn);
      },
      spawn: () => undefined,
      getBuffer: () => 'some output\r\n',
      kill: () => undefined
    }
  };
  installFakeOwnedBackground(ctx.pty);
  let exited = null;
  let failMsg = null;
  const handle = await shellTask.startBgShell(ctx, 'task-a2', 'E:/demo', 'echo hi', {
    onExit: (code, tail) => {
      exited = { code, tail };
    },
    onFail: (m) => {
      failMsg = m;
    }
  });
  assert.ok(handle && typeof handle.kill === 'function', '拿到后台句柄');
  assert.equal(failMsg, null, '启动未失败');
  assert.equal(exitListeners.size, 1, '注册了退出监听');
  // 模拟 manager 泵的自然退出回调（sid 与 bgPtyId(taskId) 匹配）
  for (const fn of [...exitListeners]) fn(shellTask.bgPtyId('task-a2'), 0);
  await Promise.resolve();
  assert.ok(exited, '自然退出触发 onExit');
  assert.equal(exited.code, 0, '退出码透传');
  assert.ok(exited.tail.includes('some output'), 'summary 尾巴取自 pty 缓冲');
  // 泄漏修复断言：自然退出后监听器集合清空（还原即红：删掉 unsubscribe() 即为 1）
  assert.equal(exitListeners.size, 0, '自然退出后监听器集合清空');
}

// ---- 子代理消息装配 ----
const asm = new transcript.TranscriptAssembler();
assert.equal(asm.handle({ type: 'text-delta', delta: '你好' }), 'update');
assert.equal(asm.handle({ type: 'text-delta', delta: '世界' }), 'update');
assert.equal(asm.handle({ type: 'thinking-delta', delta: '想' }), 'update');
assert.equal(asm.messages[0].parts.length, 2, '同类 delta 合并、异类新开 part');
assert.equal(asm.messages[0].parts[0].text, '你好世界');
assert.equal(
  asm.handle({ type: 'tool-start', toolCallId: 'c1', toolName: 'bash', input: {} }),
  'update'
);
assert.equal(
  asm.handle({ type: 'tool-result', toolCallId: 'c1', toolName: 'bash', ok: false, output: 'boom' }),
  'update'
);
const toolPart = asm.messages[0].parts[2];
assert.equal(toolPart.tool.status, 'error', '工具结果落状态');

const asmProgress = new transcript.TranscriptAssembler();
assert.equal(
  asmProgress.handle({ type: 'tool-start', toolCallId: 'task-1', toolName: 'task', input: {} }),
  'update'
);
assert.equal(
  asmProgress.handle({ type: 'tool-progress', toolCallId: 'task-1', delta: '打开' }),
  'update'
);
assert.equal(
  asmProgress.handle({ type: 'thinking-delta', delta: '不该进主对话的对照' }),
  'update'
);
assert.equal(asmProgress.messages[0].parts[0].tool.output, '打开', '嵌套进度贴在工具卡');
assert.equal(asmProgress.messages[0].parts[1].kind, 'thinking', '顶层思考仍是独立 part');
assert.equal(asmProgress.handle({ type: 'turn-complete' }), 'end');
assert.equal(asm.handle({ type: 'turn-complete' }), 'end');
assert.equal(transcript.lastAssistantText(asm.messages), '你好世界');

// 错误事件 → end + error 字段
const asm2 = new transcript.TranscriptAssembler();
asm2.handle({ type: 'error', message: '模型不可用' });
assert.equal(asm2.messages[0].error, '模型不可用');

// 种子提示词：派发 prompt 作为首条 user 气泡
const asm3 = new transcript.TranscriptAssembler('调研仓库结构并总结');
assert.equal(asm3.messages.length, 1, '种子先入列');
assert.equal(asm3.messages[0].role, 'user');
assert.equal(asm3.messages[0].parts[0].text, '调研仓库结构并总结');
asm3.handle({ type: 'text-delta', delta: '好的' });
assert.equal(asm3.messages.length, 2, '种子不打断 assistant 新建');
assert.equal(transcript.lastAssistantText(asm3.messages), '好的');

// ---- 能力位 ----
// 子代理已于 2026-10-20 移除（改为带 parentSessionId 的普通会话，见
// docs/plans/subagent-generalization-plan.md）：bgtasksSpawn 能力位随之退役，
// bgtasks（shell/wait/list/kill）与子代理无关，各 runtime 保持不变。
assert.equal(caps.CHAT_RUNTIME_CAPABILITIES.pi.bgtasks, true, 'pi 开启 bgtasks');
assert.equal('cursor' in caps.CHAT_RUNTIME_CAPABILITIES, false, 'retired cursor service has no independent chat capability');
assert.equal(caps.CHAT_RUNTIME_CAPABILITIES.claude.bgtasks, true, 'claude 进程内 MCP 注册 bgtasks');
assert.equal(caps.CHAT_RUNTIME_CAPABILITIES.acp.bgtasks, true, 'acp 开宿主后台 shell/wait');
assert.equal('bgtasksSpawn' in caps.CHAT_RUNTIME_CAPABILITIES.pi, false, 'bgtasksSpawn 能力位已退役');
assert.equal(caps.CHAT_RUNTIME_CAPABILITIES['codex-gui'].bgtasks, true, 'codex-gui B1b 起经 stdio MCP 开 bgtasks');
assert.equal(caps.isChatRuntimeId('codex-gui'), true);
assert.equal(caps.isChatRuntimeId('codex'), false, 'pty codex 不是 chat runtime');

// ---- 预算硬顶（共享合同纯函数） ----
assert.equal(bg.sanitizeBgBudget(undefined), null, '未提供预算 → null');
assert.equal(bg.sanitizeBgBudget(null), null);
assert.equal(typeof bg.sanitizeBgBudget('x'), 'string', '非对象拒绝');
assert.equal(typeof bg.sanitizeBgBudget({}), 'string', '空对象拒绝（至少一项）');
assert.equal(typeof bg.sanitizeBgBudget({ maxTurns: 0 }), 'string', 'maxTurns 须 ≥1');
assert.equal(typeof bg.sanitizeBgBudget({ tokenCap: 999 }), 'string', 'tokenCap 下限 1000');
assert.deepEqual(bg.sanitizeBgBudget({ maxTurns: 10 }), { maxTurns: 10 });
assert.deepEqual(bg.sanitizeBgBudget({ tokenCap: 50_000 }), { tokenCap: 50_000 });

assert.equal(bg.budgetBreachReason(undefined, { turns: 99, tokens: 1e9 }), null, '无预算不设限');
assert.equal(bg.budgetBreachReason({ maxTurns: 5 }, { turns: 5, tokens: 0 }), null, '未超不报');
assert.match(
  bg.budgetBreachReason({ maxTurns: 5 }, { turns: 6, tokens: 0 }),
  /轮次 6 超过上限 5/,
  '轮次突破'
);
assert.match(
  bg.budgetBreachReason({ tokenCap: 1000 }, { turns: 1, tokens: 1500 }),
  /token 1500 超过上限 1000/,
  'token 突破'
);

let acc = bg.addHarnessUsage(undefined, { inputTokens: 100, outputTokens: 20 });
acc = bg.addHarnessUsage(acc, { inputTokens: 30, outputTokens: 50, cacheReadTokens: 9000 });
assert.deepEqual(acc, { turns: 0, tokens: 200 }, '只累计 input+output，cache 不计');

// ---- 注册表落盘恢复（真源是文件；stub 掉真实任务执行模块） ----
const stubShell = path.join(tmp, 'mgr-stub-shell.mjs');
fs.writeFileSync(
  stubShell,
  'export async function startBgShell() { throw new Error("stub spawn"); }\n',
  'utf8'
);
{
  const { outputText } = ts.transpileModule(
    fs.readFileSync(path.join(root, 'src/main/agentSession/drivers/pi/modes.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }
  );
  fs.writeFileSync(path.join(tmp, 'modes.mjs'), outputText, 'utf8');
}
// manager 的相对依赖重写到 tmp：i18n 用恒等 stub（key=中文原文），backgroundTasks/atomicJson 独立转译
fs.writeFileSync(path.join(tmp, 'i18n.mjs'), 'export const t = (s) => s;\n', 'utf8');
{
  const { outputText } = ts.transpileModule(
    fs.readFileSync(path.join(root, 'src/shared/backgroundTasks.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }
  );
  fs.writeFileSync(path.join(tmp, 'shared-bg.mjs'), outputText, 'utf8');
}
{
  const { outputText } = ts.transpileModule(
    fs.readFileSync(path.join(root, 'src/main/atomicJson.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }
  );
  fs.writeFileSync(path.join(tmp, 'atomicJson.mjs'), outputText, 'utf8');
}
const mgrSrc = path.join(root, 'src/main/agentSession/background/manager.ts');
const mgrOut = path.join(tmp, 'manager.mjs');
{
  const { outputText } = ts.transpileModule(fs.readFileSync(mgrSrc, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: mgrSrc
  });
  const fixed = outputText
    .split("'../../runtimeKernel/storageRootResolver'")
    .join(JSON.stringify(pathToFileURL(compile('main/runtimeKernel/storageRootResolver.ts')).href))
    .split("'../../runtimeKernel/semanticOperations'")
    .join(JSON.stringify(pathToFileURL(compile('main/runtimeKernel/semanticOperations.ts')).href))
    .split("'./shellTask'")
    .join("'./mgr-stub-shell.mjs'")
    .split("'../../../shared/i18n'")
    .join("'./i18n.mjs'")
    .split("'../../../shared/backgroundTasks'")
    .join("'./shared-bg.mjs'")
    .split("'../../atomicJson'")
    .join("'./atomicJson.mjs'")
    .split("'./source'")
    .join(JSON.stringify(pathToFileURL(compile('main/agentSession/background/source.ts')).href));
  fs.writeFileSync(mgrOut, fixed, 'utf8');
}
const { BackgroundTaskManager } = await import(pathToFileURL(mgrOut));

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-tasks-mgr-'));
const savedAt = Date.now();
const mkRecord = (over) => ({
  id: 't-run1',
  parentSessionId: 's1',
  kind: 'subagent',
  label: '调研',
  detail: '做点事',
  status: 'running',
  createdAt: savedAt - 1000,
  unread: false,
  pendingDigest: false,
  wake: true,
  ...over
});
fs.writeFileSync(
  path.join(userDir, 'bg-tasks.json'),
  JSON.stringify({
    version: 1,
    savedAt,
    tasks: [
      mkRecord(),
      mkRecord({ id: 't-done1', kind: 'shell', status: 'done', summary: 'ok', pendingDigest: true }),
      mkRecord({ id: 't-bad', kind: 'alien', status: 'done' }),
      mkRecord({ id: 't-old', status: 'done', createdAt: savedAt - 8 * 24 * 3600 * 1000 })
    ]
  }),
  'utf8'
);
const fakeCtx = {
  getWindow: () => null,
  config: { get: () => ({ workspaces: [{ id: 'bg-fixture', path: userDir }], activeWorkspaceId: 'bg-fixture' }) },
  sessions: { get: (id) => id === 's2' ? { id, name: 'Shell fixture', workspaceId: 'bg-fixture', cwd: userDir } : undefined },
  agentSessions: undefined
};
const mgr = new BackgroundTaskManager(fakeCtx, { userDataDir: userDir });
const restored = mgr.listFor('s1');
assert.equal(restored.length, 2, '损坏记录与超期记录不恢复');
const runTask = restored.find((t) => t.id === 't-run1');
assert.equal(runTask.status, 'error', 'running 恢复为 error');
assert.match(runTask.summary, /应用重启/, '中断原因可读');
assert.equal(runTask.pendingDigest, true, '中断任务进 digest 让父会话知晓');
assert.equal(runTask.wake, false, '中断任务不再唤醒');
const doneTask = restored.find((t) => t.id === 't-done1');
assert.equal(doneTask.status, 'done', '已完成任务原样保留');
const preparedDigest2 = mgr.prepareDigest('s1');
const digest2 = preparedDigest2?.text;
assert.ok(digest2.includes('t-run1'), 'digest 含中断任务');
assert.equal(mgr.prepareDigest('s1')?.text, digest2, '准备摘要不消费，失败发送可重试');
mgr.ackDigest(preparedDigest2);
assert.equal(mgr.prepareDigest('s1'), null, '成功确认后摘要只消费一次');

// spawnShell 用 stub（派发即失败）→ complete(error) → persistSoon 落盘
const spawned = mgr.spawnShell('s2', userDir, 'echo hi', undefined, false);
assert.equal(spawned.ok, true);
await new Promise((r) => setTimeout(r, 900));
const persisted = JSON.parse(fs.readFileSync(path.join(userDir, 'bg-tasks.json'), 'utf8'));
assert.equal(persisted.version, 1, '落盘版本号');
const shellTaskRec = persisted.tasks.find((t) => t.parentSessionId === 's2');
assert.ok(shellTaskRec, '新任务已落盘');
assert.equal(shellTaskRec.status, 'error', 'stub 派发失败落 error');

// P17 丢弃规则
{
  const wake = (over) => ({
    id: 'a',
    createdAt: 10,
    status: 'error',
    kind: 'shell',
    detail: 'npm test',
    wake: true,
    wakeOn: 'always',
    ...over
  });
  const sibSuccess = {
    id: 'b',
    createdAt: 20,
    status: 'done',
    kind: 'shell',
    detail: 'npm test --watch=false',
    wake: true
  };
  assert.equal(
    bg.shouldInjectBgWake({
      task: wake({ wakeOn: 'success' }),
      sessionPhase: 'working',
      siblings: []
    }),
    false,
    '失败+success 默认不唤醒'
  );
  assert.equal(
    bg.shouldInjectBgWake({
      task: wake({ status: 'done', wakeOn: 'success' }),
      sessionPhase: 'working',
      siblings: []
    }),
    true,
    '成功+success 唤醒'
  );
  assert.equal(
    bg.shouldInjectBgWake({
      task: wake(),
      sessionPhase: 'needs_you',
      siblings: [sibSuccess]
    }),
    false,
    '已 needs_you 且有更新成功则丢弃更早失败'
  );
  assert.equal(
    bg.shouldInjectBgWake({
      task: wake({ id: 'old', createdAt: 5, status: 'done' }),
      sessionPhase: 'idle',
      siblings: [sibSuccess]
    }),
    false,
    '同命令族只留最新'
  );
  // 回归（P17）：后继同族任务「静默失败」时不得抑制更早任务的成功唤醒，
  // 否则两次结果一个唤醒都收不到；后继会真唤醒（always）时才抑制。
  const sibSilentFail = {
    id: 'b',
    createdAt: 20,
    status: 'error',
    kind: 'shell',
    detail: 'npm test --watch=false',
    wake: true
  };
  assert.equal(
    bg.shouldInjectBgWake({
      task: wake({ id: 'old', createdAt: 5, status: 'done' }),
      sessionPhase: 'working',
      siblings: [sibSilentFail]
    }),
    true,
    '同族后继静默失败不抑制更早成功唤醒'
  );
  assert.equal(
    bg.shouldInjectBgWake({
      task: wake({ id: 'old', createdAt: 5, status: 'done' }),
      sessionPhase: 'working',
      siblings: [{ ...sibSilentFail, wakeOn: 'always' }]
    }),
    false,
    '同族后继会真唤醒时仍抑制更早成功'
  );
  assert.equal(
    bg.shouldInjectBgWake({
      task: wake({ kind: 'subagent', detail: '审查', wakeOn: undefined }),
      sessionPhase: 'working',
      siblings: []
    }),
    true,
    '子代理失败仍唤醒（缺省 always）'
  );
  assert.equal(bg.bgCommandFamily('shell', 'npm test -s'), 'npm test');
  assert.deepEqual(bg.resolveShellWakePolicy(true, undefined), { wake: true, wakeOn: 'success' });
  assert.deepEqual(bg.parseBgWakeOn('always'), 'always');
}

// ---- C1: 超时转后台（sleep 除外） ----
{
  // isSleepCommand：纯 sleep 命令判定
  assert.equal(bg.isSleepCommand('sleep 30'), true, 'sleep 30 是纯 sleep');
  assert.equal(bg.isSleepCommand('sleep 5m'), true, 'sleep 5m 是纯 sleep');
  assert.equal(bg.isSleepCommand('  sleep  10  '), true, '带空白仍识别');
  assert.equal(bg.isSleepCommand('Start-Sleep -Seconds 5'), true, 'PowerShell sleep');
  assert.equal(bg.isSleepCommand('timeout /t 10'), true, 'Windows timeout');
  assert.equal(bg.isSleepCommand(''), false, '空命令非 sleep');
  assert.equal(bg.isSleepCommand('npm test'), false, '普通命令非 sleep');
  assert.equal(bg.isSleepCommand('sleep 5 && npm test'), false, '组合命令非纯 sleep');
  assert.equal(bg.isSleepCommand('sleep 5; echo done'), false, '带 ; 非纯 sleep');
  assert.equal(bg.isSleepCommand('echo sleep 30'), false, 'echo 开头非 sleep');
  // 2026-09-27 复审回归：换行分隔的组合命令不是纯 sleep（漏判会把多行命令当 sleep 超时杀掉）
  assert.equal(bg.isSleepCommand('sleep 5\necho pwned'), false, '换行分隔非纯 sleep');
  assert.equal(bg.isSleepCommand('sleep 5\r\ndir'), false, 'CRLF 分隔非纯 sleep');
  assert.equal(bg.isSleepCommand('sleep 5 | wc'), false, '管道非纯 sleep');

  // 2026-09-27 复审回归（源码锚）：输出文件随任务记录清理 / initiator 区分 / timeoutMs 钳制
  {
    const managerSrc = fs.readFileSync(
      path.join(root, 'src', 'main', 'agentSession', 'background', 'manager.ts'),
      'utf8'
    );
    assert.match(managerSrc, /this\.deleteBgOutput\(taskId\)/, 'remove() 连带删输出文件');
    assert.match(managerSrc, /sweepOrphanBgOutputs\(\)/, '启动清扫孤儿输出文件');
    assert.match(managerSrc, /this\.kill\(t\.id, 'user'\)/, '会话关闭/退出的 kill initiator 记 user');
    const toolsSrc = fs.readFileSync(
      path.join(root, 'src', 'main', 'agentSession', 'tools', 'backgroundTasks.ts'),
      'utf8'
    );
    assert.match(toolsSrc, /BG_SHELL_TIMEOUT_MS_CAP/, 'timeoutMs 有钳制上限');
    assert.ok(bg.BG_SHELL_TIMEOUT_MS_CAP === 10 * 60 * 1000, '上限常量为 10 分钟');
  }

  // resolveShellTimeoutAction：超时不判死——sleep 判 fail，其余自动转后台
  assert.equal(bg.resolveShellTimeoutAction('sleep 30'), 'fail', 'sleep 超时判失败');
  assert.equal(bg.resolveShellTimeoutAction('npm test'), 'background', '普通命令超时转后台');
  assert.equal(bg.resolveShellTimeoutAction('npm run build'), 'background', '构建命令超时转后台');
  assert.equal(bg.resolveShellTimeoutAction('make -j8'), 'background', '编译命令超时转后台');
}

// ---- C1: 输出截断保尾 + outputPath 指针 ----
{
  // truncateBgTextTail：保尾（与 truncateBgText 保头互补）
  const long = 'A'.repeat(500) + 'END';
  const tail = bg.truncateBgTextTail(long, 100);
  assert.ok(tail.length <= 101, '截断到 max 附近');
  assert.ok(tail.endsWith('END'), '保尾：末尾内容保留');
  assert.ok(tail.startsWith('…'), '前部省略标记');
  assert.equal(bg.truncateBgTextTail('short', 100), 'short', '短文本原样返回');
  assert.equal(bg.truncateBgTextTail('', 100), '', '空串原样返回');

  // buildOutputPointer：指针文案
  const ptr = bg.buildOutputPointer('/tmp/bg-outputs/t-1.log');
  assert.ok(ptr.includes('/tmp/bg-outputs/t-1.log'), '指针含路径');
  assert.ok(ptr.includes('Read') || ptr.includes('查看'), '引导读全文');

  // BG_OUTPUT_FILE_THRESHOLD 合理
  assert.ok(bg.BG_OUTPUT_FILE_THRESHOLD > 0, '阈值正数');

  // formatShellRunResult：判别联合文案
  const fg = bg.formatShellRunResult({ kind: 'foreground', exitCode: 0, summary: '编译通过', outputPath: '/tmp/out.log' });
  assert.ok(fg.includes('foreground'), 'foreground 标记');
  assert.ok(fg.includes('/tmp/out.log'), '含 outputPath 指针');
  const bgd = bg.formatShellRunResult({ kind: 'backgrounded', taskId: 't-1', reason: '超时 5000ms 自动转后台' });
  assert.equal(bgd, 'backgrounded: t-1（超时 5000ms 自动转后台）', '只确认已转后台及任务 ID，静默 shell 不能承诺唤醒');
}

// ---- C1: 通知 notified claim 防重复 ----
{
  const task = { notified: false };
  assert.equal(bg.claimNotification(task), true, '首次占用 claim');
  assert.equal(task.notified, true, '标记已通知');
  assert.equal(bg.claimNotification(task), false, '重复不再通知');
  const task2 = { notified: true };
  assert.equal(bg.claimNotification(task2), false, '已通知直接拒绝');
  const task3 = {};
  assert.equal(bg.claimNotification(task3), true, '未定义视作未通知');
  assert.equal(task3.notified, true, '占用后置 true');
}

// ---- C1: writeShellOutput 大输出落盘 ----
{
  const shellMod = await loadViaCompiler('main/agentSession/background/shellTask.ts');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-outputs-'));
  const small = 'x'.repeat(100);
  assert.equal(shellMod.writeShellOutput(outDir, 't-small', small), undefined, '小输出不落盘');
  const big = 'y'.repeat(5000);
  const outPath = shellMod.writeShellOutput(outDir, 't-big', big);
  assert.ok(outPath, '大输出落盘返回路径');
  assert.ok(outPath.includes('t-big'), '路径含任务 id');
  assert.ok(fs.existsSync(outPath), '文件已写入');
  assert.equal(fs.readFileSync(outPath, 'utf8'), big, '全文落盘');
}

console.log('bg-tasks: ok');
