import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compile = createSharedCompiler(repo, path.join(repo, '.tmp', 'extensions-bridge-registry-compile'));
const { isExtensionPanelMethod } = await import(pathToFileURL(compile('shared/extensions.ts')));
const sdk = fs.readFileSync(path.join(repo, 'src', 'main', 'extensions', 'sdk', 'extension-sdk.js'), 'utf8');

for (const method of ['tool', 'ui.confirm', 'agent.send', 'llm.chat', 'commands.execute', 'domain.command', 'storage.keys', 'tasks.thumbnail', 'files.pathAccess']) {
  assert.equal(isExtensionPanelMethod(method), true, `registered extension method: ${method}`);
}
for (const method of ['domain.unknown', 'constructor']) {
  assert.equal(isExtensionPanelMethod(method), false, `unregistered extension method: ${method}`);
}
for (const method of [...sdk.matchAll(/call\('([^']+)'/g)].map(match => match[1])) {
  assert.equal(isExtensionPanelMethod(method), true, `extension SDK method is registered: ${method}`);
}
console.log('extensions-bridge-registry: ok');
