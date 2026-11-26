import WebSocket from 'ws';

const CDP_BASE = process.env.CDP_BASE || 'http://127.0.0.1:9223';
await new Promise((r) => setTimeout(r, 2000));
const targets = await (await fetch(`${CDP_BASE}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
if (!page) throw new Error('no page: ' + JSON.stringify(targets));

const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((res, rej) => {
  ws.on('open', res);
  ws.on('error', rej);
});

let id = 0;
const pending = new Map();
const errors = [];
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const t = msg.params.type;
    const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (t === 'error' || t === 'warning') errors.push(`[${t}] ${text}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(
      `[exception] ${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text}`
    );
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
await rpc('Log.enable');
await rpc('Page.enable');
await new Promise((r) => setTimeout(r, 500));

const dump = await rpc('Runtime.evaluate', {
  expression: `(() => {
    const root = document.getElementById('root');
    return {
      rootLen: root?.innerHTML?.length ?? 0,
      rootText: (root?.innerText || '').slice(0, 300),
      hasApp: !!document.querySelector('.app-shell'),
      hasChrome: !!document.querySelector('.chrome-bar'),
      hasAgent: !!document.querySelector('.agent-float'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      err: window.__lastError || null
    };
  })()`,
  returnByValue: true
});
console.log('DOM', JSON.stringify(dump.result?.value, null, 2));
console.log('ERRORS', errors.length ? errors.join('\n') : '(none)');
ws.close();
