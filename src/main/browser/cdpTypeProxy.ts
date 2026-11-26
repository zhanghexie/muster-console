/**
 * CDP 类型改写代理：webview guest 在 DevTools 端点上的 target type 是 "webview"，
 * playwright 的页面发现只认 "page"——内置浏览器 webview 化（2026-10-08）后，
 * agent 工具面的 playwright-core 连接改经本代理：/json* 响应与 WS 帧（server→client）
 * 里的类型标签被改写为 "page"，playwright 即可像普通页面一样驱动 guest
 * （locator / ariaSnapshot(ai) ref 继续由 Playwright 解析）。工具脚本不授予用户手势，
 * 原生键鼠派发与前台激活在此拒绝，避免未来回退绕过后台 DOM 动作边界。
 *
 * 协议层改写、与 playwright 版本解耦；上游是应用自身的 DevTools 端口
 * （remote-debugging-port 随机 127.0.0.1）。注意（spike 踩坑）：
 * - WS 帧转发必须 toString()——Buffer 直接 send 会变二进制帧，CDP 只收文本帧
 * - /json 响应里的 ws 地址必须指回代理，否则 playwright 直连上游绕过隧道
 */
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

export interface CdpTypeProxyStats {
  frames: number;
  rewritten: number;
  http: number;
  pending?: Array<{ method: string; elapsedMs: number }>;
}

export interface CdpTypeProxy {
  port: number;
  close(): Promise<void>;
  stats(): CdpTypeProxyStats;
}

/** Applies only to the agent's connection, never to native webview input or DevTools. */
export function browserToolCdpCommand(text: string): { forward?: string; reply?: string } {
  let command: { id?: number; method?: string; sessionId?: string; params?: Record<string, unknown> };
  try { command = JSON.parse(text); } catch { return { forward: text }; }
  if (!command || typeof command !== 'object' || typeof command.method !== 'string') return { forward: text };
  const method = command.method;
  if (/^Input\.(dispatch|synthesize)/.test(method) ||
      ['Input.insertText', 'Input.imeSetComposition', 'Input.emulateTouchFromMouseEvent',
        'Page.bringToFront', 'Target.activateTarget', 'Target.sendMessageToTarget'].includes(method)) {
    return { reply: JSON.stringify({ id: command.id, ...(command.sessionId ? { sessionId: command.sessionId } : {}),
      error: { code: -32000, message: `capability_unsupported: ${method} is unavailable for background DOM automation; foreground focus is unchanged` } }) };
  }
  if (method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn') {
    return { forward: JSON.stringify({ ...command, params: { ...command.params, userGesture: false } }) };
  }
  return { forward: text };
}

export function startCdpTypeProxy(upstreamPort: number, preferPort = 0): Promise<CdpTypeProxy> {
  const stats: CdpTypeProxyStats = { frames: 0, rewritten: 0, http: 0 };
  const connections = new Set<Map<string, { method: string; at: number }>>();
  const rewrite = (s: string): string => {
    if (s.includes('"webview"')) {
      stats.rewritten++;
      return s.replaceAll('"type":"webview"', '"type":"page"');
    }
    return s;
  };
  const server = http.createServer((req, res) => {
    const url = `http://127.0.0.1:${upstreamPort}${req.url}`;
    fetch(url, { headers: { accept: req.headers.accept ?? '*/*' } })
      .then(async (up) => {
        let out = await up.text();
        if (/^\/json/.test(req.url ?? '')) {
          out = rewrite(out).replaceAll(`127.0.0.1:${upstreamPort}`, `127.0.0.1:${serverPort()}`);
        }
        stats.http++;
        res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' });
        res.end(out);
      })
      .catch((e) => {
        res.writeHead(502);
        res.end(String(e));
      });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req: http.IncomingMessage, sock: import('node:stream').Duplex, head: Buffer) => {
    const up = new WebSocket(`ws://127.0.0.1:${upstreamPort}${req.url}`);
    wss.handleUpgrade(req, sock, head, (down) => {
      const commands = new Map<string, { method: string; at: number }>();
      connections.add(commands);
      const drop = () => {
        connections.delete(commands);
        try { up.close(); } catch { /* ignore */ }
        try { down.close(); } catch { /* ignore */ }
      };
      let upReady = false;
      const pending: string[] = [];
      up.on('message', (data, isBinary) => {
        stats.frames++;
        if (!isBinary) {
          try {
            const reply = JSON.parse(data.toString());
            if (typeof reply.id === 'number') commands.delete(`${reply.sessionId ?? ''}:${reply.id}`);
          } catch { /* transport still forwards malformed frames */ }
        }
        if (isBinary) down.send(data, { binary: true });
        else down.send(rewrite(data.toString()));
      });
      up.on('open', () => {
        upReady = true;
        for (const m of pending) up.send(m);
      });
      down.on('message', (data) => {
        const command = browserToolCdpCommand(data.toString());
        if (command.reply) down.send(command.reply);
        if (command.forward) {
          try {
            const request = JSON.parse(command.forward);
            if (typeof request.id === 'number' && typeof request.method === 'string') {
              // Only method/timing: no expressions, page text, URLs or credentials.
              commands.set(`${request.sessionId ?? ''}:${request.id}`, { method: request.method, at: Date.now() });
              if (commands.size > 256) commands.delete(commands.keys().next().value!);
            }
          } catch { /* diagnostics must not change forwarding */ }
          if (upReady) up.send(command.forward);
          else pending.push(command.forward);
        }
      });
      up.on('close', drop);
      down.on('close', drop);
      up.on('error', drop);
      down.on('error', drop);
    });
  });
  const serverPort = (): number => {
    const addr = server.address();
    return typeof addr === 'object' && addr ? addr.port : 0;
  };
  return new Promise((resolve) => {
    server.listen(preferPort, '127.0.0.1', () => {
      resolve({
        port: serverPort(),
        stats: () => ({ ...stats, pending: [...connections].flatMap(commands => [...commands.values()])
          .map(command => ({ method: command.method, elapsedMs: Date.now() - command.at })) }),
        close: () =>
          new Promise((resolveClose) => {
            for (const client of wss.clients) client.terminate();
            server.close(() => resolveClose());
          })
      });
    });
  });
}
