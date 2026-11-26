/**
 * window.open 分流纯逻辑（弹窗式 OAuth 修复回归）：
 * new-popup + 真实用户手势 → 原生弹窗（保住 opener/postMessage/close 契约）；
 * 其余一律内置新标签（含无手势的 new-popup——防脚本弹窗滥用且不引入新拦截）。
 * 自查方式：把 routeWindowOpen 改回无条件 in-app-tab 时，首个断言转红。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-popup-policy-'));
const compile = createSharedCompiler(root, tmp);

const { routeWindowOpen } = await import(pathToFileURL(compile('main/browser/popupPolicy.ts')).href);

// 弹窗式 OAuth 形态（window.open 带宽高/top/left 特征；Electron 43 探针实测
// disposition='new-window' 且特征串带窗口 token，无 new-popup 枚举）且源于
// 用户手势：必须放行原生弹窗，deny+转标签会切断整条登录回传通道。
assert.deepEqual(routeWindowOpen('new-window', 'width=600,height=700,top=100,left=100', true), { kind: 'native-popup' });
assert.deepEqual(routeWindowOpen('new-popup', 'width=1', true), { kind: 'native-popup' }, 'future Electron surfacing new-popup');

// 同形态但无手势（脚本定时器/卸载页弹窗）：维持既有转标签行为。
assert.deepEqual(routeWindowOpen('new-window', 'width=600,height=700', false), { kind: 'in-app-tab' });

// 无窗口特征的 window.open（noopener/noreferrer 等）：仍走内置标签——真 Chrome
// 也把它开成标签，且无 opener 依赖。
assert.deepEqual(routeWindowOpen('new-window', 'noopener,noreferrer', true), { kind: 'in-app-tab' });
assert.deepEqual(routeWindowOpen('new-window', '', true), { kind: 'in-app-tab' });

// 其余 disposition（target=_blank、无特征 window.open、下载等）一律内置新标签，
// 手势与否不改变路由——普通链接的标签化体验不受本次修复影响。
for (const disposition of ['foreground-tab', 'background-tab', 'default', 'save-to-disk', 'other', '']) {
  assert.deepEqual(routeWindowOpen(disposition, 'width=600,height=700', true), { kind: 'in-app-tab' }, `${disposition} + gesture`);
  assert.deepEqual(routeWindowOpen(disposition, '', false), { kind: 'in-app-tab' }, `${disposition} without gesture`);
}

// 特征 token 匹配不吃偏名（statuswidth 之类不误判为窗形特征）
assert.deepEqual(routeWindowOpen('new-window', 'statuswidth=1,status=1', true), { kind: 'in-app-tab' });

console.log('browser-popup-policy: all assertions passed');
