import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-semantic-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { DesktopSemanticRefs } = await import(pathToFileURL(compile('main/desktop/semanticRefs.ts')));
  let now = 1000;
  const refs = new DesktopSemanticRefs(() => now);
  const identity = { surfaceId: 'surface', surfaceGeneration: 'generation', semanticRevision: 'tree-1' };
  const first = refs.create(identity, [{ backendNode: 'a' }, { backendNode: 'b' }], 100);
  assert.deepEqual(refs.resolve(first.snapshotId, first.refs[0], identity), { backendNode: 'a' });
  for (const changed of [{ ...identity, surfaceId: 'other' }, { ...identity, surfaceGeneration: 'new' }, { ...identity, semanticRevision: 'tree-2' }]) {
    assert.throws(() => refs.resolve(first.snapshotId, first.refs[0], changed), /Stale/);
  }
  const second = refs.create(identity, [{ backendNode: 'a' }], 100);
  assert.throws(() => refs.resolve(second.snapshotId, first.refs[0], identity), /Stale/);
  now = 1100;
  assert.throws(() => refs.resolve(first.snapshotId, first.refs[0], identity), /Stale/);
  const next = refs.create(identity, [1], 1);
  refs.revokeSurface(identity.surfaceId);
  assert.throws(() => refs.resolve(next.snapshotId, next.refs[0], identity), /Stale/);
  for (const ttl of [0, 120001, 1.5, NaN]) assert.throws(() => refs.create(identity, [], ttl), /Invalid/);
  assert.throws(() => refs.create({ ...identity, semanticRevision: 1 }, [], 1), /Invalid/);
  assert.throws(() => refs.create(identity, Array(1001), 1), /Invalid/);
  for (let i = 0; i < 100; i++) refs.create(identity, [], 2);
  assert.throws(() => refs.create(identity, [], 2), /capacity/);
  now += 2;
  assert.doesNotThrow(() => refs.create(identity, [], 2));
  console.log('desktop semantic refs: expiry, tree revision, surface reuse and bounded capacity passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
