// Local CDP transport: bounded requests, explicit target selection, no application API calls.
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function evaluationErrorMessage(details, allowedMessages = []) {
  const firstLine = typeof details?.exception?.description === 'string' ? details.exception.description.split('\n')[0] : '';
  const controlled = allowedMessages.find(message => firstLine === message || firstLine === `Error: ${message}`);
  return controlled ? `Page evaluation failed: ${controlled}` : 'Page evaluation failed (application text deliberately omitted)';
}

export function describeApplicationTargets(targets) {
  return targets.flatMap(target => {
    if (target.type !== 'page' || !target.webSocketDebuggerUrl) return [];
    try {
      const url = new URL(target.url);
      if (url.protocol === 'file:' && /app\.asar.*\/index\.html$/.test(url.pathname)) return [{ id: target.id, kind: 'installed', entrypoint: 'app.asar/.../index.html' }];
      if (url.protocol === 'file:' && /\/out\/renderer\/index\.html$/.test(url.pathname)) return [{ id: target.id, kind: 'bundle', entrypoint: 'out/renderer/index.html' }];
      if (['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['/', '/index.html'].includes(url.pathname)) return [{ id: target.id, kind: 'dev', origin: url.origin, entrypoint: url.pathname }];
    } catch { /* Invalid and external URLs are intentionally omitted. */ }
    return [];
  });
}

export function selectAppTarget(targets, targetId) {
  const pages = targets.filter(target => target.type === 'page' && target.webSocketDebuggerUrl);
  if (targetId) {
    const selected = pages.find(target => target.id === targetId);
    if (!selected) throw new Error('Requested CDP page target does not exist');
    if (!describeApplicationTargets([selected]).length) throw new Error('Requested CDP target is not a recognized application page');
    return selected;
  }
  const applicationIds = new Set(describeApplicationTargets(pages).map(target => target.id));
  const candidates = pages.filter(target => applicationIds.has(target.id));
  if (candidates.length !== 1) throw new Error(`Expected one application page, found ${candidates.length}; pass an explicit targetId`);
  return candidates[0];
}

export async function listTargets(port) {
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid CDP port');
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`CDP target listing failed: HTTP ${response.status}`);
  const targets = await response.json();
  if (!Array.isArray(targets)) throw new Error('CDP target listing is not an array');
  return targets;
}

export async function connectCdp(port, targetId) {
  const page = selectAppTarget(await listTargets(port), targetId);
  return connectTarget(page);
}

export async function connectInspector(port, targetId) {
  const candidates = (await listTargets(port)).filter(target => target.type === 'node' && target.webSocketDebuggerUrl && (!targetId || target.id === targetId));
  if (candidates.length !== 1) throw new Error(`Expected one Node Inspector target, found ${candidates.length}`);
  return connectTarget(candidates[0]);
}

async function connectTarget(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  const listeners = new Set();
  let nextId = 0;
  const failPending = () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('CDP connection closed')); }
    pending.clear();
  };
  ws.addEventListener('close', failPending);
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`CDP ${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result);
    } else if (message.method) for (const listener of listeners) listener(message);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('CDP connection timeout')); }, 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
  });
  const call = (method, params = {}, timeoutMs = 15000) => new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) { reject(new Error('CDP is not open')); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
    pending.set(id, { method, resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression, { allowedExceptionMessages = [] } = {}) => {
    const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(evaluationErrorMessage(response.exceptionDetails, allowedExceptionMessages));
    return response.result?.value;
  };
  return { call, evaluate, page, onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); }, close: () => { failPending(); ws.close(); } };
}
