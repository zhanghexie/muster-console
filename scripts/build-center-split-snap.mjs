import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createServer } from 'node:http';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [base, css, template] = await Promise.all([
  fs.readFile(path.join(root, 'src/renderer/src/styles/base.css'), 'utf8'),
  fs.readFile(path.join(root, 'docs/prototypes/center-split-snap/center-split-snap.css'), 'utf8'),
  fs.readFile(path.join(root, 'docs/prototypes/center-split-snap/center-split-snap.template.html'), 'utf8')
]);
const tokens = new Map();
for (const [, name, value] of base.matchAll(/(--(?:dur|ease)-[\w-]+)\s*:\s*([^;]+);/g)) {
  if (!tokens.has(name)) tokens.set(name, value.trim());
}
const entry = `
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SnapSplitPrototype, SNAP_LAYOUTS, SNAP_SESSIONS } from './docs/prototypes/center-split-snap/center-split-snap';
const compatibleState = snapshot => {
  const state = snapshot?.privateContent?.snap;
  const layout = SNAP_LAYOUTS.find(item => item.id === state?.layoutId);
  if (!layout || !Array.isArray(state.slots) || state.slots.length !== layout.cells.length ||
      !state.slots.every(id => id == null || Object.hasOwn(SNAP_SESSIONS, id))) return undefined;
  const occupied = state.slots.filter(id => id != null);
  if (!occupied.length || new Set(occupied).size !== occupied.length || !occupied.includes(state.focused)) return undefined;
  return { layoutId: layout.id, slots: [...state.slots], focused: state.focused,
    assistSlot: Number.isInteger(state.assistSlot) && state.assistSlot >= 0 && state.assistSlot < state.slots.length && state.slots[state.assistSlot] == null ? state.assistSlot : null };
};
function Preview() {
  const [restored, setRestored] = useState(() => ({ state: compatibleState(window.openai?.widgetState), revision: 0 }));
  const current = useRef(restored.state);
  useEffect(() => {
    const restore = event => {
      const state = compatibleState(event.detail?.globals?.widgetState);
      if (!state || JSON.stringify(state) === JSON.stringify(current.current)) return;
      current.current = state;
      setRestored(previous => ({ state, revision: previous.revision + 1 }));
    };
    window.addEventListener('openai:set_globals', restore);
    return () => window.removeEventListener('openai:set_globals', restore);
  }, []);
  const remember = state => {
    current.current = state;
    if (!window.openai?.setWidgetState) return;
    window.openai.setWidgetState({
      modelContent: { interaction: 'windows-snap', layout: SNAP_LAYOUTS.find(item => item.id === state.layoutId).label,
        panes: state.slots.map(id => id ? SNAP_SESSIONS[id].name : null) },
      privateContent: { snap: state }
    }).catch(() => {});
  };
  return <SnapSplitPrototype key={restored.revision} initialState={restored.state} onStateChange={remember}/>;
}
createRoot(document.getElementById('snap-split-mount')).render(<Preview/>);
requestAnimationFrame(() => {
  const element = document.getElementById('snap-split-prototype');
  if (!element || !globalThis.Tweak) return;
  const state = { blur: 16 };
  const tweak = new Tweak({ container: element, onChange: () => element.style.setProperty('--sp-blur', state.blur + 'px') });
  tweak.addSlider(state, 'blur', { label: '落点磨砂强度', min: 8, max: 24, step: 1, unit: 'px', reference: '--sp-blur' });
});
`;
const compiled = await build({ absWorkingDir: root, stdin: { contents: entry, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, minify: true, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const fragment = template.replace('__MOTION_TOKENS__', `#snap-split-prototype { ${[...tokens].map(([name, value]) => `${name}: ${value};`).join(' ')} }`)
  .replace('__PRODUCT_STYLES__', css).replace('__PRODUCT_SCRIPT__', compiled.outputFiles[0].text.replaceAll('</script', '<\\/script'));
if (Buffer.byteLength(fragment) >= 1_000_000) throw new Error('Prototype exceeds the inline fragment budget');
const output = path.join(root, 'docs/prototypes/center-split-snap/center-split-snap.html');
await fs.writeFile(output, fragment);
const visualIndex = process.argv.indexOf('--visual-copy');
if (visualIndex >= 0) {
  const destination = process.argv[visualIndex + 1];
  if (!destination || !path.isAbsolute(destination)) throw new Error('--visual-copy needs an absolute output path');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, fragment);
}
console.log(`Built ${path.relative(root, output)} (${Buffer.byteLength(fragment)} bytes)`);
if (process.argv.includes('--serve')) {
  const server = createServer(async (request, response) => {
    if (request.url?.split('?')[0] !== '/') { response.writeHead(404); response.end(); return; }
    try {
      const latest = await fs.readFile(output, 'utf8');
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.setHeader('Cache-Control', 'no-store');
      response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Windows 分屏方式原型</title><style>:root{color-scheme:light dark}body{margin:0;padding:12px;background:light-dark(#f1f1f3,#18191b)}@media(max-width:480px){body{padding:0}}</style>${latest}</html>`);
    } catch { response.writeHead(503); response.end('Prototype is rebuilding; refresh shortly.'); }
  });
  const portIndex = process.argv.indexOf('--port'); const port = portIndex < 0 ? 0 : Number(process.argv[portIndex + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port needs a valid local port');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  console.log(`Preview: http://127.0.0.1:${server.address().port}/`);
}
