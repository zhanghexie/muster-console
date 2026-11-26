import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8').replace(/\r\n/g, '\n');
const base = read('src/renderer/src/styles/base.css');
const left = read('src/renderer/src/styles/left.css');
const app = read('src/renderer/src/App.tsx');
const rule = (css, selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `Missing ${selector}`);
  return css.slice(start, css.indexOf('}', start));
};

assert.match(rule(base, '.main-view.sessions-peek .ws-stage:not(.is-sliding)'), /transform:\s*translateX\(var\(--sessions-col-w\)\)/);
assert.match(rule(base, '.ws-stage'), /z-index:\s*1/);
assert.match(rule(left, '.sessions-float'), /z-index:\s*0/);
assert.doesNotMatch(rule(left, '.sessions-float'), /transform|backdrop-filter/);
assert.match(rule(base, '.main-view.sessions-hidden .ws-stage'), /background:\s*var\(--workspace-frame-color,\s*var\(--surface-frame\)\)/);
assert.match(app, /if \(wsTransit\) setSessionsPeekOpen\(false\)/);
// yieldBrowserView 让位管道已随内置浏览器迁移 <webview> 容器整体删除，不再守卫。
// base.css 有多个 :root 块，变量定义散布其中；按全文断言定义值。
assert.match(base, /--frame-gap:\s*4px/, '框边统一为 4px');
assert.match(rule(base, '.ws-stage'), /inset:\s*0 0 var\(--frame-gap\)/, '工作面在框底留白，分割线随其结束');
assert.match(rule(left, '.sessions-float'), /bottom:\s*var\(--frame-gap\)/, '折叠速览侧栏也不得盖住底部留白');
assert.match(rule(base, '.main-view.sessions-hidden:not(.h-git) .terminal-page'), /padding-left:\s*var\(--frame-gap\)/, '左屏激活且侧栏收起时仍留左侧框边');
assert.match(rule(base, '.main-view.h-git .git-page,\n.main-view.is-focus .git-page'), /padding-right:\s*var\(--frame-gap\)/, '右屏激活或专注时右侧留框边');
assert.match(rule(left, '.sessions-column'), /padding:\s*0;/, '常驻侧栏外层不得重复叠加侧边留白');
assert.match(rule(left, '.sessions-float'), /padding:\s*0;/, '速览外层也不得重复叠加侧边留白');
console.log('sessions-slide-css: OK');
