/**
 * ui.notify 桌面弹窗文案自测。
 * 运行: node test/desktop-notify.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-notify-'));
const compile = createSharedCompiler(root, tmp);
const outFile = compile('main/capabilities/hosts/desktopNotify.ts');
const { resolveDesktopNotifyPayload } = await import(pathToFileURL(outFile).href);

assert.deepEqual(resolveDesktopNotifyPayload('工作面板 2', '已定位根因'), {
  title: '工作面板 2',
  body: '已定位根因',
  icon: undefined
});
assert.deepEqual(resolveDesktopNotifyPayload('  ', 'hello'), {
  title: '会话',
  body: 'hello',
  icon: undefined
});
assert.deepEqual(resolveDesktopNotifyPayload('', 'x'), {
  title: '会话',
  body: 'x',
  icon: undefined
});

assert.deepEqual(
  resolveDesktopNotifyPayload('Worker-A', '需要审批', {
    workspaceName: '查缺陷',
    avatar: '🐱'
  }),
  { title: '🐱 查缺陷 · Worker-A', body: '需要审批', icon: undefined }
);

const dataUrl = 'data:image/png;base64,aaa';
assert.deepEqual(
  resolveDesktopNotifyPayload('Worker-A', '需要审批', {
    workspaceName: '查缺陷',
    avatar: dataUrl
  }),
  { title: '查缺陷 · Worker-A', body: '需要审批', icon: dataUrl }
);

assert.deepEqual(
  resolveDesktopNotifyPayload('Worker-A', '需要审批', {
    workspaceName: '查缺陷',
    avatar: 'https://example.com/a.png'
  }),
  { title: '查缺陷 · Worker-A', body: '需要审批', icon: undefined }
);

console.log('desktop-notify: ok');
