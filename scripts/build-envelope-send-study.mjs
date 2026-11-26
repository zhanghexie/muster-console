import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = await fs.readFile(path.join(root, 'src/renderer/src/styles/base.css'), 'utf8');
const tokens = new Map();
for (const [, name, value] of base.matchAll(/(--(?:dur|ease)-[\w-]+)\s*:\s*([^;]+);/g)) {
  if (!tokens.has(name)) tokens.set(name, value.trim());
}
const css = await fs.readFile(path.join(root, 'docs/prototypes/envelope-send/envelope-send.css'), 'utf8');
const compiled = await build({
  absWorkingDir: root,
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {EnvelopeSendStudy} from './docs/prototypes/envelope-send/envelope-send';
    createRoot(document.getElementById('envelope-send-mount')).render(<EnvelopeSendStudy/>);`, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, minify: true, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }
});
const fragment = `<div id="envelope-send-preview" class="viz-dotted-background"><div id="envelope-send-mount"></div></div>
<style>#envelope-send-study {${[...tokens].map(([k,v]) => `${k}:${v};`).join('')}}\n${css}</style>
<script>${compiled.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>\n`;
const out = path.join(root, 'docs/prototypes/envelope-send/envelope-send.html');
await fs.writeFile(out, fragment);
const flag = process.argv.indexOf('--visual-copy');
if (flag >= 0) {
  const dest = process.argv[flag + 1];
  if (!dest || !path.isAbsolute(dest)) throw new Error('--visual-copy requires an absolute path');
  await fs.mkdir(path.dirname(dest), {recursive: true});
  await fs.writeFile(dest, fragment);
}
console.log(`Built ${out} (${Buffer.byteLength(fragment)} bytes)`);
