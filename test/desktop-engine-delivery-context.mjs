import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-engine-context-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { desktopEngineDeliveryFromContext } = await import(pathToFileURL(compile('main/desktop/globalEngineDelivery.ts')));
  assert.equal(desktopEngineDeliveryFromContext({}), undefined);
  const delivery = { stager: { stage() {}, bindOutput() {}, discard() {} }, issuer: { withVerifiedEvent() {} }, inspectMarker() {} };
  const ctx = { delivery, desktopEngineDelivery() { return this.delivery; } };
  assert.equal(desktopEngineDeliveryFromContext(ctx), delivery, 'the same host-owned evidence authority is passed to the engine');
  for (const bad of [null, undefined, {}, { ...delivery, stager: {} }, { ...delivery, issuer: {} }, { ...delivery, inspectMarker: null }]) {
    assert.throws(() => desktopEngineDeliveryFromContext({ desktopEngineDelivery: () => bad }), /dependencies are invalid/);
  }
  assert.throws(() => desktopEngineDeliveryFromContext({ desktopEngineDelivery: () => { throw new Error('host unavailable'); } }), /host unavailable/);
  console.log('desktop engine delivery context: host identity, invalid configuration and no silent fallback passed');
} finally { removeWorkspaceFixture(temp, 'desktop-engine-context-'); }
