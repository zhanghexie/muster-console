import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const bridge = fs.readFileSync('src/main/uiRuntime/bridge.js', 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
let stateListener, finishSave, finishAction;
const receipts = [];
const native = new JSDOM(`<!doctype html><head><script>${bridge}</script></head><body><div id="ma-ui-content"></div></body>`, {
  url: 'https://fixture.invalid/native', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(window) {
    window.TextEncoder = TextEncoder;
    window.__maUiHost = {
      read: async () => ({ state: { modelContent: null, privateContent: null, revision: 0 } }),
      save: () => new Promise(resolve => { finishSave = resolve; }),
      action: () => new Promise(resolve => { finishAction = resolve; }),
      onState: listener => { stateListener = listener; }, onAppearance: () => {}, receipt: async receipt => { receipts.push(receipt); }
    };
  }
});
try {
  await native.window.maUi.whenReady();
  const save = native.window.maUi.set('local', 1);
  stateListener({ modelContent: { local: 1, peer: 2 }, privateContent: { values: { local: 1, peer: 2 } }, revision: 3 });
  finishSave({ state: { modelContent: { local: 1 }, privateContent: { values: { local: 1 } }, revision: 2 } });
  await save;
  assert.equal(native.window.maUi.get('peer'), 2, 'newer peer state survives an older local acknowledgement');
  const action = native.window.maUi.sendFollowup('继续分析'); await tick();
  stateListener({ modelContent: { local: 1, peer: 4 }, privateContent: { values: { local: 1, peer: 4 } }, revision: 4 });
  finishAction({ ok: true, cancelled: true }); await action;
  assert.equal(native.window.maUi.get('peer'), 4, 'peer changes during a pending confirmation are replayed');
  native.window.dispatchEvent(new native.window.ErrorEvent('error', { error: new native.window.Error('HOST_EXPECTED_ERROR'), message: 'HOST_EXPECTED_ERROR', lineno: 37, colno: 9 }));
  assert.match(receipts.at(-1).error, /HOST_EXPECTED_ERROR.*37:9/, 'runtime receipt keeps the original error and source line');
} finally { native.window.close(); }
console.log('ui-widget-runtime-state: queued peer synchronization passed');
