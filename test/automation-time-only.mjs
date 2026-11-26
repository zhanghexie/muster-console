import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-time-only-'));
try {
  const compile = createSharedCompiler(process.cwd(), tmp);
  const load = file => import(pathToFileURL(compile(file)).href);
  const { SERVICES_TOOL_DEFS } = await load('main/capabilities/catalog/services.ts');
  const { assertToolArguments } = await load('main/capabilities/schemaValidation.ts');
  const { servicesHost } = await load('main/capabilities/hosts/services.ts');
  const time = { id: 't', name: 'timer', workspaceId: 'w' };
  const writes = [];
  const ctx = { resolveBubbleWorkspaceId: () => 'w', runtimes: { get: () => ({ enabled: true }) }, tasks: {
    list: () => [time], get: () => time,
    create: data => { writes.push(['create', data]); return data; },
    update: (id, data) => { writes.push(['update', id, data]); return data; },
    enable: id => writes.push(['enable', id]), disable: id => writes.push(['disable', id]),
    delete: id => writes.push(['delete', id]), runNow: async id => writes.push(['runNow', id])
  } };
  const base = { name: 'timer', prompt: 'work', runtime: 'pi', schedule: { kind: 'daily', time: '09:00' } };
  for (const [action, args] of [['create', base], ['update', { automationId: 't', prompt: 'update' }]]) {
    const schema = SERVICES_TOOL_DEFS.find(d => d.name === `automations.${action}`).parameters;
    assert.equal(Object.hasOwn(schema.properties, 'trigger'), false);
    assertToolArguments(schema, args, action);
    assert.throws(() => assertToolArguments(schema, { ...args, trigger: { kind: 'webhook' } }, action), /Invalid parameters/);
  }
  assert.deepEqual(servicesHost['automations.list'](ctx).automations.map(t => t.id), ['t']);
  await servicesHost['automations.create'](ctx, base);
  await servicesHost['automations.update'](ctx, { automationId: 't', prompt: 'update' });
  await servicesHost['automations.setEnabled'](ctx, { automationId: 't', enabled: false });
  assert.deepEqual(writes.map(w => w[0]), ['create', 'update', 'disable']);
  assert.ok(!Object.hasOwn(writes[0][1], 'trigger'));
  console.log('automation-time-only: time-only schema and actions passed');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
