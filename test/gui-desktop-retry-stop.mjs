import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

// Reuse the real GUI Host and controlled driver fixture; do not run its full suite.
const root = process.cwd();
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const temp = fs.mkdtempSync(path.join(root, '.tmp', 'gui-desktop-retry-stop-'));
try {
  const file = path.join(root, 'test/gui-host-lifecycle.mjs');
  const original = fs.readFileSync(file, 'utf8');
  const split = original.indexOf('const tests = [');
  assert.ok(split > 0, 'GUI lifecycle fixture boundary changed');
  let source = original.slice(0, split);
  const declaration = "const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');";
  assert.ok(source.includes(declaration), 'GUI lifecycle fixture root changed');
  source = source.replace(declaration, `const root = ${JSON.stringify(root)};`)
    .replace("from './helpers/codex-worktree.mjs'", `from ${JSON.stringify(new URL('./helpers/codex-worktree.mjs', import.meta.url).href)}`);
  if (process.env.MUSTER_TEST_GUI_RETRY_ORIGINAL === '1') {
    const loader = "  const source = fs.readFileSync(filename, 'utf8');";
    assert.ok(source.includes(loader), 'GUI lifecycle loader changed');
    const anchor = '  // Retry reuses an earlier message; it is not a newly accepted desktop instruction.';
    const oldNote = "  if (source && !source.host && !source.source && source.steering !== 'host') host.ctx.desktopTurns?.().noteUserInstruction?.(sessionId, source.id);";
    const flag = 'desktopUserInstruction: false, userMessageId: source?.id, ...(images';
    const oldFlag = "desktopUserInstruction: !!source && !source.host && !source.source && source.steering !== 'host', userMessageId: source?.id, ...(images";
    source = source.replace(loader, `  let source = fs.readFileSync(filename, 'utf8');
      if (filename.endsWith(path.join('agentSession', 'host', 'messaging.ts'))) {
        if (!source.includes(${JSON.stringify(anchor)}) || !source.includes(${JSON.stringify(flag)})) throw new Error('Retry regression control no longer matches');
        source = source.replace(${JSON.stringify(anchor)}, ${JSON.stringify(oldNote)}).replace(${JSON.stringify(flag)}, ${JSON.stringify(oldFlag)});
      }`);
  }
  if (process.env.MUSTER_TEST_ORIGINAL_GUI_STEER === '1') {
    const loader = "  const source = fs.readFileSync(filename, 'utf8');";
    assert.ok(source.includes(loader), 'GUI lifecycle loader changed');
    const fixed = 'workspaceId ? { workspaceId } : undefined);';
    source = source.replace(loader, `  let source = fs.readFileSync(filename, 'utf8');
      if (filename.endsWith(path.join('agentSession', 'host', 'turn.ts'))) {
        if (!source.includes(${JSON.stringify(fixed)})) throw new Error('GUI steer regression control no longer matches');
        source = source.replace(${JSON.stringify(fixed)}, 'undefined);');
      }`);
  }
  source += `
const testData = ${JSON.stringify(temp)};
const { DesktopResumeStateLedger } = require(path.join(root, 'src/main/desktop/desktopResumeState.ts'));
const { DesktopActivity } = require(path.join(root, 'src/main/desktop/desktopActivity.ts'));
const { DesktopTurns } = require(path.join(root, 'src/main/desktop/desktopTurns.ts'));
const ledger = new DesktopResumeStateLedger(path.join(testData, 'stop.sqlite'));
const labels = { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' };
const turns = new DesktopTurns(new DesktopActivity({ show: async () => {}, close() {} }, async () => {}, labels, undefined, undefined, ledger));
const begins = [], instructions = [];
const originalBegin = turns.begin.bind(turns), originalNote = turns.noteUserInstruction.bind(turns);
turns.begin = (...args) => { begins.push(args); return originalBegin(...args); };
turns.noteUserInstruction = (...args) => { instructions.push(args); return originalNote(...args); };
const { driver, state } = makeFakeDriver();
const workspace = { id: 'ws', path: fixtureWorkspace, controlRoot: fixtureWorkspace,
  roots: [{ id: 'main', path: fixtureWorkspace }], defaultRootId: 'main', rootsRevision: 0 };
const { host, ctx } = makeHost(path.join(testData, 'profile'), { workspaces: [workspace], activeWorkspaceId: 'ws' });
const row = session('retry-owner', { workspaceId: 'ws', sourceRoot: { rootId: 'main', path: fixtureWorkspace, cwd: fixtureWorkspace } });
ctx.desktopTurns = () => turns; ctx.__sessionsDb.set(row.id, row); host.registerDriver(driver); host.open(row);
const until = async (predicate, label) => {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await sleep(10);
  assert.ok(predicate(), label);
};
try {
  assert.equal((await host.send(row.id, '停止前的原始请求')).ok, true);
  await until(() => typeof state.resolveConnect === 'function', 'initial GUI driver did not connect');
  state.resolveConnect();
  await until(() => state.sends.length === 1 && begins.length === 1, 'initial GUI turn did not start');
  assert.equal(await turns.use(row.id, begins[0][1], 'fixture', async () => 'initial desktop'), 'initial desktop');
  assert.equal(instructions.length, 1);
  const oldId = begins[0][4];
  await turns.stop();
  assert.equal(ledger.hasStopped(), true);
  state.queue.push({ type: 'error', message: 'fixture failure before retry' });
  await until(() => !host.isBusy(row.id), 'failed original turn did not settle');

  assert.equal(host.retry(row.id).ok, true);
  await until(() => state.sends.length === 2 && begins.length === 2, 'manual retry did not send text');
  assert.equal(state.sends[1], '停止前的原始请求');
  assert.equal(begins[1][3], false, 'retry cannot claim a new desktop instruction');
  assert.equal(begins[1][4], oldId, 'retry must reuse the original user message identity');
  assert.equal(instructions.length, 1, 'retry cannot mint another instruction');
  assert.equal(ledger.isResumed(row.id), false);
  let dispatched = false;
  await assert.rejects(turns.use(row.id, begins[1][1], 'fixture', async () => { dispatched = true; }), /new user instruction/);
  assert.equal(dispatched, false, 'retry cannot dispatch desktop work after stop');
  state.queue.push({ type: 'text-delta', delta: '纯文本重试正常' });
  state.queue.push({ type: 'turn-complete' });
  await until(() => !host.isBusy(row.id), 'retry text did not finish');
  assert.ok(host.getHistory(row.id).messages.some(message => message.role === 'assistant' &&
    message.parts.some(part => part.kind === 'text' && part.text.includes('纯文本重试正常'))), 'retry text must reach the transcript');

  assert.equal((await host.send(row.id, '停止后的新指令')).ok, true);
  await until(() => state.sends.length === 3 && begins.length === 3, 'fresh user turn did not start');
  assert.equal(instructions.length, 2);
  assert.equal(await turns.use(row.id, begins[2][1], 'fixture', async () => 'fresh desktop'), 'fresh desktop');
  assert.equal(ledger.isResumed(row.id), true, 'an actual new user message can resume its owner');
  state.queue.push({ type: 'error', message: 'fixture failure after fresh instruction' });
  await until(() => !host.isBusy(row.id), 'fresh failed turn did not settle');
  assert.equal(host.retry(row.id).ok, true);
  await until(() => state.sends.length === 4 && begins.length === 4, 'second retry text did not start');
  assert.equal(instructions.length, 2);
  await assert.rejects(turns.use(row.id, begins[3][1], 'fixture', async () => assert.fail('retry dispatched')), /new user instruction/,
    'an owner already resumed by a user turn cannot turn retry into another instruction');
  state.queue.push({ type: 'text-delta', delta: '再次文本重试' });
  state.queue.push({ type: 'turn-complete' });
  await until(() => !host.isBusy(row.id), 'second retry did not complete');
  const proof = Object.freeze({ allows: origin => origin.owner === row.id && origin.workspaceId === 'ws' &&
    origin.stopGeneration === ledger.currentGeneration() });
  assert.equal((await host.send(row.id, '宿主续接文本', undefined, { host: true, desktopContinuation: proof })).ok, true);
  await until(() => state.sends.length === 5 && begins.length === 5, 'host continuation did not start');
  assert.equal(begins[4][3], false, 'host continuation is not a human instruction');
  assert.equal(begins[4][5].continuation, proof, 'the actual GUI host forwards its private source to the desktop turn');
  assert.equal(await turns.use(row.id, begins[4][1], 'fixture', async () => 'host desktop'), 'host desktop');
  assert.equal(instructions.length, 2);
  state.redirectReturns = true;
  const steer = await host.send(row.id, '插话后的新指令', undefined, { steerOnBusy: true });
  assert.equal(steer.steered, true);
  await until(() => begins.length === 6, 'steered desktop turn did not start');
  const captured = turns.captureContinuation(row.id, begins[5][1], 'ws', () => true);
  assert.ok(captured, 'steered desktop turn must bind its workspace for waitFor');
  assert.deepEqual(await captured, { owner: row.id, workspaceId: 'ws', stopGeneration: ledger.currentGeneration() });
  state.conn.receiveMessage = async () => {
    row.workspaceId = 'moved-while-steering';
    return { status: 'accepted', method: 'steered' };
  };
  const moved = await host.send(row.id, '插话期间切换工作区', undefined, { steerOnBusy: true });
  assert.equal(moved.steered, true);
  await until(() => begins.length === 7, 'second steered desktop turn did not start');
  assert.equal(turns.captureContinuation(row.id, begins[6][1], 'moved-while-steering', () => true), undefined,
    'a session move during steer cannot lend the existing engine turn a new workspace');
  assert.ok(turns.captureContinuation(row.id, begins[6][1], 'ws', () => true), 'the engine keeps its captured workspace');
  row.workspaceId = 'ws';
  state.queue.push({ type: 'turn-complete' });
  await until(() => !host.isBusy(row.id), 'host continuation did not finish');
  console.log('gui desktop retry: real host, text, stop SQLite and new instruction passed');
} finally {
  await host.close(row.id);
  ledger.close();
}
`;
  const generated = path.join(temp, 'fixture.mjs');
  fs.writeFileSync(generated, source);
  await import(pathToFileURL(generated));
} finally {
  removeWorkspaceFixture(temp, 'gui-desktop-retry-stop-');
}
