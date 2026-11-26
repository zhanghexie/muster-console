/** Self-contained Skills / MCP interaction prototype; no network assets or real configuration. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { serveSkillsManagerPrototype } from './serve-skills-manager-prototype.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'docs/prototypes/skills-manager/skills-manager.html');
const [base, css, template] = await Promise.all([
  fs.readFile(path.join(root, 'src/renderer/src/styles/base.css'), 'utf8'),
  fs.readFile(path.join(root, 'docs/prototypes/skills-manager/skills-manager.css'), 'utf8'),
  fs.readFile(path.join(root, 'docs/prototypes/skills-manager/skills-manager.template.html'), 'utf8')
]);
const tokens = base.match(/:root\s*\{[\s\S]*?\n\}/)?.[0];
const motionIndex = base.indexOf('/* 弹窗/大面板：淡入 + 轻微上浮入场；退场反向更快 */');
if (!tokens || !tokens.includes('--dur-panel:') || motionIndex < 0) {
  throw new Error('Production base.css token or motion skeleton boundary changed; update the prototype builder.');
}
const motion = base.slice(motionIndex);
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SkillsManagerPrototype } from './docs/prototypes/skills-manager/skills-manager';
import { builtinTheme } from './src/shared/theme';
import { applyTheme } from './src/renderer/src/theme';
const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
window.setSkillsPrototypeTheme = next => applyTheme(builtinTheme(next === 'light' ? 'light' : 'dark'));
applyTheme(builtinTheme(theme));
createRoot(document.getElementById('skills-manager-mount')).render(<SkillsManagerPrototype/>);
`;
const compiled = await build({
  absWorkingDir: root,
  outfile: path.join(root, '.tmp/skills-manager-prototype.js'),
  stdin: { contents: entry, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, minify: true, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' }
});
const script = compiled.outputFiles.find(file => file.path.endsWith('.js'))?.text;
if (!script) throw new Error('esbuild did not emit the prototype JavaScript bundle.');
const html = template.replace('__BASE_TOKENS__', () => tokens)
  .replace('__MOTION_STYLES__', () => motion)
  .replace('__PRODUCT_STYLES__', () => css)
  .replace('__PRODUCT_SCRIPT__', () => script.replaceAll('</script', '<\\/script'));
if (['__BASE_TOKENS__', '__MOTION_STYLES__', '__PRODUCT_STYLES__', '__PRODUCT_SCRIPT__'].some(marker => html.includes(marker))) {
  throw new Error('Unexpanded prototype template marker.');
}
if (/<(?:script|link)[^>]+(?:src|href)=["']https?:/i.test(html) || /url\(\s*["']?https?:/i.test(css)) {
  throw new Error('The standalone prototype must not load remote assets.');
}
if (Buffer.byteLength(html) > 1_000_000) throw new Error('Prototype exceeds the 1 MB self-contained budget.');
await fs.writeFile(output, html);
console.log(`Built ${path.relative(root, output)} (${Buffer.byteLength(html)} bytes).`);
if (process.argv.includes('--serve')) {
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex < 0 ? 0 : Number(process.argv[portIndex + 1]);
  await serveSkillsManagerPrototype({ port });
}
