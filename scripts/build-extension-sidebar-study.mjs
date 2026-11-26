// Generate a standalone preview; --serve keeps a loopback-only preview open for review.
import { buildSync } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = buildSync({
  absWorkingDir: root,
  stdin: { contents: "import React from 'react'; import {createRoot} from 'react-dom/client'; import {ExtensionSidebarStudy} from './docs/prototypes/extension-sidebar-study/extension-sidebar-study'; createRoot(document.getElementById('root')).render(<ExtensionSidebarStudy/>);", resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, minify: true, format: 'iife', define: { 'process.env.NODE_ENV': '"production"' }
}).outputFiles[0].text;
const css = ['src/renderer/src/styles/base.css', 'src/renderer/src/styles/left.css', 'src/renderer/src/styles/extension-navigation.css', 'docs/prototypes/extension-sidebar-study/extension-sidebar-study.css']
  .map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
const output = path.join(root, 'docs/prototypes/extension-sidebar-study/extension-sidebar-study.html');
const html = `<!doctype html>\n<!-- Generated: node scripts/build-extension-sidebar-study.mjs -->\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MetaAgent · 工具与网页</title><style>${css.replaceAll('</style', '<\\/style')}</style></head><body><div id="root"></div><script>${bundle.replaceAll('</script', '<\\/script')}</script></body></html>\n`;
fs.writeFileSync(output, html);
console.log(path.relative(root, output));
if (process.argv.includes('--serve')) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (url.pathname !== '/') { res.writeHead(404); res.end('Not found'); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fs.readFileSync(output));
  });
  server.listen(0, '127.0.0.1', () => console.log(`Preview: http://127.0.0.1:${server.address().port}/`));
}
