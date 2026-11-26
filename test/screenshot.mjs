/** 截取当前应用窗口（CDP Page.captureScreenshot），可选先建一个默认 runtime 会话。 */
import WebSocket from 'ws';
import fs from 'node:fs';

const CDP_BASE = 'http://127.0.0.1:9222';
let msgId = 0;
let ws;
const pending = new Map();

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(expression) {
  const r = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
  return r.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const targets = await (await fetch(`${CDP_BASE}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 128 * 1024 * 1024 });
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  await rpc('Runtime.enable');

  const mode = process.argv[2] ?? '';
  let sid = '';
  if (mode === 'with-cursor-session') {
    const s = await evalJs(`window.api.sessions.create({ name: 'Cursor 工作面板' })`);
    sid = s.id;
    console.log('created session', s.id, 'runtime', s.runtime);
    await sleep(6000);
    const buf = await evalJs(`window.api.pty.getBuffer(${JSON.stringify(sid)})`);
    console.log('cursor-cli buffer length:', buf.length);
    if (!buf.length) throw new Error('cursor-cli 无输出');
  }

  const shot = await rpc('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('test/screenshot.png', Buffer.from(shot.data, 'base64'));
  console.log('screenshot saved: test/screenshot.png');

  if (sid && process.argv[3] === 'cleanup') {
    await evalJs(`window.api.sessions.close(${JSON.stringify(sid)})`);
    console.log('session closed');
  }
  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
