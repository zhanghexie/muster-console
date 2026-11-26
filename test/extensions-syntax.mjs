import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-syntax-'));
try {
  const compile = createSharedCompiler(repo, path.join(temp, 'compiled'));
  const { captureExtensionPackage } = await import(pathToFileURL(compile('main/extensions/extensionPackageSnapshot.ts')));
  const { checkExtensionPackageSyntax } = await import(pathToFileURL(compile('main/extensions/extensionSyntax.ts')));
  const { ExtensionReviewStore, ExtensionReviewCoordinator } = await import(pathToFileURL(compile('main/extensions/extensionReview.ts')));
  const dir = path.join(temp, 'demo'), marker = path.join(temp, 'should-not-exist');
  const manifest = entry => ({ id: 'demo', name: 'Demo', scope: 'global', surface: { kind: 'toolbar', command: 'run' }, commandEntry: entry, commands: [{ id: 'run', title: 'Run', handler: 'run' }], data: { workspace: true, shared: false }, permissions: ['data'] });
  fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest('main.mjs')));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, 'main.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed'); export const ok = true;`);
  fs.writeFileSync(path.join(dir, 'nested', 'helper.js'), 'export const result = 1;');
  fs.writeFileSync(path.join(dir, 'legacy.cjs'), '#!/usr/bin/env node\nreturn 1;');
  await checkExtensionPackageSyntax(captureExtensionPackage(dir));
  assert.equal(fs.existsSync(marker), false, 'syntax checking must not execute package code');

  fs.unlinkSync(path.join(dir, 'package.json'));
  await checkExtensionPackageSyntax(captureExtensionPackage(dir));
  assert.equal(fs.existsSync(marker), false, 'browser .js modules are valid without a Node module package');
  // A declared Node entry stays strict: .mjs is always parsed as an ES module,
  // so sloppy-mode-only syntax (with) is a syntax error even though it is valid CJS.
  fs.writeFileSync(path.join(dir, 'strict.mjs'), 'with ({}) {}\n');
  fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest('strict.mjs')));
  await assert.rejects(checkExtensionPackageSyntax(captureExtensionPackage(dir)), /syntax error.*strict\.mjs/i, 'declared Node entries must match their actual module format');
  fs.unlinkSync(path.join(dir, 'strict.mjs'));
  fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest('main.mjs')));

  fs.writeFileSync(path.join(dir, 'nested', 'helper.js'), 'export const result = ;');
  let reviews = 0;
  const review = new ExtensionReviewCoordinator(new ExtensionReviewStore(path.join(temp, 'review.json')), path.join(temp, 'packages'), async () => { reviews++; return { approved: true }; });
  await assert.rejects(review.submit({ workspaceId: 'a', id: 'demo', directory: dir }), /syntax error.*nested\/helper\.js/i);
  assert.equal(reviews, 0, 'invalid code must not reach safety review');
  assert.equal(fs.existsSync(marker), false);

  fs.writeFileSync(path.join(dir, 'nested', 'helper.js'), 'export const result = 1;');
  assert.equal((await review.submit({ workspaceId: 'a', id: 'demo', directory: dir })).status, 'approved');
  assert.equal(reviews, 1);
  assert.equal(fs.existsSync(marker), false, 'reviewing must not execute package code');

  // A manifest carrying a removed interface field is rejected before safety review.
  const malformed = JSON.parse(fs.readFileSync(path.join(dir, 'extension.json'), 'utf8'));
  malformed.background = { entry: 'main.mjs' };
  fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(malformed));
  await assert.rejects(review.submit({ workspaceId: 'a', id: 'demo', directory: dir }), /未知字段|已移除/);
  assert.equal(reviews, 1, 'a malformed manifest must not reach review');
  fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest('main.mjs')));

  fs.writeFileSync(path.join(dir, 'legacy.cjs'), 'const = ;');
  await assert.rejects(checkExtensionPackageSyntax(captureExtensionPackage(dir)), /syntax error.*legacy\.cjs/i);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(checkExtensionPackageSyntax(captureExtensionPackage(dir), cancelled.signal), /cancelled/);
  console.log('extensions-syntax: ok');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }