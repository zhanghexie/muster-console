import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-retention-'));
try {
  const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
  const { latestAvailableSnapshot, retainLatestSnapshots } = await import(pathToFileURL(compile('main/turnChanges/retention.ts')).href);
  const dir = path.join(tmp, 'records'); fs.mkdirSync(dir);
  const owner = 'gui:session';
  const make = (name, opts = {}) => {
    const id = randomUUID(), messageId = `message-${name}`;
    const summary = { id, state: 'ready', warnings: [], files: [{ path: `${name}.ts`, kind: 'modified', added: 1, removed: 1, revertible: true }] };
    const message = { id: messageId, role: 'assistant', turnChanges: summary };
    const record = { owner: opts.owner ?? owner, messageId, roots: [], summary, files: [{ view: summary.files[0], abs: `${name}.ts`, before: null, beforeHash: null, after: null, diff: '+new' }] };
    const file = path.join(dir, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(record));
    return { id, messageId, message, file };
  };
  const old = make('old'), latest = make('latest');
  // A later undo can rewrite the older file; message order is authoritative.
  fs.utimesSync(old.file, new Date('2030-01-01'), new Date('2030-01-01'));
  const messages = [old.message, latest.message];
  assert.equal((await latestAvailableSnapshot(dir, owner, messages))?.id, latest.id);

  // Do not discard the old record until the latest message is durably saved.
  let outcome = await retainLatestSnapshots(dir, owner, () => messages, () => [old.message]);
  assert.equal(outcome.deferred, true);
  assert.ok(fs.existsSync(old.file) && fs.existsSync(latest.file));

  outcome = await retainLatestSnapshots(dir, owner, () => messages, () => messages);
  assert.equal(outcome.latestId, latest.id);
  assert.deepEqual(outcome.removedIds, [old.id]);
  assert.ok(!fs.existsSync(old.file) && fs.existsSync(latest.file));

  // Missing/corrupt newer records fall back to the last actually usable one.
  const corrupt = make('corrupt'); fs.writeFileSync(corrupt.file, '{broken');
  const missing = make('missing'); fs.unlinkSync(missing.file);
  const withUnavailable = [latest.message, corrupt.message, missing.message];
  assert.equal((await latestAvailableSnapshot(dir, owner, withUnavailable))?.id, latest.id);

  // A different owner and an in-flight finalization must not be removed.
  const peer = make('peer', { owner: 'gui:other' });
  const inFlight = make('in-flight');
  inFlight.message.turnChanges.state = 'collecting';
  const stillLive = [latest.message, inFlight.message];
  outcome = await retainLatestSnapshots(dir, owner, () => stillLive, () => [latest.message], { extra: [{ id: inFlight.id, messageId: inFlight.messageId }] });
  assert.ok(fs.existsSync(inFlight.file) && fs.existsSync(peer.file));
  assert.equal(outcome.latestId, latest.id);

  // A record being reverted is held until the operation is finished.
  const older = make('older');
  const replacement = make('replacement');
  const current = [older.message, replacement.message];
  await retainLatestSnapshots(dir, owner, () => current, () => current, { protectedId: id => id === older.id });
  assert.ok(fs.existsSync(older.file));
  await retainLatestSnapshots(dir, owner, () => current, () => current);
  assert.ok(!fs.existsSync(older.file) && fs.existsSync(replacement.file));
  console.log('turn-changes-retention: message order, durable handoff, missing records, owner isolation and in-flight protection passed');
} finally {
  assert.ok(path.dirname(path.resolve(tmp)) === path.resolve(os.tmpdir()) && path.basename(tmp).startsWith('turn-retention-'));
  fs.rmSync(tmp, { recursive: true, force: true });
}
