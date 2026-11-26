import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
const bridge = fs.readFileSync('src/main/uiRuntime/bridge.js', 'utf8');
const expressions = fs.readFileSync('src/main/uiRuntime/expressions.js', 'utf8');
const components = fs.readFileSync('src/main/uiRuntime/components.js', 'utf8');
const errors = [];
const log = new VirtualConsole();
log.on('jsdomError', error => errors.push(error.message));
const dom = new JSDOM(`<!doctype html><html><head><script>${bridge}</script><script>${expressions}</script><script>${components}</script></head><body><div id="ma-ui-content">
<ma-grid columns="2"><ma-input name="budget" label="预算" type="number" value="3"></ma-input>
<ma-select name="status" label="状态"><option value="all">全部</option><option value="doing">进行中</option></ma-select></ma-grid>
<ma-text bind="budget"></ma-text><ma-badge bind="zero"></ma-badge><ma-checkbox name="secret" label="私人选项" private checked></ma-checkbox><div id="private-display" data-ma-visible="secret">私人显示选项</div>
<ma-tabs name="view"><section label="概览"><ma-text>概览内容</ma-text></section><section label="详情"><ma-text>详情内容</ma-text></section></ma-tabs>
<ma-details name="extra" label="更多参数"><ma-input name="extra" label="附加" value="abc"></ma-input></ma-details>
<input data-ma-bind="native" value="native default">
<ma-button action="followup" mode="send" prompt="按预算 {budget} 分析" label="继续分析"></ma-button>
</div></body></html>`, {
  url: 'https://fixture.invalid/widget', runScripts: 'dangerously', pretendToBeVisual: true,
  virtualConsole: log,
  beforeParse(window) { window.TextEncoder = TextEncoder; window.ResizeObserver = class { observe() {} disconnect() {} }; }
});
try {
  await new Promise(resolve => dom.window.addEventListener('load', resolve, { once: true }));
  const { document, maUi } = dom.window;
  const input = document.querySelector('ma-input input');
  assert.equal(input.value, '3');
  assert.equal(input.labels[0].textContent, '预算');
  assert.equal(document.querySelector('ma-select select').options.length, 2, 'head-defined components wait until children are parsed');
  assert.equal(document.querySelector('[data-ma-bind]').value, 'native default');
  assert.equal(document.getElementById('private-display').hidden, false, 'default values bind after parsed custom controls initialize');
  assert.equal(maUi.getWidgetState().modelContent.secret, undefined, 'refresh never promotes a private default');
  await maUi.set('zero', 0); assert.equal(document.querySelector('ma-badge').textContent, '0', 'zero is a real badge value');
  input.value = '7'; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(document.querySelector('ma-text[bind="budget"]').textContent, '7');
  assert.equal(maUi.getWidgetState().modelContent.budget, 7);
  const secret = document.querySelector('ma-checkbox input'); secret.checked = true; secret.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(maUi.getWidgetState().privateContent.values.secret, true);
  assert.equal(maUi.getWidgetState().modelContent.secret, undefined);
  const tabs = document.querySelectorAll('[role="tab"]');
  assert.equal(tabs.length, 2);
  tabs[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(document.querySelectorAll('[role="tabpanel"]')[0].hidden, true);
  const details = document.querySelector('ma-details details'); details.open = true;
  details.dispatchEvent(new dom.window.Event('toggle'));
  assert.equal(maUi.getWidgetState().privateContent.ui['details:extra'], true);
  const state = maUi.getWidgetState();
  await maUi.set('budget', 9);
  await maUi.setWidgetState(state);
  assert.equal(input.value, '7');
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  let requested;
  maUi.action = async value => { requested = value; return { ok: true }; };
  document.querySelector('ma-button button').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requested.text, '按预算 7 分析');
  assert.equal(requested.mode, 'send');
  assert.equal(document.querySelector('ma-button [role="status"]').textContent, '已提交');
  assert.deepEqual(errors, []);
  console.log('ui-widget-components: composition/labels/input binding/private state/tabs keyboard/disclosure/restore/action checks passed');
} finally { dom.window.close(); }
