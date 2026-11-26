/**
 * Git 仓库搜索：名/路径子串，换皮前后行为不变。
 * 运行: node test/git-repo-search.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-repo-search-'));
const compile = createSharedCompiler(root, tmp);

const { repoMatchesSearchQuery } = await import(
  pathToFileURL(compile('shared/gitRepoSearch.ts')).href
);

const repos = [
  { name: 'metaagent-workbench', path: 'E:/Projects/metaagent-workbench' },
  { name: 'demo-frontend', path: 'E:/demo/frontend' },
  { name: 'demo-backend', path: 'E:/demo/backend' }
];

assert.equal(repos.filter((r) => repoMatchesSearchQuery(r, '')).length, 3);
assert.equal(repos.filter((r) => repoMatchesSearchQuery(r, '  ')).length, 3);

assert.deepEqual(
  repos.filter((r) => repoMatchesSearchQuery(r, 'frontend')).map((r) => r.name),
  ['demo-frontend']
);
assert.deepEqual(
  repos.filter((r) => repoMatchesSearchQuery(r, 'BACKEND')).map((r) => r.name),
  ['demo-backend']
);
assert.deepEqual(
  repos.filter((r) => repoMatchesSearchQuery(r, 'Projects/meta')).map((r) => r.name),
  ['metaagent-workbench']
);
assert.equal(repoMatchesSearchQuery(repos[0], 'zzzz'), false);

console.log('git-repo-search: ok');
