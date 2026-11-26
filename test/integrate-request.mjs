/**
 * 请调度合入隔离 worktree 的协调文案。
 * Run: node test/integrate-request.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'integrate-request-'));

const entry = path.join(root, 'src', 'shared', 'integrateRequest.ts');
const { outputText } = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: entry
});
const out = path.join(tmp, 'integrateRequest.mjs');
fs.writeFileSync(out, outputText, 'utf8');
const { buildIntegrateRequestMessage } = await import(pathToFileURL(out).href);

{
  const msg = buildIntegrateRequestMessage({
    sessionId: '45342b0f-aaaa',
    sessionName: '修登录',
    branch: 'ao/45342b0f'
  });
  assert.match(msg, /【请合入隔离 worktree】/);
  assert.match(msg, /修登录（45342b0f-aaaa）/);
  assert.match(msg, /ao\/45342b0f/);
  assert.match(msg, /sessions_integrate/);
  assert.doesNotMatch(msg, /备注：/);
}

{
  const msg = buildIntegrateRequestMessage({
    sessionId: 'id-1',
    sessionName: '  ',
    branch: 'ao/x',
    note: '  已过目  '
  });
  assert.match(msg, /会话 id-1（id-1）/);
  assert.match(msg, /备注：已过目/);
}

{
  const msg = buildIntegrateRequestMessage({ sessionId: 'task', sessionName: '跨根任务', branch: 'ao/task',
    worktreeGroups: ['first', 'second'].map(rootId => ({ groupId: `group-${rootId}`, rootId, path: `E:/tasks/${rootId}`,
      sourcePath: `D:/sources/${rootId}`, branch: 'ao/task', repos: [{ relativePath: 'Plugins/A', path: `E:/tasks/${rootId}/Plugins/A`, branch: 'ao/nested' }] })) });
  assert.match(msg, /来源 first.*D:\/sources\/first.*E:\/tasks\/first/);
  assert.match(msg, /来源 second.*D:\/sources\/second.*E:\/tasks\/second/);
  assert.equal(msg.match(/嵌套仓 Plugins\/A/g).length, 2, 'same nested relative path in two roots stays distinct');
  assert.match(msg, /失败保留前序成果/); assert.match(msg, /可归档清理全部任务树/);
  assert.doesNotMatch(msg, /停会话、删 worktree/, 'multi-group message matches the currently retained cleanup behavior');
}
assert.ok(path.resolve(tmp).startsWith(`${path.resolve(os.tmpdir())}${path.sep}integrate-request-`));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] integrate-request');
