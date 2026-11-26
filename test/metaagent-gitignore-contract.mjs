/** The scaffold ignores transient workflow snapshots while leaving authored workflows trackable. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-gitignore-'));
try {
  const workspace = path.join(temporary, 'workspace');
  fs.mkdirSync(workspace);
  const compile = createSharedCompiler(process.cwd(), path.join(temporary, 'compiled'));
  const { ensureMetaAgentScaffold } = await import(pathToFileURL(compile('main/metaAgent/scaffold.ts')));
  const { path: scaffold } = ensureMetaAgentScaffold(workspace);
  const ignoreRules = fs.readFileSync(path.join(scaffold, '.gitignore'), 'utf8');
  assert.ok(ignoreRules.split(/\r?\n/).includes('workflows/**/.exec-*.mjs'));

  const gitConfig = ['-c', 'core.excludesFile=' + path.join(temporary, 'empty-gitignore')];
  fs.writeFileSync(path.join(temporary, 'empty-gitignore'), '');
  execFileSync('git', [...gitConfig, 'init', '--quiet'], { cwd: workspace });
  const scenarios = [
    ['.exec-abcd1234-run-7f3a.mjs', 0],
    ['.exec-validate-abcd1234-xyz.mjs', 0],
    ['run.mjs', 1],
    ['WORKFLOW.md', 1]
  ];
  for (const [name, expected] of scenarios) {
    const file = '.muster/workflows/demo/' + name;
    const result = spawnSync('git', [...gitConfig, 'check-ignore', '-q', '--', file], { cwd: workspace, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, expected, result.stderr || file);
  }
  console.log('workflow gitignore: transient snapshots are ignored and authored files are trackable');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
