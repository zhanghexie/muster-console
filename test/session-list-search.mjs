/**
 * 左栏会话列表过滤：名称 / 胶囊 / 摘要。
 * 运行: node test/session-list-search.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-list-search-'));
const compile = createSharedCompiler(root, tmp);

const { matchSessionListQuery } = await import(
  pathToFileURL(compile('shared/sessionListSearch.ts')).href
);

const sessions = [
  { name: '修搜索条', liveStatus: { label: '实现中', summary: 'SearchBar 接入' } },
  { name: '其他任务', liveStatus: { label: '排查中', summary: '看日志' } },
  { name: '第三个', cwd: 'E:/demo/a', liveStatus: { label: '等构建', summary: '统一搜索摘要' } }
];

assert.equal(sessions.filter((s) => matchSessionListQuery(s, '')).length, 3);
assert.equal(sessions.filter((s) => matchSessionListQuery(s, '  ')).length, 3);

assert.deepEqual(
  sessions.filter((s) => matchSessionListQuery(s, '搜索条')).map((s) => s.name),
  ['修搜索条']
);
assert.deepEqual(
  sessions.filter((s) => matchSessionListQuery(s, '排查中')).map((s) => s.name),
  ['其他任务']
);
assert.deepEqual(
  sessions.filter((s) => matchSessionListQuery(s, '统一搜索摘要')).map((s) => s.name),
  ['第三个']
);
assert.equal(matchSessionListQuery(sessions[2], 'demo/a'), true);
assert.equal(matchSessionListQuery(sessions[0], 'cursor', 'Cursor'), true);
assert.equal(matchSessionListQuery(sessions[0], 'zzzz'), false);

console.log('session-list-search: ok');
