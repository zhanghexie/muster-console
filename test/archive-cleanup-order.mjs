/**
 * 归档删 worktree 前必须先 await 拆链：慢 release 完成前 cleanup 不得启动。
 * 回归：把 releaseThenCleanup 改回「void release(); await cleanup()」竞态时应转红。
 * Run: node test/archive-cleanup-order.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-cleanup-order-'));
const compile = createSharedCompiler(root, tmp);
const out = compile('main/sessions/releaseThenCleanup.ts');
const { releaseThenCleanup } = await import(pathToFileURL(out).href);

{
  const order = [];
  let releaseDone = false;
  await releaseThenCleanup(
    async () => {
      order.push('release-start');
      await new Promise((r) => setTimeout(r, 40));
      releaseDone = true;
      order.push('release-end');
    },
    async () => {
      assert.equal(releaseDone, true, 'cleanup 不得在 release 完成前启动');
      order.push('cleanup');
    }
  );
  assert.deepEqual(order, ['release-start', 'release-end', 'cleanup']);
  console.log('ok: 慢 release 完成后再 cleanup');
}

{
  const order = [];
  await releaseThenCleanup(null, async () => {
    order.push('cleanup-only');
  });
  assert.deepEqual(order, ['cleanup-only']);
  console.log('ok: 无 release 时直接 cleanup');
}

{
  const order = [];
  await releaseThenCleanup(
    () => {
      order.push('sync-release');
    },
    () => {
      order.push('sync-cleanup');
    }
  );
  assert.deepEqual(order, ['sync-release', 'sync-cleanup']);
  console.log('ok: 同步 release/cleanup 保序');
}

{
  // 还原竞态写法应转红：void release 不 await，cleanup 抢跑
  const order = [];
  let releaseDone = false;
  const buggy = async (release, cleanup) => {
    void release();
    await cleanup();
  };
  let raced = false;
  await buggy(
    async () => {
      order.push('release-start');
      await new Promise((r) => setTimeout(r, 40));
      releaseDone = true;
      order.push('release-end');
    },
    async () => {
      if (!releaseDone) raced = true;
      order.push('cleanup');
    }
  );
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(raced, true, '对照：竞态写法应让 cleanup 抢在 release 完成前');
  assert.ok(order.includes('cleanup') && order.indexOf('cleanup') < order.indexOf('release-end'));
  console.log('ok: 竞态对照（修复还原应转红的信号）');
}

console.log('all ok: archive-cleanup-order');
