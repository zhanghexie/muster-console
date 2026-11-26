import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { build } from 'esbuild';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'request-export-'));
try {
  await build({ entryPoints: ['src/main/agentSession/modelRequestExport.ts', 'src/main/agentSession/modelRequestStore.ts'],
    outdir: root, outExtension: { '.js': '.mjs' }, bundle: true, format: 'esm', platform: 'node' });
  const { writeModelRequestExport: write } = await import(pathToFileURL(path.join(root, 'modelRequestExport.mjs')));
  const store = await import(pathToFileURL(path.join(root, 'modelRequestStore.mjs')));
  const target = path.join(root, '中文 导出.zip');
  assert.throws(() => write(root, 'empty', target), /暂无模型请求记录|No model requests/);
  assert.equal(fs.existsSync(target), false);
  store.setModelRequestRecording(root, 'session', true);
  store.setModelRequestRecording(root, 'other', true);
  const trace = { nativeId: 'private-native-id', file: '/private/session.jsonl', items: [
    { kind: 'excerpt', id: 'source', path: 'messages[1].content', sources: [{ id: 'original', role: 'tool', chars: 123 }] }
  ] };
  const raw = Buffer.from('{ "n":9007199254740993,"n":1.00e+3,"q":"\\u0041","text":"中文\\r\\n" }\r\n');
  const partial = Buffer.concat([Buffer.from('{"unfinished":"'), Buffer.from([0xf0, 0x9f])]);
  for (let i = 0; i < 55; i++) store.saveModelRequest(root, 'session', store.recordingToken(root, 'session'),
    { at: i + 100, model: 'fixture', protocol: 'openai-completions', complete: i !== 54 }, i === 54 ? partial : raw, trace);
  store.saveModelRequest(root, 'other', store.recordingToken(root, 'other'),
    { at: 1, model: 'other', protocol: 'other', complete: true }, Buffer.from('must not export'));
  // Synthetic quota-omitted row in this test-owned database; no 50 MB allocation needed.
  const dbFile = path.join(root, 'agent-inputs', 'model-requests.sqlite');
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO calls(session,at,model,protocol,bytes,complete,digest) VALUES(?,?,?,?,?,?,NULL)')
    .run('session', 200, 'oversize', 'test', 51_000_000, 1);
  db.close();

  assert.deepEqual(write(root, 'session', target), { count: 56, omitted: 1 });
  const files = unzipSync(fs.readFileSync(target));
  const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString());
  assert.equal(manifest.format, 'muster-model-requests');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.sessionId, 'session');
  assert.ok(Number.isFinite(Date.parse(manifest.exportedAt)));
  assert.equal(manifest.requests.length, 56, 'all retained records, beyond the 50-row viewer page');
  assert.equal(Object.keys(files).length, 56, '55 bodies plus manifest');
  assert.deepEqual(manifest.requests.map(r => r.at), [...Array(55)].map((_, i) => i + 100).concat(200));
  for (let i = 0; i < 55; i++) {
    const row = manifest.requests[i];
    const expected = i === 54 ? partial : raw;
    assert.deepEqual(Buffer.from(files[row.bodyFile]), expected, 'raw bytes, duplicate keys, escapes and partial UTF-8 survive');
    assert.equal(row.bytes, expected.length);
    assert.equal(row.sha256, createHash('sha256').update(expected).digest('hex'));
    assert.equal(row.complete, i !== 54);
    assert.deepEqual(row.compression, trace.items);
  }
  assert.equal(JSON.stringify(manifest).includes(trace.file), false, 'do not export private source locators');
  const omitted = manifest.requests.at(-1);
  assert.equal(omitted.omitted, true);
  assert.equal(omitted.bodyFile, null);
  assert.equal(omitted.sha256, null);
  assert.deepEqual(omitted.compression, []);
  const selected = manifest.requests[3];
  assert.deepEqual(write(root, 'session', target, selected.id), { count: 1, omitted: 0 });
  const single = unzipSync(fs.readFileSync(target));
  assert.deepEqual(JSON.parse(Buffer.from(single['manifest.json']).toString()).requests, [selected]);
  const saved = fs.readFileSync(target);
  assert.throws(() => write(root, 'other', target, selected.id), /暂无模型请求记录|No model requests/);
  assert.deepEqual(fs.readFileSync(target), saved, 'missing selection must not overwrite an existing export');
  assert.throws(() => write(root, 'session', path.join(root, 'missing', 'export.zip')));
  assert.throws(() => write(root, 'session', root), /EISDIR|EPERM|EACCES/);
  const corrupt = new DatabaseSync(dbFile);
  corrupt.prepare('UPDATE calls SET digest=? WHERE id=?').run(Buffer.alloc(32), selected.id);
  corrupt.close();
  assert.throws(() => write(root, 'session', target, selected.id), /integrity/);
  assert.deepEqual(fs.readFileSync(target), saved, 'failed integrity check must preserve the old file');
  assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith('.tmp')), [], 'failed exports clean temporary files');
  console.log('ZIP export: all pages, session/selection isolation, exact bytes, metadata, omissions, integrity and atomic failure passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
