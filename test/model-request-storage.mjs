import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'request-store-'));
try {
  const bundle = path.join(root, 'store.mjs');
  await build({ entryPoints: ['src/main/agentSession/modelRequestStore.ts'], outfile: bundle,
    bundle: true, format: 'esm', platform: 'node' });
  const { setModelRequestRecording: set, recordingToken: epoch, listModelRequests: list,
    saveModelRequest: save, readModelRequest: read, readCompressionTrace: traceFor, clearModelRequests: clear, migrateModelRequests: migrate } = await import(pathToFileURL(bundle));
  const file = path.join(root, 'agent-inputs', 'model-requests.sqlite');
  let at = 0;
  function record(session, bytes, token = epoch(root, session), trace) {
    save(root, session, token, { at: ++at, model: 'fixture', protocol: 'test', complete: true }, bytes, trace);
    assert.ok(fs.statSync(file).size <= 50_000_000);
    return list(root, session)[0];
  }
  assert.equal(epoch(root, 'a'), null);
  assert.deepEqual(list(root, 'a'), []);
  assert.equal(fs.existsSync(file), false);
  set(root, 'a', true);
  const old = epoch(root, 'a');
  set(root, 'a', false);
  set(root, 'a', true);
  assert.notEqual(epoch(root, 'a'), old);
  assert.equal(record('a', Buffer.from('unfinished before stop'), old), undefined);
  set(root, 'b', true);
  const ascii = length => Buffer.from(randomBytes(length).toString('base64'));
  const shared = ascii(2_000_000);
  const firstBody = Buffer.concat([shared, ascii(8_000_000)]);
  const trace = { nativeId: 'n', file: 'test.jsonl', items: [{kind: 'excerpt', id: 'source', path: 'messages[1].content', sources: []}] };
  const first = record('a', firstBody, epoch(root, 'a'), trace);
  assert.equal(first.compressionCount, 1);
  assert.deepEqual(traceFor(root, 'a', first.id), trace);
  assert.equal(traceFor(root, 'b', first.id), null);
  const survivorBody = Buffer.concat([shared, Buffer.from('后续调用\r\n')]);
  const survivor = record('b', survivorBody, epoch(root, 'b'), trace);
  const size = fs.statSync(file).size;
  const duplicate = record('a', survivorBody);
  assert.notEqual(duplicate.id, survivor.id);
  assert.ok(fs.statSync(file).size - size < 100_000, 'duplicate only adds a manifest');
  set(root, 'c', true);
  const filler = [];
  while (read(root, 'a', first.id) !== null) {
    assert.ok(filler.length < 15, 'rollover expected');
    const bytes = ascii(4_000_000);
    const row = record('c', bytes);
    filler.push([row.id, bytes]);
  }
  assert.equal(read(root, 'b', survivor.id), survivorBody.toString());
  assert.equal(traceFor(root, 'a', first.id), null);
  assert.deepEqual(traceFor(root, 'b', survivor.id), trace);
  assert.equal(read(root, 'a', duplicate.id), survivorBody.toString());
  clear(root, 'a');
  assert.equal(read(root, 'b', survivor.id), survivorBody.toString());
  assert.equal(epoch(root, 'a'), null);
  const tooBig = record('c', randomBytes(51_000_000));
  assert.ok(tooBig.omitted);
  assert.equal(read(root, 'c', tooBig.id), null);
  assert.equal(read(root, 'b', survivor.id), survivorBody.toString());
  for (const [id, bytes] of filler) assert.equal(read(root, 'c', id), bytes.toString());
  clear(root, 'b');
  clear(root, 'c');
  const audit = new DatabaseSync(file);
  assert.equal(audit.prepare('SELECT count(*) AS n FROM blocks').get().n, 0);
  assert.deepEqual(audit.prepare('PRAGMA foreign_key_check').all(), []);
  audit.close();

  const legacyDir = path.join(root, 'agent-inputs', 'legacy-session');
  fs.mkdirSync(legacyDir);
  const legacyFile = path.join(legacyDir, 'model-requests.sqlite');
  const legacy = new DatabaseSync(legacyFile);
  legacy.exec('CREATE TABLE requests(id INTEGER PRIMARY KEY, at, model, protocol, bytes, complete, body)');
  legacy.prepare('INSERT INTO requests VALUES(1,1,?,?,4,1,?)').run('fixture', 'test', gzipSync('旧!'));
  legacy.close();
  migrate(root);
  migrate(root);
  assert.equal(list(root, 'legacy-session').length, 1);
  assert.equal(read(root, 'legacy-session', list(root, 'legacy-session')[0].id), '旧!');
  assert.equal(epoch(root, 'legacy-session'), null);
  assert.equal(fs.existsSync(legacyFile), false);
  console.log('50 MB rollover, byte-exact shared survivors, last reference reclamation, oversize rollback and migration passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
