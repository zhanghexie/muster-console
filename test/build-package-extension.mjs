import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve('.');
const dir = path.join(repo, 'resources', 'extensions', 'build-package');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-package-extension-'));
try {
  const compile = createSharedCompiler(repo, path.join(temp, 'compiled'));
  const { captureExtensionPackage, validateExtensionPackage } = await import(pathToFileURL(compile('main/extensions/extensionPackageSnapshot.ts')));
  const manifest = validateExtensionPackage(captureExtensionPackage(dir), 'build-package');
  assert.deepEqual(manifest.permissions, ['hostTools']);
  assert.equal(manifest.commandEntry, 'command.mjs');
  assert.deepEqual(manifest.surface, { kind: 'toolbar', command: 'build-package' });
  assert.deepEqual(manifest.commands.map(command => [command.id, command.handler]), [['build-package', 'build-package']]);

  // extensions-build-package.mjs exercises the toolbar's npm run build:mac command.
  // Keep that command routed through the local signing policy before packaging.
  const { scripts } = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  assert.match(scripts['build:mac'], /\bnode scripts\/build-mac\.mjs(?:\s|$)/);
  console.log('build-package-extension: ok');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
