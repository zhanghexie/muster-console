/**
 * P8：memory 写入后自动提交 docs/memory。
 * Run: node test/memory-commit.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-commit-'));
const compile = createSharedCompiler(root, tmp);
const { commitMemoryChanges } = await import(
  pathToFileURL(compile('main/git/memoryCommit.ts')).href
);

const repo = path.join(tmp, 'repo');
fs.mkdirSync(path.join(repo, 'docs', 'memory'), { recursive: true });
const git = (args, cwd = repo) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
git(['init', '-b', 'main']);
git(['config', 'user.email', 't@t']);
git(['config', 'user.name', 't']);
fs.writeFileSync(path.join(repo, 'docs', 'memory', 'MEMORY.md'), '# mem\n', 'utf8');
git(['add', '.']);
git(['commit', '-m', 'init']);

fs.appendFileSync(path.join(repo, 'docs', 'memory', 'MEMORY.md'), '\nhello\n', 'utf8');
const r = await commitMemoryChanges(repo);
assert.equal(r.ok, true, r.message);
assert.equal(r.committed, true);
assert.equal(git(['status', '--porcelain']).trim(), '');
assert.match(git(['log', '-1', '--pretty=%s']), /chore\(memory\)/);

const skip = await commitMemoryChanges(repo);
assert.equal(skip.skipped, true);

const notGit = path.join(tmp, 'plain');
fs.mkdirSync(notGit, { recursive: true });
const skipped = await commitMemoryChanges(notGit);
assert.equal(skipped.skipped, true);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] memory-commit');
