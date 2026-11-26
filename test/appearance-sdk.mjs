/** Exercise the shipped extension SDK, including reordered theme IPC and font-only updates. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const values = new Map();
const links = [];
const document = {
  documentElement: { dataset: {}, style: { setProperty: (key, value) => values.set(key, value) } },
  querySelectorAll: () => links,
  head: { appendChild: link => links.push(link) },
  createElement: () => ({ setAttribute() {}, getAttribute(key) { return this[key]; }, remove() { links.splice(links.indexOf(this), 1); } })
};
let receive;
const parent = { postMessage() {} };
const window = { parent, addEventListener: (_event, listener) => { receive = listener; } };
const extensionSource = fs.readFileSync(path.join(root, 'src/main/extensions/sdk/extension-sdk.js'), 'utf8');
vm.runInNewContext(extensionSource, { window, document, setTimeout: () => 1, clearTimeout() {}, console });
const send = data => receive({ source: parent, data: { __ma: true, ...data } });
send({ type: 'appearance', revision: 7, colorScheme: 'light', theme: { '--surface-canvas': '#f4f8fa' }, fontStylesheets: [] });
send({ type: 'init', context: { generation: 1, appearance: { revision: 6, colorScheme: 'dark', theme: { '--surface-canvas': '#141416' }, fontStylesheets: [] } } });
const context = await window.ma.ready;
assert.equal(values.get('--surface-canvas'), '#f4f8fa', 'delayed init cannot replace a newer appearance');
assert.equal(context.appearance.revision, 7, 'ready context and rendered palette agree');
assert.equal(context.generation, 1, 'theme synchronization preserves extension identity');
assert.equal(document.documentElement.dataset.appearanceRevision, '7');
send({ type: 'appearance', revision: 5, colorScheme: 'dark', theme: { '--surface-canvas': '#101010' }, fontStylesheets: [] });
assert.equal(values.get('--surface-canvas'), '#f4f8fa', 'older revision ignored');
send({ type: 'appearance', revision: 7, colorScheme: 'light', theme: { '--surface-canvas': '#f4f8fa', '--font-body': '16px' }, fontStylesheets: ['https://example.test/font.css'] });
assert.equal(values.get('--font-body'), '16px', 'font-only update within a palette revision accepted');
assert.equal(links.length, 1);
send({ type: 'appearance', revision: 8, colorScheme: 'dark', theme: { '--surface-canvas': '#1e1e24' }, fontStylesheets: [] });
assert.equal(document.documentElement.style.colorScheme, 'dark');
assert.equal(document.documentElement.dataset.theme, 'dark');
assert.equal(context.appearance.revision, 8, 'context retains current appearance after ready');
assert.equal(links.length, 0, 'unselected font stylesheet removed');

// extension panels receive locale independently from palette revision, including a delayed init.
const extensionDoc = { ...document, documentElement: { lang: 'zh-CN', dataset: {}, style: { setProperty() {} } } };
let extensionReceive;
const extensionParent = { postMessage() {} };
const extensionWindow = { parent: extensionParent, addEventListener: (_event, listener) => { extensionReceive = listener; } };
vm.runInNewContext(extensionSource, { window: extensionWindow, document: extensionDoc, setTimeout: () => 1, clearTimeout() {}, console });
const sendExtension = data => extensionReceive({ source: extensionParent, data: { __ma: true, ...data } });
sendExtension({ type: 'appearance', revision: 7, locale: 'en', localeRevision: 2 });
sendExtension({ type: 'init', context: { generation: 1, appearance: { revision: 6, locale: 'zh-CN', localeRevision: 1, fontStylesheets: [] } } });
const extensionContext = await extensionWindow.ma.ready;
assert.equal(extensionDoc.documentElement.lang, 'en', 'delayed init cannot roll back the locale');
assert.equal(extensionContext.appearance.locale, 'en', 'ready context matches the live locale');
assert.equal(extensionContext.appearance.localeRevision, 2);
sendExtension({ type: 'appearance', revision: 5, locale: 'zh-CN', localeRevision: 3 });
assert.equal(extensionDoc.documentElement.lang, 'zh-CN', 'locale update applies even when its palette is stale');
assert.equal(extensionContext.appearance.locale, 'zh-CN');
sendExtension({ type: 'appearance', revision: 8, locale: 'en', localeRevision: 2 });
assert.equal(extensionDoc.documentElement.lang, 'zh-CN', 'older locale update cannot replace the newer one');

const popupDoc = { ...document, documentElement: { lang: 'zh-CN', dataset: {}, style: { setProperty() {} } } };
let popupReceive;
const popupWindow = { parent: extensionParent, addEventListener() {}, maHost: { subscribe: listener => { popupReceive = listener; }, init: async () => ({ generation: 1, appearance: { generation: 1, locale: 'en', localeRevision: 1, fontStylesheets: [] } }) } };
vm.runInNewContext(extensionSource, { window: popupWindow, document: popupDoc, setTimeout: () => 1, clearTimeout() {}, console });
await popupWindow.ma.ready;
assert.equal(popupDoc.documentElement.lang, 'en', 'standalone panel receives initial locale');
popupReceive({ __ma: true, type: 'appearance', locale: 'zh-CN', localeRevision: 2 });
assert.equal(popupDoc.documentElement.lang, 'zh-CN', 'standalone panel receives locale changes');

const currentSource = fs.readFileSync(path.join(root, 'src/main/extensions/sdk/extension-sdk.js'), 'utf8');
const currentValues = new Map();
const currentLinks = [];
const currentDocument = {
  documentElement: { dataset: {}, style: { setProperty: (key, value) => currentValues.set(key, value) } },
  querySelectorAll: () => currentLinks,
  head: { appendChild: link => currentLinks.push(link) },
  createElement: () => ({ setAttribute() {}, getAttribute(key) { return this[key]; }, remove() { currentLinks.splice(currentLinks.indexOf(this), 1); } })
};
let currentReceive;
const currentParent = { postMessage() {} };
const currentWindow = { parent: currentParent, addEventListener: (_event, listener) => { currentReceive = listener; } };
vm.runInNewContext(currentSource, { window: currentWindow, document: currentDocument, setTimeout: () => 1, clearTimeout() {}, console });
const sendCurrent = data => currentReceive({ source: currentParent, data: { __ma: true, ...data } });
sendCurrent({ type: 'appearance', revision: 4, colorScheme: 'light', locale: 'en', localeRevision: 4, theme: { '--surface-canvas': '#f4f8fa' }, fontStylesheets: [] });
sendCurrent({ type: 'init', context: { extensionId: 'bookshelf', appearance: { revision: 3, colorScheme: 'dark', locale: 'zh-CN', localeRevision: 3, theme: { '--surface-canvas': '#141416' }, fontStylesheets: [] }, theme: { accent: '#ff7a00' } } });
const currentContext = await currentWindow.ma.ready;
assert.equal(currentValues.get('--surface-canvas'), '#f4f8fa', 'current delayed init cannot replace a newer appearance');
assert.equal(currentValues.get('--ma-accent'), '#ff7a00', 'current extension theme remains available');
assert.equal(currentContext.appearance.revision, 4, 'current context keeps the newest host appearance');
assert.equal(currentDocument.documentElement.lang, 'en', 'current appearance carries the current locale');
assert.equal(typeof currentWindow.ma.data.read, 'function');
assert.equal(typeof currentWindow.ma.journal.list, 'function');
assert.equal(typeof currentWindow.ma.notify, 'function');
sendCurrent({ type: 'appearance', revision: 5, colorScheme: 'dark', theme: { '--surface-canvas': '#1e1e24' }, fontStylesheets: [] });
assert.equal(currentValues.get('--surface-canvas'), '#1e1e24', 'current appearance updates are applied live');
console.log('appearance SDK contracts passed');

// current 独立窗口（maHost/preload 通道）：init/appearance 经 IPC 订阅，call 走 IPC 直达主进程
const currentPopupValues = new Map();
const currentPopupLinks = [];
const currentPopupDoc = {
  documentElement: { lang: 'zh-CN', dataset: {}, style: { setProperty: (key, value) => currentPopupValues.set(key, value) } },
  querySelectorAll: () => currentPopupLinks,
  head: { appendChild: link => currentPopupLinks.push(link) },
  createElement: () => ({ setAttribute() {}, getAttribute(key) { return this[key]; }, remove() { currentPopupLinks.splice(currentPopupLinks.indexOf(this), 1); } })
};
let currentPopupReceive;
const currentPopupCalls = [];
const currentPopupHost = {
  subscribe: listener => { currentPopupReceive = listener; },
  init: async () => ({ extensionId: 'bookshelf', appearance: { revision: 2, colorScheme: 'dark', locale: 'zh-CN', theme: { '--surface-canvas': '#141416' }, fontStylesheets: [] } }),
  call: async input => { currentPopupCalls.push(input); return { ok: 'popup' }; }
};
const currentPopupWindow = { maHost: currentPopupHost, parent: {}, addEventListener() {} };
vm.runInNewContext(currentSource, { window: currentPopupWindow, document: currentPopupDoc, setTimeout: () => 1, clearTimeout() {}, console });
await currentPopupWindow.ma.ready;
assert.equal(currentPopupValues.get('--surface-canvas'), '#141416', 'current popup init applies the stored appearance');
const popupReply = await currentPopupWindow.ma.data.read('todos.json');
// vm 跨 realm 的数组与 deepStrictEqual 的 prototype 不匹配，逐字段断言
assert.equal(currentPopupCalls[0].id, 'extension-1', 'current popup calls route through the maHost IPC bridge');
assert.equal(currentPopupCalls[0].method, 'data.read');
assert.equal(currentPopupCalls[0].args[0], 'todos.json');
assert.equal(currentPopupCalls[0].args[1], 'workspace');
assert.equal(popupReply.ok, 'popup');
currentPopupReceive({ __ma: true, type: 'appearance', revision: 3, colorScheme: 'light', locale: 'en', theme: { '--surface-canvas': '#f4f8fa' }, fontStylesheets: [] });
assert.equal(currentPopupValues.get('--surface-canvas'), '#f4f8fa', 'current popup appearance updates arrive via subscribe');
assert.equal(currentPopupDoc.documentElement.lang, 'en');
console.log('current popup (maHost) SDK contract passed');
