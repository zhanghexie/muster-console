import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-list-service-'));
try {
  const compile = createSharedCompiler(process.cwd(), temp);
  const { DesktopListService } = await import(pathToFileURL(compile('main/desktop/listService.ts')));
  let current = true, version = 1, resolveWindows;
  const actor = { sessionId: 'session', taskId: 'task', isCurrent: () => current };
  const display = { list: () => ({ surfaces: [{ surfaceId: `display-${version}` }], omitted: 0 }) };
  const inventory = { runtime: 'windows', observations: [], complete: true, omitted: 0, limitations: [], capabilities: {} };
  const service = new DesktopListService(display, () => new Promise(resolve => { resolveWindows = resolve; }));
  const pending = service.list(actor);
  version = 2; resolveWindows(inventory);
  assert.deepEqual(await pending, { displays: { surfaces: [{ surfaceId: 'display-2' }], omitted: 0 }, windows: { ok: true, data: inventory } });
  const obsolete = service.list(actor); current = false; resolveWindows(inventory);
  await assert.rejects(obsolete, /no longer current/); current = true;
  const unsupported = new DesktopListService(display, async () => { throw new Error('Wayland adapter unavailable'); });
  assert.deepEqual((await unsupported.list(actor)).windows, { ok: false, error: 'Wayland adapter unavailable' });
  const controller = new AbortController();
  const cancelling = service.list(actor, controller.signal); controller.abort(); resolveWindows(inventory);
  await assert.rejects(cancelling, /abort/i);
  assert.throws(() => new DesktopListService(display, null), /adapters/);
  await assert.rejects(service.list({ ...actor, taskId: '' }), /caller/);
  console.log('desktop list: current caller, degraded windows and fresh display metadata passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
