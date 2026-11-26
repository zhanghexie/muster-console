import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-pty-request-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { DesktopActivity } = await import(pathToFileURL(compile('main/desktop/desktopActivity.ts')));
  const { DesktopTurns } = await import(pathToFileURL(compile('main/desktop/desktopTurns.ts')));
  const { PtyDesktopTurns } = await import(pathToFileURL(compile('main/desktop/ptyDesktopTurns.ts')));
  const { capturePtyDesktopRequest } = await import(pathToFileURL(compile('main/desktop/ptyDesktopRequest.ts')));
  const labels = { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' };
  const activity = new DesktopActivity({ show: async () => {}, close: () => {} }, async () => {}, labels);
  const turns = new DesktopTurns(activity), ptyTurns = new PtyDesktopTurns(turns);
  let processGeneration = 'generation-1', token = {}, session = { id: 'cli', type: 'terminal', launchKind: 'agent', runtime: 'codex', archived: false };
  const ctx = { desktopPtyTurns: () => ptyTurns, pty: { desktopProcessGeneration: () => processGeneration }, sessions: {
    resolveSessionRef: input => { if (input.statusToken !== 'secret') throw new Error('invalid token'); return { id: 'cli' }; },
    peek: () => session, sessionScopeToken: () => token, isChatRuntime: () => false
  } };
  assert.throws(() => capturePtyDesktopRequest(ctx, ''), /authenticated/);
  const oldRequest = capturePtyDesktopRequest(ctx, 'secret');
  assert.equal(await turns.use('cli', oldRequest.desktopTurnId, 'window', async () => 1), 1);
  await turns.stop();
  ptyTurns.noteUserInstruction('cli', 'new-instruction');
  const binding = { processGeneration, sessionToken: token, isCurrent: () => true };
  const next = ptyTurns.beginUserInstruction('cli', 'new-instruction', binding);
  assert.equal(await turns.use('cli', next.desktopTurnId, 'window', async () => 2), 2);
  assert.equal(oldRequest.isDesktopCurrent(), false, 'a request captured before the new turn cannot borrow its identity');
  const current = capturePtyDesktopRequest(ctx, 'secret');
  assert.equal(current.desktopTurnId, next.desktopTurnId);
  processGeneration = 'generation-2';
  assert.equal(current.isDesktopCurrent(), false);
  const replacement = capturePtyDesktopRequest(ctx, 'secret');
  assert.notEqual(replacement.desktopTurnId, current.desktopTurnId);
  token = {};
  assert.equal(replacement.isDesktopCurrent(), false);
  session.archived = true;
  assert.throws(() => capturePtyDesktopRequest(ctx, 'secret'), /unavailable/);
  session = { ...session, archived: false, launchKind: 'shell' };
  assert.throws(() => capturePtyDesktopRequest(ctx, 'secret'), /unavailable/);
  console.log('PTY desktop request: early authenticated process-bound snapshots passed');
} finally { removeWorkspaceFixture(temp, 'desktop-pty-request-'); }
