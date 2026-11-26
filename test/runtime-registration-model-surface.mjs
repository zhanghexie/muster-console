/** Manifest registration is available only through the scheduler runtime domain. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compile = createSharedCompiler(root, fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-model-surface-')));
const load = async relative => import(pathToFileURL(compile(relative)).href);
const { TOOL_DEFS } = await load('main/capabilities/catalog/registry.ts');
const { RUNTIMES_RUN_DOMAIN } = await load('main/capabilities/catalog/runTools.ts');
const { residentHostToolIds } = await load('shared/toolDiscovery.ts');
const { listHostToolIds } = await load('shared/hostTools/index.ts');
const hidden = ['runtimes.registerDriver', 'runtimes.driverTrustStatus'];
for (const name of hidden) {
  assert.equal(TOOL_DEFS.some(def => def.name === name), false, `${name} absent from catalog`);
  for (const role of ['scheduler', 'worker']) {
    assert.equal(residentHostToolIds(role).includes(name), false, `${name} absent from ${role}`);
  }
  for (const preset of ['gui-full', 'pty-allowlist', 'acp-subset']) {
    assert.equal(listHostToolIds(preset).includes(name), false, `${name} absent from ${preset}`);
  }
}
assert.deepEqual(RUNTIMES_RUN_DOMAIN.def.parameters.properties.action.enum,
  RUNTIMES_RUN_DOMAIN.actions.map(entry => entry.action));
assert.equal(RUNTIMES_RUN_DOMAIN.actions.some(entry => entry.action === 'register'), true);
assert.equal(residentHostToolIds('scheduler').includes('runtimes.run'), true);
assert.equal(residentHostToolIds('worker').includes('runtimes.run'), false);
assert.equal(RUNTIMES_RUN_DOMAIN.actions.some(entry => entry.action === 'list'), true);
assert.equal(RUNTIMES_RUN_DOMAIN.actions.some(entry => entry.action === 'preflight'), true);
const skill = fs.readFileSync(path.join(root, 'resources/skills/runtimes/SKILL.md'), 'utf8');
assert.match(skill, /^\| register \|/m);
assert.doesNotMatch(skill, /temporarily disabled|saved custom entries/i);
console.log('runtime-registration-model-surface: declarative registration in the scheduler domain');
