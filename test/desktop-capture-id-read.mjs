import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-capture-id-'));
let history, reopenedHistory;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { captureDisplay } = await import(pathToFileURL(compile('main/desktop/displayCapture.ts')));
  const { DesktopCaptureArtifacts } = await import(pathToFileURL(compile('main/desktop/captureArtifacts.ts')));
  const { prepareSessionCaptureDirectory } = await import(pathToFileURL(compile('main/desktop/sessionCaptureAccess.ts')));
  const { readCaptureArtifact, readHistoricalCapture } = await import(pathToFileURL(compile('main/desktop/captureRead.ts')));
  const { SqliteDesktopEpochHistory } = await import(pathToFileURL(compile('main/desktop/epochHistory.ts')));
  const { SchedulerDesktopTaskEpochs } = await import(pathToFileURL(compile('main/desktop/schedulerTaskEpoch.ts')));
  const userData = path.join(temp, 'data'); fs.mkdirSync(userData);
  const directory = prepareSessionCaptureDirectory(userData, 'session-a');
  const otherDirectory = prepareSessionCaptureDirectory(userData, 'session-b');
  const decode = async () => ({ width: 1, height: 1 }); let now = 100;
  const store = new DesktopCaptureArtifacts(directory, decode, () => now);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=', 'base64');
  const target = { taskId: 'task-a', surfaceId: 'screen', surfaceGeneration: 'one', geometryRevision: 'one',
    displayId: 1, bounds: { x: 0, y: 0, width: 1, height: 1 }, scaleFactor: 1 };
  const result = await captureDisplay({ artifacts: store, confirmAllDisplays: async () => true, audit: async () => {},
    normalizePng: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => png }),
    getSources: async () => [{ display_id: '1', thumbnail: { isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => png } }] }, target, () => true, 10);
  assert.equal(result.captureId, result.artifactId);
  const reopened = new DesktopCaptureArtifacts(directory, decode, () => now);
  assert.equal((await reopened.get('task-a', result.captureId)).path, result.path, 'lookup survives store recreation');
  await assert.rejects(reopened.get('task-b', result.captureId), /unavailable/);
  await assert.rejects(new DesktopCaptureArtifacts(otherDirectory, decode, () => now).get('task-a', result.captureId));
  let current = true; const audits = [];
  const actor = { sessionId: 'session-a', taskId: 'task-a', isCurrent: () => current };
  const storeFor = value => new DesktopCaptureArtifacts(value.sessionId === 'session-a' ? directory : otherDirectory, decode, () => now);
  const audit = async (_actor, _id, outcome) => { audits.push(outcome); };
  assert.equal((await readCaptureArtifact(actor, result.captureId, storeFor, audit)).path, result.path);
  await assert.rejects(readCaptureArtifact({ ...actor, taskId: 'task-b' }, result.captureId, storeFor, audit), /unavailable/);
  await assert.rejects(readCaptureArtifact({ ...actor, sessionId: 'session-b' }, result.captureId, storeFor, audit));
  await assert.rejects(readCaptureArtifact(actor, result.captureId, storeFor, async (_actor, _id, outcome) => {
    audits.push(outcome); if (outcome === 'allowed') current = false;
  }), /no longer current/);
  assert.deepEqual(audits, ['allowed', 'denied', 'denied', 'allowed', 'denied']);
  current = true;
  const historyPath = path.join(temp, 'epochs.sqlite'); history = new SqliteDesktopEpochHistory(historyPath);
  let sequence = 0;
  const epochs = new SchedulerDesktopTaskEpochs(async () => ({ approvalId: ++sequence === 1 ? 'task-a' : 'task-b' }), async () => {}, history, () => now);
  const scope = { appId: 'app', actionClass: 'click' };
  await epochs.ensure('session-a', scope, () => current);
  await epochs.startNew('session-a', scope, () => current);
  const reader = { sessionId: 'session-a', isCurrent: () => current };
  assert.equal((await readHistoricalCapture(reader, result.captureId, storeFor, epochs, audit)).path, result.path,
    'a new task does not revoke prior artifact access in the same session');
  reopenedHistory = new SqliteDesktopEpochHistory(historyPath);
  const restarted = new SchedulerDesktopTaskEpochs(async () => ({}), async () => {}, reopenedHistory, () => now);
  assert.equal((await readHistoricalCapture(reader, result.captureId, storeFor, restarted, audit)).path, result.path,
    'historical capture can be resolved after history store recreation without a model task ID');
  await assert.rejects(readHistoricalCapture({ ...reader, sessionId: 'session-b' }, result.captureId, storeFor, restarted, audit));
  await assert.rejects(readHistoricalCapture(reader, result.captureId, storeFor, restarted, async (_actor, _id, outcome) => {
    if (outcome === 'allowed') history.endSession('session-a');
  }), /history is no longer current/);
  await assert.rejects(readHistoricalCapture(reader, result.captureId, storeFor, restarted, audit), /outside this session history/);
  now = 110; await assert.rejects(reopened.get('task-a', result.captureId), /expired/);
  console.log('desktop capture ID: persisted task and session scoped lookup passed');
} finally { history?.close(); reopenedHistory?.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 }); }
