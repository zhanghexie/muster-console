import http from 'node:http';
import fs from 'node:fs/promises';
const html = new URL('./index.html', import.meta.url);
const server = http.createServer(async (req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (req.url !== '/' && req.url !== '/index.html') { res.writeHead(404); res.end('Not found'); return; }
  try { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); res.end(await fs.readFile(html)); }
  catch { res.writeHead(500); res.end('Run node docs/prototypes/agent-apps-metro/build.mjs first'); }
});
server.listen(Number(process.env.METRO_PREVIEW_PORT || 4247),'127.0.0.1',()=>console.log(`Metro preview: http://127.0.0.1:${server.address().port}/`));
