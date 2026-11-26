/**
 * CDP 类型改写代理（测试侧 JS 版；与 src/main/browser/cdpTypeProxy.ts 同构）：
 * webview guest 的 DevTools target type 是 "webview"，playwright 页面发现只认
 * "page"——测试连 dev 实例的 CDP 端口前先起本代理，改写 /json* 与 WS 帧的类型
 * 标签并让 ws 地址指回代理。与 agentTools 的生产通路（经主进程内代理）一致。
 *
 * 两个坑（spike 踩过）：WS 帧转发必须 toString()（CDP 只收文本帧）；
 * /json 响应里的 ws 地址必须指回代理（否则 playwright 直连上游绕过隧道）。
 */
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

export function startCdpTypeProxy(upstreamPort, listenPort = 0) {
  const stats = { frames: 0, rewritten: 0 };
  const rewrite = (s) =>
    s.includes('"webview"') ? (stats.rewritten++, s.replaceAll('"type":"webview"', '"type":"page"')) : s;
  const server = http.createServer((req, res) => {
    fetch(`http://127.0.0.1:${upstreamPort}${req.url}`)
      .then(async (up) => {
        let out = await up.text();
        if (/^\/json/.test(req.url)) {
          out = rewrite(out).replaceAll(`127.0.0.1:${upstreamPort}`, `127.0.0.1:${server.address().port}`);
        }
        res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' });
        res.end(out);
      })
      .catch((e) => {
        res.writeHead(502);
        res.end(String(e));
      });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, sock, head) => {
    const up = new WebSocket(`ws://127.0.0.1:${upstreamPort}${req.url}`);
    wss.handleUpgrade(req, sock, head, (down) => {
      const drop = () => {
        try { up.close(); } catch { /* ignore */ }
        try { down.close(); } catch { /* ignore */ }
      };
      let upReady = false;
      const pending = [];
      up.on('message', (data, isBinary) => {
        stats.frames++;
        if (isBinary) down.send(data, { binary: true });
        else down.send(rewrite(data.toString()));
      });
      up.on('open', () => {
        upReady = true;
        for (const m of pending) up.send(m);
      });
      down.on('message', (data) => {
        const text = data.toString();
        if (upReady) up.send(text);
        else pending.push(text);
      });
      up.on('close', drop);
      down.on('close', drop);
      up.on('error', drop);
      down.on('error', drop);
    });
  });
  return new Promise((resolve) => {
    server.listen(listenPort, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        stats,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); server.close(() => r()); })
      })
    );
  });
}
