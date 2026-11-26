/** Production interactive UI artifact renders Mermaid through the bundled Pele engine. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-ui-mermaid-'));
try {
  const compile = createSharedCompiler(process.cwd(), temp);
  const { buildUiArtifactHtml } = await import(pathToFileURL(compile('main/uiArtifacts.ts')).href);
  const { html } = buildUiArtifactHtml({
    title: 'Mermaid',
    html: '<pre class="mermaid">flowchart LR\n  A[开始] --> B[完成]</pre>'
  });
  const errors = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, {
    url: 'file:///mermaid.inline.html', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.ResizeObserver = class { observe() {} disconnect() {} };
      window.requestAnimationFrame = callback => setTimeout(callback, 0);
      window.cancelAnimationFrame = id => clearTimeout(id);
      window.HTMLCanvasElement.prototype.getContext = () => ({ measureText: text => ({ width: String(text).length * 8 }) });
    }
  });
  await new Promise(resolve => dom.window.addEventListener('load', resolve, { once: true }));
  await new Promise(resolve => setTimeout(resolve, 50));
  const host = dom.window.document.querySelector('pre.mermaid');
  assert.ok(host?.querySelector('svg'), 'the artifact should replace the Mermaid source with Pele SVG');
  assert.equal(host?.getAttribute('data-ma-mermaid-state'), 'rendered');
  assert.equal(host?.classList.contains('ma-mermaid-rendered'), true);
  assert.deepEqual(errors, [], `artifact runtime errors: ${errors.join('; ')}`);
  dom.window.close();
  console.log('ui-widget-mermaid: artifact renders Mermaid through bundled Pele and reports no runtime errors');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
