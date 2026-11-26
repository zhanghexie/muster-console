import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-preview-'));
try {
  const compile = createSharedCompiler(repo, tmp);
  const { WorkspacePreviews } = await import(pathToFileURL(compile('main/workspacePreview.ts')).href);
  const a = path.join(tmp, 'a'); const b = path.join(tmp, 'b'); const outside = path.join(tmp, 'outside');
  for (const dir of [a, b, outside]) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'index.html'), dir === b ? 'B' : 'A'); }
  fs.symlinkSync(outside, path.join(b, 'escape'), 'junction');
  let workspace = { id: 'Mixed/中文', path: a, name: 'multi', openedAt: 0, rootsRevision: 0,
    defaultRootId: 'a', controlRoot: a, roots: [{ id: 'a', path: a }, { id: 'b /中文&', path: b }] };
  let config = { workspaces: [workspace], activeWorkspaceId: workspace.id };
  let now = 0;
  const previews = new WorkspacePreviews({ config: { get: () => config } }, () => now);
  const ref = { workspaceId: workspace.id, rootId: 'b /中文&', relativePath: 'index.html' };
  const created = await previews.create(ref);
  assert.match(created.token, /^[0-9a-f]{48}$/);
  const request = new Request('http://preview.local/');
  assert.equal(await (await previews.serve(created.token, 'index.html', request)).text(), 'B');
  const range = await previews.serve(created.token, 'index.html', new Request('http://preview.local/', { headers: { Range: 'bytes=0-0' } }));
  assert.equal(range.status, 206); assert.equal(range.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(range.headers.get('Cache-Control'), 'no-store');
  assert.equal((await previews.serve('unknown', 'index.html', request)).status, 403);
  assert.equal((await previews.serve(created.token, '../a/index.html', request)).status, 403);
  assert.equal((await previews.serve(created.token, 'escape/index.html', request)).status, 403);
  previews.release(created.token); assert.equal((await previews.serve(created.token, 'index.html', request)).status, 403);
  // 文件响应准备中关闭预览，也不能把已撤销的资源返回给浏览器。
  const preparing = await previews.create(ref);
  const realStat = fsp.stat;
  let resume; let reached;
  const paused = new Promise(resolve => { reached = resolve; });
  fsp.stat = async (...args) => {
    const value = await realStat(...args);
    if (args[0] === path.join(b, 'index.html')) {
      reached(); await new Promise(resolve => { resume = resolve; });
    }
    return value;
  };
  try {
    const pending = previews.serve(preparing.token, 'index.html', request);
    await paused; previews.release(preparing.token); resume();
    assert.equal((await pending).status, 403);
  } finally { fsp.stat = realStat; }
  await assert.rejects(previews.create({ ...ref, rootId: 'removed' }), /source folder not found/);
  const stale = await previews.create(ref);
  config = { ...config, workspaces: [{ ...workspace, rootsRevision: 1 }] };
  assert.equal((await previews.serve(stale.token, 'index.html', request)).status, 403);
  config = { ...config, workspaces: [workspace] };
  const expired = await previews.create(ref); now += 3600_001;
  assert.equal((await previews.serve(expired.token, 'index.html', request)).status, 403);
  const closed = await previews.create(ref); config = { ...config, workspaces: [] };
  assert.equal((await previews.serve(closed.token, 'index.html', request)).status, 403);
  const alias = path.join(tmp, 'alias'); fs.symlinkSync(b, alias, 'junction');
  workspace = { ...workspace, roots: [{ id: 'a', path: a }, { id: 'b /中文&', path: alias }] };
  config = { ...config, workspaces: [workspace] };
  const relocated = await previews.create(ref);
  fs.unlinkSync(alias); fs.symlinkSync(outside, alias, 'junction');
  assert.equal((await previews.serve(relocated.token, 'index.html', request)).status, 403);
  workspace = { ...workspace, roots: [{ id: 'a', path: a }, { id: 'b /中文&', path: b }] }; config = { ...config, workspaces: [workspace] };
  const limited = new WorkspacePreviews({ config: { get: () => config } });
  const many = await Promise.allSettled(Array.from({ length: 70 }, () => limited.create(ref)));
  assert.equal(many.filter(value => value.status === 'fulfilled').length, 64, 'concurrent creation also obeys limit');
  console.log('workspace-preview: OK (root-only reads, revocation, versions, expiry, relocation, Range, concurrency limit)');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
