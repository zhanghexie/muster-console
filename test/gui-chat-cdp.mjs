/**
 * GUI Worker 聊天 v2 的 CDP 分步验证驱动（开发用，不入 CI）。
 * 用法: node test/gui-chat-cdp.mjs <step> [args...]
 * 步骤: shot <name> | setup | eval "<js>" | clickat <css> | hoverat <css> | type <css> <text>
 * 依赖 dev 已用 MUSTER_DEVTOOLS_PORT=9333 启动。
 */
import WebSocket from 'ws';
import fs from 'node:fs';

const CDP_BASE = process.env.CDP_BASE ?? 'http://127.0.0.1:9333';
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

async function shot(name) {
  const s = await rpc('Page.captureScreenshot', { format: 'png' });
  const file = `test/shot-${name}.png`;
  fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
  console.log('saved', file);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const targets = await (await fetch(`${CDP_BASE}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  if (!page) throw new Error('no page target');
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
  await rpc('Page.enable');

  const step = process.argv[2];
  const args = process.argv.slice(3);
  switch (step) {
    case 'shot':
      await shot(args[0] ?? 'x');
      break;
    case 'setup': {
      const s = await evalJs(`window.api.sessions.create({ name: 'GUI验证', runtime: 'pi' })`);
      console.log('created', s.id, s.runtime);
      await sleep(1200);
      await shot('setup');
      break;
    }
    case 'eval':
      console.log(JSON.stringify(await evalJs(args[0]), null, 1));
      break;
    case 'hoverxy': {
      const [x, y] = args.map(Number);
      await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      console.log('hovered at', x, y);
      break;
    }
    case 'clickxy': {
      const [x, y] = args.map(Number);
      await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      console.log('clicked at', x, y);
      break;
    }
    case 'clickat': {
      // 真实鼠标点击：取元素中心坐标走 Input.dispatchMouseEvent
      const rect = await evalJs(
        `(() => { const el = document.querySelector(${JSON.stringify(args[0])}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()`
      );
      if (!rect) throw new Error('element not found: ' + args[0]);
      await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      console.log('clicked', args[0], rect.x, rect.y);
      break;
    }
    case 'hoverat': {
      const rect = await evalJs(
        `(() => { const el = document.querySelector(${JSON.stringify(args[0])}); if (!el) return null; const r = el.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()`
      );
      if (!rect) throw new Error('element not found: ' + args[0]);
      await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
      console.log('hovered', args[0], rect.x, rect.y);
      break;
    }
    case 'type': {
      await rpc('Input.insertText', { text: args[1] });
      console.log('typed into', args[0]);
      break;
    }
    default:
      throw new Error('unknown step: ' + step);
  }
  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
