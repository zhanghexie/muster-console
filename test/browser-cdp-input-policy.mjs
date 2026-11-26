import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { build } from 'esbuild';
import { WebSocket, WebSocketServer } from 'ws';

const dir = fs.mkdtempSync(path.resolve('.tmp/browser-cdp-input-policy-'));
const bundle = path.join(dir, 'proxy.mjs');
await build({ entryPoints: ['src/main/browser/cdpTypeProxy.ts'], outfile: bundle,
  bundle: true, platform: 'node', format: 'esm', external: ['ws'], logLevel: 'silent' });
const { browserToolCdpCommand, startCdpTypeProxy } = await import(pathToFileURL(bundle));

for (const method of ['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.dispatchTouchEvent',
  'Input.synthesizeTapGesture', 'Input.insertText', 'Input.imeSetComposition',
  'Input.emulateTouchFromMouseEvent', 'Page.bringToFront', 'Target.activateTarget', 'Target.sendMessageToTarget']) {
  const out = browserToolCdpCommand(JSON.stringify({ id: 7, method, sessionId: 'guest-B', params: {} }));
  assert.equal(out.forward, undefined, method);
  const reply = JSON.parse(out.reply);
  assert.equal(reply.id, 7); assert.equal(reply.sessionId, 'guest-B');
  assert.match(reply.error.message, /^capability_unsupported:/);
}
for (const method of ['Runtime.evaluate', 'Runtime.callFunctionOn']) {
  const out = browserToolCdpCommand(JSON.stringify({ id: 11, method, sessionId: 'guest-A',
    params: { expression: '0', userGesture: true, awaitPromise: true } }));
  assert.deepEqual(JSON.parse(out.forward), { id: 11, method, sessionId: 'guest-A',
    params: { expression: '0', userGesture: false, awaitPromise: true } });
}
for (const method of ['Input.setInterceptDrags', 'Page.enable', 'DOM.getDocument', 'Target.setAutoAttach']) {
  const input = JSON.stringify({ id: 13, method, params: { flatten: true } });
  assert.equal(browserToolCdpCommand(input).forward, input);
}

const received = [];
const upstream = http.createServer((_req, res) => { res.end('[]'); });
const sockets = new WebSocketServer({ server: upstream });
sockets.on('connection', socket => socket.on('message', raw => {
  const command = JSON.parse(raw.toString()); received.push(command);
  if (command.method === 'Page.captureScreenshot') return;
  socket.send(JSON.stringify({ id: command.id, sessionId: command.sessionId, result: {} }));
}));
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
let proxy, client;
try {
  proxy = await startCdpTypeProxy(upstream.address().port);
  client = new WebSocket(`ws://127.0.0.1:${proxy.port}/devtools/browser/fixture`);
  await once(client, 'open');
  const request = async command => {
    const reply = once(client, 'message'); client.send(JSON.stringify(command));
    let timer;
    try { return JSON.parse((await Promise.race([reply, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('CDP reply timeout')), 2500);
    })]))[0].toString()); } finally { clearTimeout(timer); }
  };
  assert.ok((await request({ id: 1, method: 'Runtime.callFunctionOn', sessionId: 'guest-A',
    params: { functionDeclaration: '()=>0', userGesture: true } })).result);
  assert.equal(received[0].params.userGesture, false);
  const count = received.length;
  const denied = await request({ id: 2, method: 'Page.bringToFront', sessionId: 'guest-B' });
  assert.match(denied.error.message, /capability_unsupported/);
  assert.equal(denied.sessionId, 'guest-B');
  assert.equal(received.length, count, 'blocked input must never reach Chromium');
  client.send(JSON.stringify({ id: 3, sessionId: 'guest-A', method: 'Page.captureScreenshot', params: { secret: 'not-in-diagnostics' } }));
  await request({ id: 3, sessionId: 'guest-B', method: 'Page.getLayoutMetrics' });
  assert.deepEqual(proxy.stats().pending.map(x => x.method), ['Page.captureScreenshot'], 'same command ID in another session cannot clear hung capture');
  assert.ok(proxy.stats().pending[0].elapsedMs >= 0);
  assert.ok(!JSON.stringify(proxy.stats()).includes('not-in-diagnostics'));
  console.log('PASS browser CDP input policy: native-input rejection, non-user gestures and real proxy forwarding');
} finally {
  client?.terminate(); await proxy?.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve));
  await new Promise(resolve => upstream.close(resolve));
}
