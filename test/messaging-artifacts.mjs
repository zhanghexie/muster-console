import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { createMusterOutboundArtifact, materializeOutboundArtifact, releaseOutboundArtifact } from '../src/main/messaging/dsh-im/src/channels/shared/semantic/artifact.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-im-artifacts-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
const { deliverMessagingArtifacts } = await import(pathToFileURL(compile('main/messaging/sessionArtifacts.ts')).href);
function fixture() {
  const workspace = fs.mkdtempSync(path.join(temp, 'workspace-'));
  const file = path.join(workspace, 'result.pdf');
  fs.writeFileSync(file, '%PDF-synthetic-result');
  const message = { id: 'turn-one', role: 'assistant', parts: [{ kind: 'text', text: '[result](result.pdf)' }],
    ts: Date.now() - 100, finishedAt: Date.now() + 1,
    turnChanges: { id: 'snapshot', state: 'ready', files: [{ path: 'result.pdf', kind: 'added', origin: 'native-tool' }], warnings: [] } };
  const artifacts = [];
  return { workspace, file, message, artifacts, options: { workspace, message, sessionId: 'session-one', turnId: 'turn-one',
    signal: new AbortController().signal, createArtifact: createMusterOutboundArtifact,
    releaseArtifact: releaseOutboundArtifact, onArtifact: artifact => { artifacts.push(artifact); } } };
}

test('actual provider artifact materializes an immutable snapshot of a linked current-turn result', async () => {
  const { file, options, artifacts } = fixture();
  try {
    assert.equal(await deliverMessagingArtifacts(options), 1);
    fs.writeFileSync(file, 'later content');
    const materialized = await materializeOutboundArtifact(artifacts[0]);
    assert.equal(materialized.bytes.toString(), '%PDF-synthetic-result');
    assert.equal(materialized.fileName, 'result.pdf');
    assert.equal(materialized.mediaType, 'application/pdf');
    assert.equal(artifacts[0].origin.sessionId, 'session-one');
    assert.equal(artifacts[0].origin.turn, 'turn-one');
  } finally { artifacts.forEach(releaseOutboundArtifact); }
});

test('foreign turns, unobserved files, provider-only claims and fenced examples do not become files', async () => {
  for (const change of [
    fixture => { fixture.options.turnId = 'other-turn'; },
    fixture => { fixture.message.turnChanges.files = []; },
    fixture => { fixture.message.turnChanges.files[0].origin = 'provider-diff'; },
    fixture => { fixture.message.parts[0].text = '```md\n[result](result.pdf)\n```'; },
    fixture => { fixture.message.turnChanges.state = 'collecting'; },
    fixture => { fixture.message.parts[0].text = '[external](https://example.invalid/result.pdf)'; }
  ]) {
    const value = fixture(); change(value);
    assert.equal(await deliverMessagingArtifacts(value.options), 0);
    assert.equal(value.artifacts.length, 0);
  }
});

test('traversal, symlinks and post-turn modifications never read an unrelated file', async () => {
  const value = fixture();
  const secret = path.join(temp, 'outside.txt'); fs.writeFileSync(secret, 'unrelated-secret');
  value.message.parts[0].text = '[outside](../outside.txt)';
  value.message.turnChanges.files = [{ path: '../outside.txt', kind: 'added', origin: 'native-tool' }];
  assert.equal(await deliverMessagingArtifacts(value.options), 0);
  if (process.platform !== 'win32') {
    const linked = fixture();
    fs.unlinkSync(linked.file); fs.symlinkSync(secret, linked.file);
    await assert.rejects(deliverMessagingArtifacts(linked.options), /outside|location/);
    assert.equal(linked.artifacts.length, 0);
  }
  const changed = fixture(); changed.message.finishedAt = Date.now() - 10000;
  await assert.rejects(deliverMessagingArtifacts(changed.options), /changed/);
  assert.equal(changed.artifacts.length, 0);
});

test('oversize results and cancelled transfers fail before returning successful delivery', async () => {
  const value = fixture(); fs.truncateSync(value.file, 20 * 1024 * 1024 + 1);
  value.message.finishedAt = Date.now() + 1;
  await assert.rejects(deliverMessagingArtifacts(value.options), /limit/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(deliverMessagingArtifacts({ ...fixture().options, signal: controller.signal }), { name: 'AbortError' });
  const failed = fixture(); let released;
  failed.options.releaseArtifact = artifact => { released = artifact; releaseOutboundArtifact(artifact); };
  failed.options.onArtifact = () => { throw new Error('delivery rejected'); };
  await assert.rejects(deliverMessagingArtifacts(failed.options), /rejected/);
  await assert.rejects(materializeOutboundArtifact(released), /invalid/);
});
