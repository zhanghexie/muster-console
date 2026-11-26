/**
 * 渲染层错误分级：ResizeObserver 自限提示两条消息视为良性（不上报「渲染层崩溃」），
 * 真实错误/非字符串不误伤。回归背景：该良性提示曾被 index.html 启动陷阱误标
 * 「启动失败」并走 reportRendererError 弹崩溃 toast（e2e 侧见 test/e2e/boot-diag.spec.ts）。
 * 2026-10-27 增补：Electron 43 webview 元素卸载必发的 Invalid guestInstanceId 上游
 * 噪音同样归良性（每次关浏览器标签都会弹崩溃 toast 的回归拦截）。
 * Run: node test/renderer-error.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-error-'));

const entry = path.join(root, 'src', 'shared', 'rendererErrorLog.ts');
const { outputText } = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: entry
});
const out = path.join(tmp, 'rendererErrorLog.mjs');
fs.writeFileSync(out, outputText, 'utf8');
const { isBenignRendererError } = await import(pathToFileURL(out).href);

// 良性：Chromium 自限提示两条（带/不带句号、前后空白、消息后缀变体）
assert.equal(
  isBenignRendererError('ResizeObserver loop completed with undelivered notifications.'),
  true
);
assert.equal(isBenignRendererError('ResizeObserver loop limit exceeded'), true);
assert.equal(isBenignRendererError('  ResizeObserver loop limit exceeded.  '), true);
assert.equal(
  isBenignRendererError('ResizeObserver loop completed with undelivered notifications (deferred)'),
  true
);

// 真实错误与非字符串不得误伤
assert.equal(isBenignRendererError('Uncaught TypeError: x is not a function'), false);
assert.equal(isBenignRendererError('ResizeObserver loop'), false);
assert.equal(isBenignRendererError(''), false);
assert.equal(isBenignRendererError(undefined), false);
assert.equal(isBenignRendererError(null), false);

// 良性：Electron 43 webview 元素卸载必发的上游噪音（guest 已正确销毁，
// disconnectedCallback 异步再报一次 Invalid guestInstanceId，调用侧无法
// try/catch）。window.onerror 形态带 Uncaught 前缀，unhandledrejection 形态不带。
assert.equal(isBenignRendererError('Uncaught Error: Invalid guestInstanceId: 8'), true);
assert.equal(isBenignRendererError('Error: Invalid guestInstanceId: 23'), true);
assert.equal(isBenignRendererError('  Uncaught Error: Invalid guestInstanceId: 1  '), true);
// 近形不误伤：非数字 id、拼接进更长消息、其余 guestInstanceId 语义错误
assert.equal(isBenignRendererError('Uncaught Error: Invalid guestInstanceId: abc'), false);
assert.equal(isBenignRendererError('Uncaught Error: Invalid guestInstanceId: 8 (extra)'), false);
assert.equal(isBenignRendererError('Uncaught TypeError: Invalid guestInstanceId hack'), false);
assert.equal(isBenignRendererError(42), false);
assert.equal(isBenignRendererError({ message: 'ResizeObserver loop limit exceeded' }), false);

console.log('renderer-error: all assertions passed');
