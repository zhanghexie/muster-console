/**
 * BrowserGuestRegistry 纯逻辑：webview guest 注册表的 fail-closed 守卫。
 * 覆盖：attach 校验四连（no-tab/closed/not-webview/window-mismatch）、tombstone
 * 拒绝迟到 attach 复活、换代 generation 自增、detach 只清绑定保壳、反查。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-guest-registry-'));
const compile = createSharedCompiler(root, tmp);

const { BrowserGuestRegistry } = await import(
  pathToFileURL(compile('main/browser/guestRegistry.ts'))
);

const reg = new BrowserGuestRegistry();
reg.setWindow(7);

// tab 未创建 → no-tab
assert.deepEqual(reg.attach({ tabId: 'bt1', webContentsId: 11, guestType: 'webview', windowId: 7 }), {
  ok: false,
  reason: 'no-tab'
});

// 类型不是 webview → not-webview（防误绑主窗口 renderer 之类）
reg.createTab('bt1');
assert.deepEqual(reg.attach({ tabId: 'bt1', webContentsId: 11, guestType: 'browser', windowId: 7 }), {
  ok: false,
  reason: 'not-webview'
});
// 窗口不匹配 → window-mismatch（防跨窗口误绑）
assert.deepEqual(reg.attach({ tabId: 'bt1', webContentsId: 11, guestType: 'webview', windowId: 8 }), {
  ok: false,
  reason: 'window-mismatch'
});

// 合法 attach：绑定 + 反查
const ok1 = reg.attach({ tabId: 'bt1', webContentsId: 11, guestType: 'webview', windowId: 7 });
assert.equal(ok1.ok, true);
assert.equal(ok1.generation, 1);
assert.equal(reg.tabIdOf(11), 'bt1');
assert.equal(reg.guestOf('bt1').webContentsId, 11);

// 同一 guest 重复上报（dom-ready 多次）不换代
assert.equal(reg.attach({ tabId: 'bt1', webContentsId: 11, guestType: 'webview', windowId: 7 }).generation, 1);
// One live guest has one tab owner; rejected aliasing preserves its original binding.
reg.createTab('bt2');
assert.deepEqual(reg.attach({ tabId: 'bt2', webContentsId: 11, guestType: 'webview', windowId: 7 }), {
  ok: false, reason: 'guest-in-use'
});
assert.equal(reg.tabIdOf(11), 'bt1');
assert.equal(reg.guestOf('bt2'), null);
// 换 guest（renderer 重建 webview）→ generation 自增
assert.equal(reg.attach({ tabId: 'bt1', webContentsId: 12, guestType: 'webview', windowId: 7 }).generation, 2);
assert.equal(reg.tabIdOf(11), null);
assert.equal(reg.tabIdOf(12), 'bt1');
// A delayed attach from the retired guest cannot replace its successor or alias another tab.
assert.deepEqual(reg.attach({ tabId: 'bt1', webContentsId: 11, guestType: 'webview', windowId: 7 }), {
  ok: false, reason: 'stale-generation'
});
assert.deepEqual(reg.attach({ tabId: 'bt2', webContentsId: 11, guestType: 'webview', windowId: 7 }), {
  ok: false, reason: 'stale-generation'
});
assert.equal(reg.guestOf('bt1').webContentsId, 12);

// detach：旧 id 的迟到 detach 不生效；当前 id 清绑定、壳保留
assert.equal(reg.detach('bt1', 11), false);
assert.equal(reg.detach('bt1', 12), true);
assert.equal(reg.guestOf('bt1'), null);
assert.equal(reg.has('bt1'), true);
assert.deepEqual(reg.attach({ tabId: 'bt1', webContentsId: 12, guestType: 'webview', windowId: 7 }), {
  ok: false, reason: 'stale-generation'
});
// Detaching does not reset the generation counter.
assert.equal(reg.attach({ tabId: 'bt1', webContentsId: 15, guestType: 'webview', windowId: 7 }).generation, 3);

// tombstone：关闭后迟到 attach 拒绝复活
reg.closeTab('bt1');
assert.deepEqual(reg.attach({ tabId: 'bt1', webContentsId: 13, guestType: 'webview', windowId: 7 }), {
  ok: false,
  reason: 'closed'
});
assert.equal(reg.isClosed('bt1'), true);
assert.equal(reg.has('bt1'), false);

// 关闭后再创建同名 id：tombstone 语义针对生命周期 token，不再拦截新壳（seq 单调不会复用，这里只验证行为收敛）
reg.createTab('bt1');
assert.equal(reg.attach({ tabId: 'bt1', webContentsId: 14, guestType: 'webview', windowId: 7 }).ok, true);

const owned = new BrowserGuestRegistry();
owned.setWindow(7, 101);
owned.createTab('owned');
assert.deepEqual(owned.attach({ tabId: 'owned', webContentsId: 30, guestType: 'webview', windowId: 7 }), {
  ok: false, reason: 'embedder-mismatch'
});
assert.deepEqual(owned.attach({ tabId: 'owned', webContentsId: 30, guestType: 'webview', windowId: 7, embedderId: 102 }), {
  ok: false, reason: 'embedder-mismatch'
});
assert.equal(owned.attach({ tabId: 'owned', webContentsId: 30, guestType: 'webview', windowId: 7, embedderId: 101 }).ok, true);

fs.rmSync(tmp, { recursive: true, force: true });

console.log('browser-guest-registry: all assertions passed');
