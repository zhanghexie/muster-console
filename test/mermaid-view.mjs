/**
 * mermaid 查看器缩放/平移纯函数。
 * 运行: node test/mermaid-view.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mermaid-view-'));
const entry = path.join(root, 'src/shared/mermaidView.ts');
const { outputText } = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: entry
});
const out = path.join(tmp, 'mermaidView.mjs');
fs.writeFileSync(out, outputText);
const { clampMermaidZoom, zoomMermaidToward, fitMermaidView, MERMAID_ZOOM_MIN, MERMAID_ZOOM_MAX, parseMermaidSvgViewBox, normalizeMermaidSvg } =
  await import(pathToFileURL(out).href);

assert.equal(clampMermaidZoom(0), MERMAID_ZOOM_MIN);
assert.equal(clampMermaidZoom(99), MERMAID_ZOOM_MAX);
assert.equal(clampMermaidZoom(1), 1);

const zoomed = zoomMermaidToward({ scale: 1, x: 0, y: 0 }, 2, 100, 50);
assert.equal(zoomed.scale, 2);
assert.equal(zoomed.x, -100);
assert.equal(zoomed.y, -50);

const fit = fitMermaidView(800, 600, 400, 200, 0);
assert.equal(fit.scale, 1);
assert.equal(fit.x, 200);
assert.equal(fit.y, 200);

const fitSmall = fitMermaidView(200, 200, 400, 400, 0);
assert.equal(fitSmall.scale, 0.5);

const collapsed =
  '<svg width="100%" height="100%" style="max-width:0;height:auto" viewBox="0 0 800 400" xmlns="http://www.w3.org/2000/svg"></svg>';
assert.deepEqual(parseMermaidSvgViewBox(collapsed), { width: 800, height: 400 });
const fixed = normalizeMermaidSvg(collapsed);
assert.match(fixed, /width="800"/);
assert.match(fixed, /height="400"/);
assert.doesNotMatch(fixed, /width="100%"/);
assert.match(fixed, /aspect-ratio: 800 \/ 400/);
assert.doesNotMatch(fixed, /max-width:0/);

console.log('ok: mermaid-view');
