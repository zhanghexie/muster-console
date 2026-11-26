import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'esbuild';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = await fs.readFile(path.join(root, 'src/renderer/src/styles/base.css'), 'utf8');
const tokens = new Map();
for (const [,name,value] of base.matchAll(/(--(?:dur|ease)-[\w-]+)\s*:\s*([^;]+);/g)) if (!tokens.has(name)) tokens.set(name,value.trim());
tokens.set('--dur-reduced', '.01ms');
const css = await fs.readFile(path.join(root, 'docs/prototypes/color-system-study/color-system-study.css'), 'utf8');
const entry = `import React from 'react'; import { createRoot } from 'react-dom/client'; import { ColorSystemStudy } from './docs/prototypes/color-system-study/color-system-study'; createRoot(document.getElementById('color-system-study-mount')).render(<ColorSystemStudy />);`;
const compiled = await build({ absWorkingDir: root, stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, minify: true, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const fragment = `<div id="color-system-study-mount"></div>\n<style>#color-system-study { ${[...tokens].map(([n,v])=>`${n}:${v};`).join(' ')} }\n${css}</style>\n<script>${compiled.outputFiles[0].text.replaceAll('</script','<\\/script')}</script>\n`;
const output = path.join(root, 'docs/prototypes/color-system-study/color-system-study.html');
await fs.writeFile(output, fragment);
const visual = process.argv.indexOf('--visual-copy');
if (visual >= 0) { const dest = process.argv[visual + 1]; if (!dest || !path.isAbsolute(dest)) throw new Error('Absolute --visual-copy path required'); await fs.writeFile(dest, fragment); }
console.log(JSON.stringify({ output, bytes: Buffer.byteLength(fragment) }));
if (process.argv.includes('--serve')) {
  const port = Number(process.env.COLOR_STUDY_PORT || 47841);
  const server = createServer(async (req,res) => { if (req.url !== '/' && req.url !== '/color-system-study.html') { res.writeHead(404); res.end(); return; } res.setHeader('Content-Type','text/html;charset=utf-8'); res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:20px;background:#181b21;box-sizing:border-box;}@media(max-width:600px){body{padding:8px;}}</style></head><body>${await fs.readFile(output,'utf8')}</body></html>`); });
  server.listen(port,'127.0.0.1',()=>console.log(`Preview http://127.0.0.1:${port}`));
}
