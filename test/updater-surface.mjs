/**
 * 更新全局可见面（surface.ts）自测：任务栏进度值映射、通知条目文案、托盘菜单模板。
 * 运行: node test/updater-surface.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-surface-'));
const compile = createSharedCompiler(root, tmp);
const outFile = compile('main/updater/surface.ts');
const surface = await import(pathToFileURL(outFile).href);

// ---------- 任务栏进度值 ----------
// downloading：有百分比给真实进度（0..1），未拿到首个进度事件给 2（任务栏不定态）
assert.equal(surface.taskbarProgressValue('downloading', undefined), 2);
assert.equal(surface.taskbarProgressValue('downloading', Number.NaN), 2);
assert.equal(surface.taskbarProgressValue('downloading', 45), 0.45);
assert.equal(surface.taskbarProgressValue('downloading', 0), 0);
assert.equal(surface.taskbarProgressValue('downloading', 100), 1);
// 越界百分比收敛到 [0,1]
assert.equal(surface.taskbarProgressValue('downloading', 120), 1);
assert.equal(surface.taskbarProgressValue('downloading', -5), 0);
// 非 downloading 一律 -1（<0 移除任务栏进度条）
for (const state of ['unsupported', 'idle', 'checking', 'downloaded', 'error']) {
  assert.equal(surface.taskbarProgressValue(state, 50), -1, state);
}

// ---------- 通知条目文案 ----------
assert.ok(surface.downloadStartNotifyText('0.1.23').includes('0.1.23'));
assert.ok(surface.downloadStartNotifyText('0.1.23').includes('下载'));
assert.ok(surface.downloadFailedNotifyText('0.1.24').includes('0.1.24'));
assert.ok(surface.downloadFailedNotifyText('0.1.24').includes('下载失败'));

// ---------- 更新通知键（全程同键原地更新，不堆 toast） ----------
assert.equal(surface.UPDATE_NOTIFY_KEY, 'updater:progress');

// ---------- 托盘菜单模板 ----------
const actions = {
  showWindow: () => {},
  quit: () => {}
};
let installCalled = 0;
const updateItem = {
  version: '0.1.23',
  install: () => {
    installCalled += 1;
  }
};

// 无更新：显示主窗口 / 分隔线 / 退出（原静态菜单）
const base = surface.trayMenuTemplate(null, actions);
assert.equal(base.length, 3);
assert.equal(base[0].label, '显示主窗口');
assert.equal(base[1].type, 'separator');
assert.equal(base[2].label, '退出 集序');

// 有更新：插入「重启并安装更新 vX」，点击触发 install 回调
const withUpdate = surface.trayMenuTemplate(updateItem, actions);
assert.equal(withUpdate.length, 4);
assert.equal(withUpdate[1].label, '重启并安装更新 v0.1.23');
assert.equal(typeof withUpdate[1].click, 'function');
withUpdate[1].click();
assert.equal(installCalled, 1);
// 分隔线仍在更新项与退出项之间
assert.equal(withUpdate[3].label, '退出 集序');
assert.equal(withUpdate[2].type, 'separator');

// ---------- en 词条守卫（切 en 后断言英文文本，删改词条即转红） ----------
// zh-CN 无资源时 t() 回退返回 key 本身，上面的中文断言守不住 en 词条内容；
// 编译树里 shared/i18n 与 surface 共享同一模块实例，切语言后 t() 应返回英文。
const i18n = await import(pathToFileURL(path.join(tmp, 'shared', 'i18n', 'index.mjs')).href);
assert.equal(i18n.applyLocaleSetting('en', 'en-US'), 'en');
assert.ok(surface.downloadStartNotifyText('0.1.23').includes('downloading in background'));
assert.ok(surface.downloadFailedNotifyText('0.1.24').includes('Failed to download'));
assert.ok(surface.downloadFailedNotifyText('0.1.24').includes('Settings → About'));
const enTemplate = surface.trayMenuTemplate(updateItem, actions);
assert.equal(enTemplate[1].label, 'Restart to install v0.1.23');
// 展示名走词条：中文界面「退出 集序」、英文界面回落身份名 —— 删掉 en 词条这里会变成中文
assert.equal(enTemplate[3].label, 'Quit Muster Console');

console.log('updater-surface: all assertions passed');
