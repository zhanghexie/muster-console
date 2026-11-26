/** 实际文件入口/媒体处理：多根身份、旧兼容、过期返回与源根删除保护。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'workspace-file-access-'));
try {
  const electron = path.join(tmp, 'node_modules/electron');
  fs.mkdirSync(electron, { recursive: true });
  fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', type: 'module', main: 'index.mjs' }));
  fs.writeFileSync(path.join(electron, 'index.mjs'), 'export const protocol = {};');
  const compile = createSharedCompiler(repo, tmp);
  const { withWorkspaceFileTarget, assertNoSourceRootDeletion } = await import(pathToFileURL(compile('main/workspaceFileAccess.ts')).href);
  const { isOutsideWorkspaceRootsError, isOutsideWorkspaceRootsResult } = await import(pathToFileURL(compile('shared/errors.ts')).href);
  const { readText, writeText } = await import(pathToFileURL(compile('main/workspaceFs.ts')).href);
  const { buildWorkspaceFileUrl, buildWorkspaceMediaUrl } = await import(pathToFileURL(compile('shared/mediaKinds.ts')).href);
  const { handleWorkspaceMediaRequest } = await import(pathToFileURL(compile('main/workspaceFsProtocol.ts')).href);
  const a = path.join(tmp, 'a');
  const b = path.join(tmp, 'b');
  for (const dir of [a, b]) fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const name = 'src/同名 #?.txt'.replace('?', '问'); // Windows 不允许 ? 文件名；URL 编解码另外在 media-kinds 覆盖。
  fs.writeFileSync(path.join(a, name), 'A');
  fs.writeFileSync(path.join(b, name), 'B');
  const workspace = { id: 'Mixed/工作区 &', path: a, name: 'multi', openedAt: 0, controlRoot: a, defaultRootId: 'a', rootsRevision: 0,
    roots: [{ id: 'a', path: a }, { id: 'b /中文&', path: b }, { id: 'nested', path: path.join(a, 'src') }] };
  let config = { workspaces: [workspace], activeWorkspaceId: workspace.id };
  const get = () => config;
  const refA = { workspaceId: workspace.id, rootId: 'a', relativePath: name };
  const refB = { ...refA, rootId: 'b /中文&' };
  const read = (target, file = '') => withWorkspaceFileTarget(get, target, file, (root, ref) => readText(root, ref.relativePath));
  assert.equal((await read(refA)).content, 'A');
  assert.equal((await read(refB)).content, 'B');
  await assert.rejects(read(workspace.id, name), /selection required/);
  assert.equal((await read(workspace.id, path.join(b, name))).content, 'B', 'legacy absolute paths locate an explicit registered root');
  // 区外绝对路径：结构化错误（reason=outside-workspace-roots），message 保持原文兜底（files-panel F-02）
  await assert.rejects(
    withWorkspaceFileTarget(get, workspace.id, path.join(fs.realpathSync(os.tmpdir()), 'metaagent-outside-probe.txt'), async () => 'x'),
    (e) => e instanceof Error && e.message === 'path outside workspace roots' && isOutsideWorkspaceRootsError(e),
    '区外路径必须抛携带 reason 的结构化错误'
  );
  assert.equal(isOutsideWorkspaceRootsResult({ error: '路径在所有源根之外', reason: 'outside-workspace-roots' }), true, '结构化 reason 判定，不依赖英文文案');
  assert.equal(isOutsideWorkspaceRootsResult({ error: 'path outside workspace roots' }), true, '英文原文案兜底（旧契约兼容）');
  assert.equal(isOutsideWorkspaceRootsResult({ error: 'source folder selection required' }), false, '其他错误不判区外');
  assert.equal(isOutsideWorkspaceRootsResult({ error: 'x', reason: 'other-reason' }), false, '未知 reason 不判区外');
  await assert.rejects(read({ ...refB, rootId: 'removed' }), /source folder not found/);
  await assert.rejects(read({ rootId: 'a', relativePath: name }), /invalid workspace file reference/);
  await assert.rejects(assertNoSourceRootDeletion(config, path.join(a, 'src')), /cannot delete/);
  await assert.rejects(assertNoSourceRootDeletion(config, b), /cannot delete/);
  await assertNoSourceRootDeletion(config, path.join(a, name));
  await withWorkspaceFileTarget(get, refB, '', (root, ref) => writeText(root, ref.relativePath, 'B changed'));
  assert.equal(fs.readFileSync(path.join(a, name), 'utf8'), 'A');
  assert.equal(fs.readFileSync(path.join(b, name), 'utf8'), 'B changed');
  await assert.rejects(withWorkspaceFileTarget(get, refA, '', async () => {
    config = { ...config, workspaces: [{ ...workspace, rootsRevision: 1 }] };
    return 'stale content';
  }), /source folders changed/);
  config = { ...config, workspaces: [workspace] };
  const ctx = { config: { get } };
  const url = buildWorkspaceFileUrl(refB);
  const response = await handleWorkspaceMediaRequest(ctx, url, new Request(url));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'B changed');
  config = { workspaces: [{ ...workspace, id: 'multi' }], activeWorkspaceId: 'multi' };
  const ambiguousUrl = buildWorkspaceMediaUrl('multi', name);
  assert.equal((await handleWorkspaceMediaRequest(ctx, ambiguousUrl, new Request(ambiguousUrl))).status, 403, 'a valid legacy workspace ID still requires source folder selection');
  config = { workspaces: [workspace], activeWorkspaceId: workspace.id };
  const removedUrl = buildWorkspaceFileUrl({ ...refB, rootId: 'removed' });
  assert.equal((await handleWorkspaceMediaRequest(ctx, removedUrl, new Request(removedUrl))).status, 403);
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret');
  fs.symlinkSync(outside, path.join(a, 'escape'), 'junction');
  const alias = path.join(tmp, 'b-alias'); fs.symlinkSync(b, alias, 'junction');
  const fresh = await withWorkspaceFileTarget(() => config, workspace.id, path.join(alias, 'new.txt'),
    (root, ref) => writeText(root, ref.relativePath, 'new through alias'));
  assert.equal(fresh.ok, true, fresh.error);
  assert.equal(fs.readFileSync(path.join(b, 'new.txt'), 'utf8'), 'new through alias');
  await assert.rejects(withWorkspaceFileTarget(() => config, { ...refA, relativePath: 'escape/new-secret.txt' }, '',
    (root) => writeText(root, 'escape/new-secret.txt', 'bad')));
  assert.equal(fs.existsSync(path.join(outside, 'new-secret.txt')), false);
  const escapeUrl = buildWorkspaceFileUrl({ ...refA, relativePath: 'escape/secret.txt' });
  assert.equal((await handleWorkspaceMediaRequest(ctx, escapeUrl, new Request(escapeUrl))).status, 403, 'media cannot bypass the real-path guard through a Junction');
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'outside secret');
  // 单根旧 URL 仍有效；多根旧 URL 不得隐式读取宿主管理根。
  config = { workspaces: [{ ...workspace, id: 'single', roots: [{ id: 'a', path: a }] }], activeWorkspaceId: 'single' };
  const legacyUrl = buildWorkspaceMediaUrl('single', name);
  assert.equal(await (await handleWorkspaceMediaRequest(ctx, legacyUrl, new Request(legacyUrl))).text(), 'A');
  config = { workspaces: [workspace], activeWorkspaceId: workspace.id };
  fs.mkdirSync(path.join(a, '.muster/extensions/demo'), { recursive: true });
  fs.writeFileSync(path.join(a, '.muster/extensions/demo/data.txt'), 'management');
  // 旧格式 authority 不接受 / 身份，用标准旧 ID 验证这一条路径。
  config = { workspaces: [{ ...workspace, id: 'legacy-ext', defaultRootId: 'b /中文&', path: b }], activeWorkspaceId: 'legacy-ext' };
  const extensionUrl = buildWorkspaceMediaUrl('legacy-ext', '.muster/extensions/demo/data.txt');
  assert.equal((await handleWorkspaceMediaRequest(ctx, extensionUrl, new Request(extensionUrl))).status, 403);
  console.log('workspace-file-access: OK');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
