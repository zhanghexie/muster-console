import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-widget-three-'));
try {
  const compile = createSharedCompiler(process.cwd(), temporary);
  const { buildUiArtifactHtml, writeUiArtifact, UI_ARTIFACT_MAX_BYTES } = await import(pathToFileURL(compile('main/uiArtifacts.ts')).href);
  const { UiWidgetStore } = await import(pathToFileURL(compile('main/uiWidgetStore.ts')).href);
  const errors = [];
  const console = new VirtualConsole(); console.on('jsdomError', error => errors.push(error.message));
  const params = { title: '离线三维', html: `<script>
    window.authorLibrary = maUi.three;
    window.authorGeometry = new maUi.three.BoxGeometry(1, 2, 3);
    window.authorD3 = maUi.d3.range(3);
  </script>` };
  const built = buildUiArtifactHtml(params);
  assert.ok(Buffer.byteLength(built.html) <= UI_ARTIFACT_MAX_BYTES, 'a simple 3D widget fits the generated-artifact limit');
  const dom = new JSDOM(built.html, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: console,
    beforeParse(window) { window.TextEncoder = TextEncoder; }
  });
  try {
    await dom.window.maUi.whenReady();
    assert.equal(dom.window.authorLibrary, dom.window.THREE, '3D API is available before author scripts, using one library instance');
    assert.equal(dom.window.authorLibrary.REVISION, '186');
    assert.equal(typeof dom.window.authorLibrary.WebGLRenderer, 'function');
    assert.equal(typeof dom.window.authorLibrary.OrbitControls, 'function');
    assert.equal(dom.window.authorGeometry.parameters.height, 2);
    assert.deepEqual(Array.from(dom.window.authorD3), [0, 1, 2], 'D3 remains available');
    assert.deepEqual(errors, []);
    dom.window.authorGeometry.dispose();
  } finally { dom.window.close(); }
  assert.ok(built.html.includes('The MIT License') && built.html.includes('three.js authors'), 'redistributed library retains its license');
  const csp = built.html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.ok(csp.includes("script-src 'unsafe-inline';") && csp.includes("connect-src 'none';"), 'offline 3D does not allow external scripts or API requests');

  const userData = path.join(temporary, 'data');
  const dir = path.join(userData, 'agent-sessions', 'three-test', 'ui');
  const store = new UiWidgetStore(userData);
  for (const mode of ['inline', 'browser']) {
    const result = await writeUiArtifact(dir, { ...params, mode });
    assert.equal(result.ok, true, `${mode} creates a usable 3D artifact`);
    const updated = await store.updateArtifact(result.filePath, { ...params, mode, title: '更新三维' });
    assert.equal(updated.artifactVersion, 2, `${mode} updates within the same size budget`);
    const saved = fs.readFileSync(result.filePath, 'utf8');
    await assert.rejects(store.updateArtifact(result.filePath, { ...params, mode, html: 'x'.repeat(UI_ARTIFACT_MAX_BYTES) }), /超出/);
    assert.equal(fs.readFileSync(result.filePath, 'utf8'), saved, 'oversized update preserves the existing artifact');
  }
  const oversized = await writeUiArtifact(dir, { ...params, html: 'x'.repeat(UI_ARTIFACT_MAX_BYTES) });
  assert.equal(oversized.ok, false); assert.match(oversized.error, /上限/);
  globalThis.console.log('ui-widget-three: offline API/author order/D3/license/CSP/create/update/size limits passed');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
