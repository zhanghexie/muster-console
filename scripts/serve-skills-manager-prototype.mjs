/** Local-only prototype preview; serves the generated HTML, never other repository files. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'docs/prototypes/skills-manager/skills-manager.html');

export async function serveSkillsManagerPrototype({ port = 0, quiet = false } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be 0..65535.');
  await fs.access(output);
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (pathname !== '/' && pathname !== '/skills-manager.html') { response.writeHead(404); response.end('Not found'); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return; }
    try {
      const html = await fs.readFile(output);
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Length', html.length);
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.end(request.method === 'HEAD' ? undefined : html);
    } catch {
      response.writeHead(503); response.end('The prototype is rebuilding. Refresh shortly.');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  if (!quiet) console.log(`Preview: ${url}`);
  return { server, url };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portIndex = process.argv.indexOf('--port');
  await serveSkillsManagerPrototype({ port: portIndex < 0 ? 0 : Number(process.argv[portIndex + 1]) });
}
