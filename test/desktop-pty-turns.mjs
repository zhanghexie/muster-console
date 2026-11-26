import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-pty-turns-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { DesktopActivity } = await import(pathToFileURL(compile('main/desktop/desktopActivity.ts')));
  const { DesktopTurns } = await import(pathToFileURL(compile('main/desktop/desktopTurns.ts')));
  const { PtyDesktopTurns } = await import(pathToFileURL(compile('main/desktop/ptyDesktopTurns.ts')));
  const labels = { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' };
  const activity = new DesktopActivity({ show: async () => {}, close: () => {} }, async () => {}, labels);
  const turns = new DesktopTurns(activity), pty = new PtyDesktopTurns(turns);
  let processGeneration = 'process-1', sessionToken = {}, running = true;
  const binding = () => {
    const generation = processGeneration, token = sessionToken;
    return { processGeneration: generation, sessionToken: token,
      isCurrent: () => running && processGeneration === generation && sessionToken === token };
  };
  const first = pty.capture('cli', binding());
  assert.equal(pty.capture('cli', binding()).desktopTurnId, first.desktopTurnId);
  assert.equal(await turns.use('cli', first.desktopTurnId, 'window', async () => 1), 1);
  pty.noteUserInstruction('cli', 'pre-stop-message');
  await turns.stop();
  const oldMessage = pty.beginUserInstruction('cli', 'pre-stop-message', binding());
  await assert.rejects(turns.use('cli', oldMessage.desktopTurnId, 'window', async () => 2), /predates the latest stop/);
  pty.noteUserInstruction('cli', 'new-message');
  const resumed = pty.beginUserInstruction('cli', 'new-message', binding());
  assert.equal(await turns.use('cli', resumed.desktopTurnId, 'window', async () => 3), 3);
  assert.equal(oldMessage.isDesktopCurrent(), false);
  processGeneration = 'process-2';
  assert.equal(resumed.isDesktopCurrent(), false, 'a replaced process cannot inherit the old identity');
  const replacement = pty.capture('cli', binding());
  assert.notEqual(replacement.desktopTurnId, resumed.desktopTurnId);
  sessionToken = {};
  assert.equal(replacement.isDesktopCurrent(), false, 'archiving or replacing the session scope revokes its lease');
  await turns.stop();
  const afterStop = pty.capture('cli', binding());
  await assert.rejects(turns.use('cli', afterStop.desktopTurnId, 'window', async () => 4), /new user instruction/,
    'a new PTY process alone cannot resume desktop control');
  pty.end('cli');
  assert.equal(afterStop.isDesktopCurrent(), false);
  running = false;
  assert.throws(() => pty.capture('cli', binding()), /unavailable/);
  console.log('PTY desktop turns: host process identity, stop latch and explicit user submission passed');
} finally { removeWorkspaceFixture(temp, 'desktop-pty-turns-'); }
