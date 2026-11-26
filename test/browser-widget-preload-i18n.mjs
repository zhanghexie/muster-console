import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const ts = createRequire(import.meta.url)('typescript');
const source = ts.createSourceFile('tabs.ts', fs.readFileSync('src/main/browser/tabs.ts', 'utf8'), ts.ScriptTarget.Latest, true);
let preloadTemplate, fallback;
function find(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'VIEW_PRELOAD_SRC') {
    assert.ok(node.initializer && (ts.isTemplateExpression(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer)));
    preloadTemplate = node.initializer.getText(source);
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'VIEW_ACTIVATION_FALLBACK') {
    assert.ok(node.initializer && ts.isStringLiteral(node.initializer));
    fallback = node.initializer.text;
  }
  ts.forEachChild(node, find);
}
find(source);
assert.ok(preloadTemplate && fallback, 'use the actual browser preload and fallback');
const preload = vm.runInNewContext(preloadTemplate, { JSON, VIEW_ACTIVATION_FALLBACK: fallback, MUSTER_EXT_SCHEME: 'muster-ext' });

const listeners = new Map(), calls = [], exposed = {};
const ipcRenderer = {
  on: (name, callback) => listeners.set(name, callback),
  removeListener() {},
  invoke: async (...args) => { calls.push(args); return { ok: true }; },
  sendSync: () => ({ accepted: true, value: '' }),
};
const contextBridge = {
  exposeInMainWorld: (key, value) => { exposed[key] = value; },
  executeInMainWorld: ({ func }) => func(),
};
const navigator = { userActivation: { isActive: false } };
vm.runInNewContext(preload, {
  require: () => ({ ipcRenderer, contextBridge }), location: { protocol: 'muster-ext:' }, navigator, window: exposed
});
assert.equal(exposed.prompt('message', 'default'), '', 'an empty prompt answer crosses the preload bridge');
const host = exposed.__maUiHost;
assert.ok(host);
await assert.rejects(host.action({ type: 'copy', text: 'x' }), /请点击或用键盘触发此操作/);
assert.equal(calls.length, 0, 'missing user activation never reaches the action handler');
listeners.get('uiWidget:appearance')({}, { theme: 'light', activationError: 'Click or use the keyboard to perform this action' });
await assert.rejects(host.action({ type: 'copy', text: 'x' }), /Click or use the keyboard/);
listeners.get('uiWidget:appearance')({}, { theme: 'dark' });
await assert.rejects(host.action({ type: 'copy', text: 'x' }), /请点击或用键盘触发此操作/, 'old appearance messages keep the original fallback');
navigator.userActivation.isActive = true;
assert.deepEqual(await host.action({ type: 'copy', text: 'x' }, { revision: 2 }), { ok: true });
assert.deepEqual(calls, [['uiWidget:guest-action', { type: 'copy', text: 'x' }, { revision: 2 }]]);
console.log('browser widget preload: localized activation error and trusted action gate passed');
