/**
 * 宿主会话 ref 解析：驱动真 SessionsService.resolveSessionRef（经 prototype.call），
 * 覆盖现行契约——statusToken 优先、sessionId/externalSessionId 双向、前缀柔性匹配与三类错误文案。
 * 前缀匹配纯函数（matchFlexibleSessionId）由 session-query.mjs 覆盖，此处只各取一例作方法层集成。
 * 自查：把 statusToken 分支删掉或改错误文案，本文件应转红。
 * Run: node test/session-ref-resolve.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const Module = require('node:module');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename
}).outputText, filename);
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir(), isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  return originalLoad.apply(this, arguments);
};
const { SessionsService } = require(path.join(repo, 'src/main/sessions.ts'));

const rows = [
  { id: 'aaaaaaaa-1111', externalSessionId: 'cursor-bbb', statusToken: 'tok-1' },
  { id: 'aaaaaaaa-2222', externalSessionId: 'cursor-bbe' },
  { id: 'cccccccc-3333', externalSessionId: 'claude-ddd' }
];
const resolve = (ref) => SessionsService.prototype.resolveSessionRef.call({ sessions: rows }, ref);

// statusToken 通道：命中且优先于 sessionId
assert.deepEqual(resolve({ statusToken: 'tok-1' }), { id: 'aaaaaaaa-1111', matchedBy: 'statusToken' });
assert.deepEqual(resolve({ statusToken: 'tok-1', sessionId: 'cccccccc-3333' }), { id: 'aaaaaaaa-1111', matchedBy: 'statusToken' });
assert.throws(() => resolve({ statusToken: 'nope' }), /MUSTER_STATUS_URL/, '无效 token 的报错应指向 STATUS_URL 通道');

// sessionId：精确命中 / 恰是某个 externalSessionId（旧调用兼容，反查）
assert.deepEqual(resolve({ sessionId: 'aaaaaaaa-1111' }), { id: 'aaaaaaaa-1111', matchedBy: 'sessionId' });
assert.deepEqual(resolve({ sessionId: 'cursor-bbb' }), { id: 'aaaaaaaa-1111', matchedBy: 'externalSessionId' });

// 前缀柔性（≥8 字符才参与）：唯一前缀命中；歧义前缀明确报错（不猜第一个）
assert.deepEqual(resolve({ sessionId: 'cccccccc' }), { id: 'cccccccc-3333', matchedBy: 'sessionId' });
assert.throws(() => resolve({ sessionId: 'aaaaaaaa' }), /前缀不唯一/);

// 找不到：现行文案引导走 STATUS_URL（旧镜像断言的 /MUSTER_SESSION_ID/ 报文已废弃）
assert.throws(() => resolve({ sessionId: 'missing' }), /会话不存在/);
assert.throws(() => resolve({ sessionId: 'missing' }), /STATUS_URL/);

// externalSessionId 通道
assert.deepEqual(resolve({ externalSessionId: 'claude-ddd' }), { id: 'cccccccc-3333', matchedBy: 'externalSessionId' });
assert.throws(() => resolve({ externalSessionId: 'missing' }), /externalSessionId/);

// 全空：要求 statusToken（推荐）或 sessionId/externalSessionId
assert.throws(() => resolve({}), /需要 statusToken/);

console.log('session-ref-resolve: ok');
