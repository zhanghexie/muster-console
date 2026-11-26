import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-domain-dev-trust-'));
const compile = createSharedCompiler(repo, path.join(repo, '.tmp', 'extensions-development-trust-compile'));
const { ExtensionDevelopmentTrustStore } = await import(pathToFileURL(compile('main/extensions/extensionDevelopmentTrust.ts')).href);
const subject = { extensionId: 'bookshelf', scope: 'global', directory: path.join(tmp, 'bookshelf'), fingerprint: `package-extension:${'a'.repeat(64)}` };

const store = new ExtensionDevelopmentTrustStore(tmp);
assert.equal(store.isTrusted(subject), false);
store.trust(subject, 'trusted-once');
assert.equal(store.isTrusted(subject), true);
store.clearOnce();
assert.equal(store.isTrusted(subject), false);
store.trust(subject, 'trusted-persistent');
assert.equal(store.isTrusted(subject), true);
const restored = new ExtensionDevelopmentTrustStore(tmp);
assert.equal(restored.isTrusted(subject), true);
assert.equal(restored.isTrusted({ ...subject, fingerprint: `package-extension:${'b'.repeat(64)}` }), true, 'persistent trust follows the development directory across source edits');
assert.equal(restored.listPersistent().length, 1);
restored.revoke(subject);
assert.equal(restored.isTrusted(subject), false);
assert.throws(() => restored.trust({ ...subject, fingerprint: 'package-extension:bad' }, 'trusted-persistent'), /fingerprint/);
assert.throws(() => restored.trust({ ...subject, directory: 'relative' }, 'trusted-persistent'), /absolute/);

const changed = { ...subject, fingerprint: `package-extension:${'b'.repeat(64)}` };
assert.equal(restored.canRun(subject, 'workspace'), false);
restored.authorizeActivation(subject, ['workspace']);
const activated = new ExtensionDevelopmentTrustStore(tmp);
assert.equal(activated.canRun(subject, 'workspace'), true, 'explicit activation survives a restart');
assert.equal(activated.canRun(subject, 'other-workspace'), false, 'activation applies to the selected workspace');
assert.equal(activated.canRun(changed, 'workspace'), false, 'a replacement package needs activation');
assert.equal(activated.isTrusted(subject), false, 'activation does not grant MCP consent');
assert.deepEqual(JSON.parse(fs.readFileSync(activated.filePath(), 'utf8')).entries, [], 'older hosts only read the legacy consent entries');
const development = new ExtensionDevelopmentTrustStore(tmp, undefined, true);
assert.equal(development.canRun(changed, 'workspace'), true, 'an explicitly enabled development directory supports source edits');
assert.equal(development.canRun({ ...changed, directory: path.join(tmp, 'other') }, 'workspace'), false);
assert.equal(development.isTrusted(changed), false);
console.log('extensions-development-trust: ok');


