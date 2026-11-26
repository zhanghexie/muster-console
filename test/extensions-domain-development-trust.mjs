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
console.log('extensions-development-trust: ok');


