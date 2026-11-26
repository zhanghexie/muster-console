/** Run the production post-merge gates in a local, offline empty npm project. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merge npm 中文 & fixture-'));
try {
  const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
  const { runPostMergeGates } = await import(pathToFileURL(compile('main/git/mergeIsolate.ts')).href);
  const repo = path.join(tmp, 'project & 中文'); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'post-merge-fixture', version: '1.0.0', scripts: { typecheck: 'node -e "process.exit(0)"' } }));
  fs.writeFileSync(path.join(repo, '.npmrc'), 'offline=true\naudit=false\nfund=false\nignore-scripts=true\n');
  const result = await runPostMergeGates(repo, ['package.json'], {});
  assert.deepEqual(result.gates, { npmInstall: 'ok', typecheck: 'ok' }, JSON.stringify(result));
  assert.deepEqual(result.warnings, []);
  assert.ok(fs.existsSync(path.join(repo, 'package-lock.json')));
  const skipped = await runPostMergeGates(repo, ['README.md'], { skipTypecheck: true });
  assert.equal(skipped.gates.npmInstall, 'skipped');
  console.log('ok post-merge npm install/typecheck (real offline npm, Unicode/metacharacter cwd)');
} finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
