import WebSocket from 'ws';
import fs from 'node:fs';

const CDP_BASE = process.env.CDP_BASE || 'http://127.0.0.1:9223';
const targets = await (await fetch(`${CDP_BASE}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
if (!page) throw new Error('no page');

const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((res, rej) => {
  ws.on('open', res);
  ws.on('error', rej);
});

let id = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}

await rpc('Runtime.enable');
await rpc('Page.enable');

const dump = await rpc('Runtime.evaluate', {
  expression: `(() => {
    if (typeof window.__maBubbleDebug !== 'function') return { err: 'no __maBubbleDebug yet' };
    return window.__maBubbleDebug();
  })()`,
  returnByValue: true,
  awaitPromise: true
});
console.log('DUMP', JSON.stringify(dump.result?.value, null, 2));

const dom = await rpc('Runtime.evaluate', {
  expression: `(() => {
    const dock = document.querySelector('.agent-float-dock-row .agent-float-bubble');
    const stack = [...document.querySelectorAll('.agent-ws-stack-bubble')].map((el) => el.innerText);
    const peer = document.querySelector('.peer-notifier');
    const labels = [...document.querySelectorAll('.agent-ws-label')].map((el) => el.innerText);
    const dockTitle = document.querySelector('.agent-float-dock-row .agent-float-avatar')?.getAttribute('title');
    return {
      dockBubble: dock?.innerText ?? null,
      stackBubbles: stack,
      stackLabels: labels,
      peerText: peer?.innerText ?? null,
      dockTitle
    };
  })()`,
  returnByValue: true
});
console.log('DOM', JSON.stringify(dom.result?.value, null, 2));

const shot = await rpc('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(new URL('./bubble-debug.png', import.meta.url), Buffer.from(shot.data, 'base64'));
console.log('screenshot: test/bubble-debug.png');
ws.close();
