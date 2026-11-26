import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-domain-navigation-'));
const compile = createSharedCompiler(repo, path.join(repo, '.tmp', 'extensions-navigation-compile'));
const { ExtensionNavigationStore } = await import(pathToFileURL(compile('main/extensions/extensionNavigation.ts')));
const { parseNavigation } = await import(pathToFileURL(compile('shared/extensionNavigation.ts')));
const store = new ExtensionNavigationStore(path.join(tmp, 'navigation.json'));
const first = store.snapshot('ws', 'root', 0, true, [{ extensionId: 'bookshelf', title: '书架' }]);
const domainNode = first.nodes.find(node => node.kind === 'extension' && node.extensionId === 'bookshelf');
assert.equal(domainNode?.viewId, 'main');
assert.equal(domainNode?.extensionScope, 'global');
assert.equal(parseNavigation([{ id: 'old', kind: 'extension', title: '旧', parentId: null, extensionId: 'bookshelf', viewId: 'main', extensionRuntime: 'domain' }]), null, 'retired runtime markers are rejected instead of being interpreted');
const second = store.snapshot('ws', 'root', 0, true, [{ extensionId: 'bookshelf', title: '书架' }]);
assert.equal(second.nodes.filter(node => node.kind === 'extension').length, 1);
console.log('extensions-navigation: ok');


