import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fs.readFile(path.join(root, 'src/renderer/src/styles/base.css'), 'utf8');
const motionTokens = new Map();
for (const [, name, value] of source.matchAll(/(--(?:dur|ease)-[\w-]+)\s*:\s*([^;]+);/g)) {
  if (!motionTokens.has(name)) motionTokens.set(name, value.trim());
}
const tokens = `#side-tools-tabs-prototype { ${[...motionTokens].map(([name, value]) => `${name}: ${value};`).join(' ')} }`;
const css = await fs.readFile(path.join(root, 'docs/prototypes/side-tools-tabs/side-tools-tabs.css'), 'utf8');
// Code-authored attachment fixture: no captured screen is required or embedded.
// This illustration is explicitly labelled and is not evidence of the live app.
const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600"><rect width="960" height="600" fill="#18181b"/><rect x="72" y="76" width="816" height="448" rx="12" fill="#242427" stroke="#414147"/><text x="108" y="130" fill="#ededee" font-family="sans-serif" font-size="24">原型附件示意</text><text x="108" y="165" fill="#aaaab2" font-family="sans-serif" font-size="16">代码生成的预览夹具 · 非真实界面截图</text><rect x="108" y="207" width="210" height="273" rx="8" fill="#303036"/><rect x="342" y="207" width="510" height="42" rx="6" fill="#3b3b43"/><rect x="342" y="269" width="510" height="211" rx="8" fill="#303036"/><path d="M132 238h140m-140 40h112m-112 40h128m-128 40h92M370 302h392m-392 37h324m-324 37h360" stroke="#888894" stroke-width="8" stroke-linecap="round"/></svg>';
const imageSource = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(picture)}`;
const entry = `
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SideToolsTabsPrototype } from './docs/prototypes/side-tools-tabs/side-tools-tabs';
const imageSource = ${JSON.stringify(imageSource)};
const compatible = snapshot => {
  const s = snapshot?.privateContent?.state;
  if (!s || !['workbench', 'demo'].includes(s.project) || !['review', 'build'].includes(s.session) || !Array.isArray(s.tabs) || !Array.isArray(s.closed) || !s.selected || !s.histories || !Number.isInteger(s.nextId)) return undefined;
  const validTab = t => t && typeof t.id === 'string' && typeof t.project === 'string' && typeof t.session === 'string' && typeof t.pinned === 'boolean' && t.content && ['file', 'image', 'git', 'diff', 'web'].includes(t.content.kind) && typeof t.content.key === 'string' && typeof t.content.title === 'string' && typeof t.content.path === 'string';
  if (!s.tabs.every(validTab) || !s.closed.every(validTab) || !Object.values(s.histories).every(h => h && Array.isArray(h.entries) && Number.isInteger(h.index) && h.entries.every(v => v && typeof v.tabId === 'string' && v.content && typeof v.content.key === 'string'))) return undefined;
  if (s.browserUi && (typeof s.browserUi.favoritesOpen !== 'boolean' || !Array.isArray(s.browserUi.expanded) || !s.browserUi.expanded.every(id => typeof id === 'string'))) return undefined;
  if (s.resources && (!['files', 'git', 'browser'].includes(s.resources.panel) || typeof s.resources.collapsed !== 'boolean' || !s.resources.expanded || !['files', 'git', 'browser'].every(kind => Array.isArray(s.resources.expanded[kind]) && s.resources.expanded[kind].every(id => typeof id === 'string')))) return undefined;
  return s;
};
const save = state => {
  if (!window.openai?.setWidgetState) return;
  const visible = state.tabs.filter(t => t.project === state.project && (t.pinned || t.session === state.session));
  window.openai.setWidgetState({
    modelContent: { project: state.project, session: state.session, pinned: visible.filter(t => t.pinned).map(t => t.content.title), tabs: visible.map(t => ({ title: t.content.title, type: t.content.kind, preview: t.preview })), sidePanel: state.resources?.panel, sidePanelCollapsed: state.resources?.collapsed ?? false },
    privateContent: JSON.stringify(state).length < 14000 ? { state } : null,
  }).catch(() => {});
};
function Preview() {
  const [restored, setRestored] = useState(() => ({ state: compatible(window.openai?.widgetState), revision: 0 }));
  const current = useRef(restored.state);
  useEffect(() => {
    const restore = event => {
      const state = compatible(event.detail?.globals?.widgetState);
      if (!state || JSON.stringify(state) === JSON.stringify(current.current)) return;
      current.current = state;
      setRestored(value => ({ state, revision: value.revision + 1 }));
    };
    window.addEventListener('openai:set_globals', restore);
    return () => window.removeEventListener('openai:set_globals', restore);
  }, []);
  return <SideToolsTabsPrototype key={restored.revision} initialState={restored.state} imageSource={imageSource} onStateChange={state => { current.current = state; save(state); }} />;
}
createRoot(document.getElementById('side-tools-tabs-mount')).render(<Preview />);
requestAnimationFrame(() => {
  const element = document.getElementById('side-tools-tabs-prototype');
  if (!element || !globalThis.Tweak) return;
  const state = { barHeight: 44, radius: 10 };
  const apply = () => { element.style.setProperty('--st-bar-h', state.barHeight + 'px'); element.style.setProperty('--st-radius', state.radius + 'px'); };
  const tweak = new Tweak({ container: element, onChange: apply });
  tweak.addSlider(state, 'barHeight', { label: '工具栏高度', min: 36, max: 52, step: 4, unit: 'px', reference: '--st-bar-h' });
  tweak.addSlider(state, 'radius', { label: '阅读面圆角', min: 6, max: 14, step: 2, unit: 'px', reference: '--st-radius' });
});
`;
const compiled = await build({ absWorkingDir: root, stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, minify: true, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const script = compiled.outputFiles[0].text.replaceAll('</script', '<\\/script');
const fragment = [
  '<!-- Generated by scripts/build-side-tools-tabs.mjs. Isolated design prototype. -->',
  '<div id="side-tools-tabs-mount"></div>',
  `<style>${tokens}\n${css}</style>`,
  `<script>${script}</script>`, ''
].join('\n');
if (Buffer.byteLength(fragment) >= 1_000_000) throw new Error('Prototype exceeds inline budget');
const output = path.join(root, 'docs/prototypes/side-tools-tabs/side-tools-tabs.html');
await fs.writeFile(output, fragment);
const visualIndex = process.argv.indexOf('--visual-copy');
if (visualIndex >= 0) {
  const destination = process.argv[visualIndex + 1];
  if (!destination || !path.isAbsolute(destination)) throw new Error('--visual-copy requires an absolute path');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, fragment);
}
console.log(`Built ${path.relative(root, output)} (${Buffer.byteLength(fragment)} bytes)`);
if (process.argv.includes('--serve')) {
  const preview = path.join(root, 'output/playwright/side-tools-tabs/preview.html');
  const server = createServer(async (req, res) => {
    if (req.url?.split('?')[0] !== '/') { res.writeHead(404); res.end(); return; }
    try { const html = await fs.readFile(preview, 'utf8'); res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(html); }
    catch { res.writeHead(503); res.end('Preview is being rendered.'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  console.log(`Preview: http://127.0.0.1:${server.address().port}/`);
}
