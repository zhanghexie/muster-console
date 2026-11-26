/** Cursor ACP mode negotiation, interaction replies and cancellation through the real driver. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-acp-test-'));
const compile = createSharedCompiler(root, tmp);
const { AcpRuntimeDriver } = await import(pathToFileURL(compile('main/agentSession/drivers/acp/driver.ts')).href);
const { NdjsonRpc } = await import(pathToFileURL(compile('main/agentSession/drivers/acp/jsonRpc.ts')).href);
const { parseCursorQuestions, cursorQuestionResponse, cursorPlanResponse } = await import(pathToFileURL(compile('main/agentSession/drivers/acp/cursor.ts')).href);
const { initialGuiWorkerMode } = await import(pathToFileURL(compile('main/agentSession/host/internal.ts')).href);
const { wrapCmdShimIfNeeded, defaultAcpAgentId } = await import(pathToFileURL(compile('main/agentSession/drivers/acp/agents.ts')).href);
const fake = path.join(root, 'test/helpers/cursor-acp-fake.mjs');
const hostMcp = path.join(root, 'src/main/inboundMcp/stdioEntry.ts');
const waitFor = async fn => { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); } };
function make(scenario = '') {
  let launchArgs;
  const driver = new AcpRuntimeDriver({ config: { get: () => ({}) } }, { userDataDir: tmp }, {
    hostMcpScript: hostMcp,
    resolveLaunch: (_id, options) => { launchArgs = options?.args; return { command: 'fake', args: [] }; },
    spawnAgent: () => {
      const child = spawn(process.execPath, [fake], { env: { ...process.env, CURSOR_ACP_FAKE_SCENARIO: scenario }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.stderr.resume();
      const rpc = new NdjsonRpc(child.stdin, child.stdout);
      return { rpc, kill: () => { child.kill(); } };
    }
  });
  return { driver, launchArgs: () => launchArgs };
}
function input(overrides = {}) {
  return { sessionId: 'host-session', cwd: tmp, acpAgent: 'cursor', systemPromptAppend: '', mode: 'ask', planExecuting: false,
    permissionMode: 'ask', modeController: {}, hostTools: [], requestApproval: async () => ({ approved: false }),
    getTurnId: () => 'turn-1', getPolicyState: () => ({ mode: 'ask', planExecuting: false }), log() {}, ...overrides };
}
async function collect(conn) { const events = []; void (async () => { for await (const event of conn.events) events.push(event); })(); return events; }

try {
  assert.equal(initialGuiWorkerMode({ runtime: 'acp', piModeId: 'cursor' }), 'default');
  assert.equal(initialGuiWorkerMode({ runtime: 'acp', piModeId: 'cursor', guiMode: 'ask' }), 'default');
  assert.equal(initialGuiWorkerMode({ runtime: 'acp', piModeId: 'opencode' }), 'default');
  assert.match(fs.readFileSync(path.join(root, 'src/main/agentSession/host/lifecycle.ts'), 'utf8'), /initialGuiWorkerMode\(session\)/);
  const argv = ['--add-dir', 'workspace with spaces', 'acp'];
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(wrapCmdShimIfNeeded('/home/user/.local/bin/cursor-agent', argv, platform),
      { command: '/home/user/.local/bin/cursor-agent', args: argv, executable: '/home/user/.local/bin/cursor-agent' });
  }
  const windows = wrapCmdShimIfNeeded('C:\\Cursor App\\cursor-agent.cmd', argv, 'win32');
  assert.equal(windows.command, 'cmd.exe');
  assert.match(windows.args[3], /--add-dir "workspace with spaces" acp/);
  assert.match(wrapCmdShimIfNeeded('C:\\cursor-agent.cmd', ['--add-dir', 'C:\\100%'], 'win32').error, /%/);
  const cursorExe = path.join(tmp, 'cursor-fixture'), otherExe = path.join(tmp, 'opencode-fixture');
  for (const file of [cursorExe, otherExe]) fs.writeFileSync(file, '', { mode: 0o755 });
  const presets = [{ id: 'cursor', name: 'Cursor', commands: [cursorExe], args: ['acp'] },
    { id: 'opencode', name: 'OpenCode', commands: [otherExe], args: ['acp'] }];
  assert.equal(defaultAcpAgentId(undefined, presets), 'opencode', 'Cursor must not steal the generic ACP default');
  assert.equal(defaultAcpAgentId(undefined, presets.slice(0, 1)), 'opencode', 'Cursor is only selected explicitly');
  assert.equal(defaultAcpAgentId('cursor', presets), 'cursor', 'an explicit Cursor selection is preserved');
  assert.equal(cursorPlanResponse({ kind: 'answered', answers: [{ id: 'cursor-plan', selected: ['拒绝'] }] }).outcome.outcome, 'rejected');
  assert.equal(cursorPlanResponse({ kind: 'answered', answers: [{ id: 'cursor-plan', selected: ['Approve'] }] }, 'Approve').outcome.outcome, 'accepted');
  assert.equal(cursorPlanResponse({ kind: 'aborted' }).outcome.outcome, 'cancelled');
  const parsed = parseCursorQuestions({ questions: [{ id: 'q', prompt: 'Pick', options: [{ id: 'one', label: 'One' }] }] });
  assert.deepEqual(cursorQuestionResponse(parsed.questions, { kind: 'answered', answers: [{ id: 'q', selected: ['One'] }] }),
    { outcome: { outcome: 'answered', answers: [{ questionId: 'q', selectedOptionIds: ['one'] }] } });
  assert.equal(cursorQuestionResponse(parsed.questions, { kind: 'answered', answers: [{ id: 'q', selected: [], custom: 'other' }] }).outcome.outcome, 'skipped');
  assert.throws(() => parseCursorQuestions({ questions: [{ id: 'q', prompt: 'x', options: [{ id: 'a', label: 'same' }, { id: 'b', label: 'same' }] }] }), /重复/);

  const calls = [];
  const m = make();
  const extra = path.join(tmp, 'other root');
  const ctx = { cwd: tmp, writableDirectories: [{ path: tmp }, { path: extra }] };
  const conn = await m.driver.connect(input({ workspaceContext: ctx, requestUserQuestion: async request => {
    calls.push(request);
    return request.questions[0].id === 'cursor-plan'
      ? { kind: 'answered', answers: [{ id: 'cursor-plan', selected: ['批准'] }] }
      : { kind: 'answered', answers: [{ id: 'q1', selected: ['Beta'] }] };
  } }));
  assert.deepEqual(m.launchArgs(), ['--add-dir', extra, 'acp']);
  assert.equal(conn.getNativeConfig().options[0].currentValue, 'agent', 'legacy workbench ask did not override the engine');
  assert.equal(conn.getNativeConfig().options[0].category, '_native-modes');
  assert.equal(conn.getNativeConfig().options[0].choices[0].name, 'Session modes');
  await conn.setNativeConfig('mode', 'architect-v2');
  assert.equal(conn.getNativeConfig().options[0].currentValue, 'architect-v2');
  await conn.setNativeConfig('native_toggle', true);
  assert.equal(conn.getNativeConfig().options[1].currentValue, true);
  const events = await collect(conn);
  await conn.send('hello');
  await waitFor(() => events.some(event => event.type === 'turn-complete'));
  const output = JSON.parse(events.find(event => event.type === 'text-delta').delta);
  assert.deepEqual(output.question.outcome.answers[0].selectedOptionIds, ['b']);
  assert.equal(output.plan.outcome.outcome, 'accepted');
  assert.match(calls[1].questions[0].detail, /Inspect/);
  await conn.close();

  const bad = make('bad-mode');
  const mismatched = await bad.driver.connect(input());
  await assert.rejects(() => mismatched.setNativeConfig('mode', 'architect-v2'), /未确认所选配置/);
  assert.equal(mismatched.getNativeConfig().options[0].currentValue, 'agent');
  await mismatched.close();
  const early = await make('early-config').driver.connect(input());
  assert.equal(early.getNativeConfig().options[0].currentValue, 'architect-v2');
  await early.close();
  const replace = await make('full-update').driver.connect(input());
  await assert.rejects(() => replace.setNativeConfig('mode', 'architect-v2'), /未确认所选配置/);
  assert.deepEqual(replace.getNativeConfig().options, []);
  await replace.close();
  const legacy = await make('legacy').driver.connect(input());
  await legacy.setNativeConfig('mode', 'architect-v2');
  await waitFor(() => legacy.getNativeConfig().options[0].currentValue === 'architect-v2');
  await legacy.close();

  const load = make('load-fails');
  await assert.rejects(() => load.driver.connect(input({ resumeToken: 'cursor-session' })), /Cursor ACP 无法恢复原生会话.*历史仍可查看/);

  const cancel = make('cancel');
  let signal;
  const pending = await cancel.driver.connect(input({ requestUserQuestion: (_req, s) => { signal = s; return new Promise(() => {}); } }));
  const cancelledEvents = await collect(pending);
  await pending.send('hello');
  await waitFor(() => !!signal);
  await pending.abort();
  await waitFor(() => signal.aborted && cancelledEvents.some(event => event.type === 'turn-complete'));
  await pending.close();
  console.log('ok: Cursor ACP modes, native questions, plan approval, directories and cancellation');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
