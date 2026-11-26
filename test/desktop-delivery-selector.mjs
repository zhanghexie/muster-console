import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-delivery-selector-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { createDesktopDeliverySelector } = await import(pathToFileURL(compile('main/desktop/desktopDeliverySelector.ts')));
  let first = false, second = false, called = 0;
  const actor = Object.freeze({ sessionId: 'session', taskId: 'task', turnId: 'turn', isCurrent: () => true });
  const request = Object.freeze({ actor, requestId: 'request' });
  const context = Object.freeze({ marker: 'host-only' });
  const one = { hasScope: () => first, cua: (r, c) => { called++; assert.equal(r, request); assert.equal(c, context); return 'one-cua'; },
    win32: (a, c) => { called++; assert.equal(a, actor); assert.equal(c, context); return 'one-win32'; } };
  const two = { hasScope: () => second, cua: () => { called++; throw new Error('stale selected scope'); },
    win32: () => { called++; throw new Error('stale selected scope'); } };
  const selector = createDesktopDeliverySelector([one, two]);
  assert.throws(() => selector.cua(request, context), /one live host engine scope/);
  first = true;
  assert.equal(selector.cua(request, context), 'one-cua');
  assert.equal(selector.win32(actor, context), 'one-win32');
  second = true;
  assert.throws(() => selector.win32(actor, context), /one live host engine scope/, 'ambiguous nested scopes cannot pick an engine');
  first = false;
  assert.throws(() => selector.cua(request, context), /stale selected scope/, 'a present but stale scope cannot fall back');
  assert.equal(called, 3);
  assert.throws(() => createDesktopDeliverySelector([{ hasScope() { return true; } }]), /providers/);
  console.log('desktop delivery selection: host-only scope, ambiguity and stale scope refusal passed');
} finally { removeWorkspaceFixture(temp, 'desktop-delivery-selector-'); }
