/** Production ui.render receipt construction; only Electron and smoke execution are offline fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-render-result-'));
try {
  const outfile = path.join(temp, 'host.cjs');
  await build({ stdin: { contents: `export { uiWidgetsHost } from './src/main/capabilities/hosts/uiWidgets';
    export { runAsAgentSession } from './src/main/agent/agentScope';
    export { modelToolResult } from './src/shared/modelToolResult';
    export { RESULT_MAX_CHARS } from './src/shared/toolResultBudget';`, resolveDir: process.cwd() },
    outfile, bundle: true, platform: 'node', format: 'cjs', plugins: [{ name: 'ui-render-fixture', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }));
      b.onResolve({ filter: /uiWidgetSmoke$/ }, () => ({ path: 'smoke', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({ contents: name === 'electron'
        ? `export const app = { getPath: () => ${JSON.stringify(temp)} };`
        : 'export const smokeUiWidgetReport = async () => structuredClone(globalThis.__uiRenderSmoke);' }));
    } }] });
  const { uiWidgetsHost: host, runAsAgentSession, modelToolResult, RESULT_MAX_CHARS } = createRequire(import.meta.url)(outfile);
  const ctx = { getWindow: () => ({ webContents: { send() {} } }),
    sessions: { get: () => ({ runtime: 'pi', workspaceId: 'w' }), isChatRuntime: () => true } };
  const args = { title: 'Result probe', html: '<ma-text>Probe</ma-text>' };
  const render = (context = ctx, input = args) => runAsAgentSession('worker-a', () => host['ui.render'](context, input));
  const serialize = raw => JSON.stringify({ ok: true, result: modelToolResult('host.ui.render', args, raw) });
  globalThis.__uiRenderSmoke = { warnings: ['A small warning'], diagnostics: [
    { code: 'expression_syntax', component: 'ma-text', id: 'price', attribute: 'expr',
      message: 'Unexpected token', expression: 'price +', position: 6, hint: 'Complete the expression' }
  ] };
  const small = await render();
  assert.equal(modelToolResult('host.ui.render', args, small), small, 'ordinary diagnostics keep their exact source receipt');
  assert.deepEqual(JSON.parse(serialize(small)).result, small);
  const smallOpenFailure = await render({ ...ctx, sessions: { ...ctx.sessions, isChatRuntime: () => false },
    browser: { openUiSession() { throw new Error('Could not open the UI page'); } } });
  assert.equal(modelToolResult('host.ui.render', args, smallOpenFailure), smallOpenFailure,
    'ordinary automatic-open failure retains its exact warning and action guidance');

  // executeSmoke admits three distinct errors and their details. Feed its real
  // output fields through the production handler's separate 900/600/512 caps.
  const escaped = '\"\\\n'.repeat(450);
  const diagnostics = Array.from({ length: 3 }, (_, i) => ({ code: 'expression_syntax', component: 'ma-text',
    id: `price-${i}`, name: `price-${i}`, attribute: 'expr', position: 0,
    message: `Error ${i}: ${escaped}`, expression: escaped, hint: `Check ${escaped}` }));
  globalThis.__uiRenderSmoke = { warnings: diagnostics.map(detail => `运行时报错：${detail.message}`), diagnostics };
  for (const [context, input] of [[ctx, args], [{ ...ctx, sessions: { ...ctx.sessions, isChatRuntime: () => false },
    browser: { refreshArtifact() {}, openUiSession() { throw new Error(`Open failed: ${escaped}`); } } }, { ...args, update: small.link }]]) {
    const raw = await render(context, input);
    const before = structuredClone(raw);
    assert.ok(JSON.stringify({ ok: true, result: raw }).length > RESULT_MAX_CHARS,
      'actual host caps still overflow after escaping warnings and diagnostic text');
    assert.ok(fs.existsSync(raw.link), 'the production handler already saved the artifact');
    const wire = serialize(raw), output = JSON.parse(wire);
    assert.ok(wire.length <= RESULT_MAX_CHARS, 'the complete model success envelope fits');
    assert.equal(output.ok, true);
    const receipt = output.result;
    for (const key of ['link', 'markdown', 'version', 'usage', 'diagnosticsOmitted']) assert.deepEqual(receipt[key], raw[key], key);
    assert.deepEqual(receipt.receipt, raw.receipt, 'generation/visibility facts are not shortened or promoted');
    assert.equal(receipt.warnings.length, raw.warnings.length, 'warnings are retained as individually marked previews');
    assert.equal(receipt.diagnostics.length, raw.diagnostics.length);
    for (let i = 0; i < raw.diagnostics.length; i++) {
      for (const key of ['code', 'component', 'id', 'name', 'attribute', 'position', 'expressionOffset', 'expressionLength'])
        assert.equal(receipt.diagnostics[i][key], raw.diagnostics[i][key], `${i}/${key} remains actionable`);
    }
    assert.equal(receipt.modelReceiptTruncated.reason, 'tool-result-budget');
    assert.ok(receipt.modelReceiptTruncated.fields.some(pointer => pointer.startsWith('/warnings/')));
    assert.ok(receipt.modelReceiptTruncated.fields.some(pointer => pointer.startsWith('/diagnostics/')));
    if (raw.presentation) {
      for (const key of ['opened', 'url', 'tabId']) assert.equal(receipt.presentation[key], raw.presentation[key]);
      assert.equal(receipt.presentation.opened, false, 'automatic-open failure stays explicit');
      assert.ok(receipt.presentation.error.length > 0);
      assert.ok(receipt.modelReceiptTruncated.fields.includes('/presentation/error'));
    }
    assert.deepEqual(raw, before, 'raw services and renderer consumers retain the complete source receipt');
    assert.equal(modelToolResult('host.ui.inspect', {}, raw), raw, 'explicit inspection is not a write receipt');
    assert.equal(modelToolResult('ext.ui.render', {}, raw), raw, 'extensions keep their own result contract');
  }
  const longTitle = { ...small, markdown: `[${'Title'.repeat(4000)}](<${small.link.replace(/\\/g, '/')}>)` };
  const titleResult = JSON.parse(serialize(longTitle)).result;
  assert.equal(titleResult.link, small.link);
  assert.ok(titleResult.markdown.endsWith(`](<${small.link.replace(/\\/g, '/')}>)`), 'shortening the label preserves the artifact action target');
  assert.ok(titleResult.modelReceiptTruncated.fields.includes('/markdown'));
  const unknown = { ...small, receipt: { status: 'future', visible: false } };
  assert.equal(modelToolResult('host.ui.render', {}, unknown), unknown, 'unrecognized success shapes pass through');
  for (const failure of [{ ...small, ok: false }, { ...small, error: 'denied' }])
    assert.equal(modelToolResult('host.ui.render', {}, failure), failure, 'failed/unknown output is not presented as a saved artifact');
  console.log('ui-render-tool-result: production escaped receipts fit while artifact delivery/status and truncation evidence survive');
} finally {
  delete globalThis.__uiRenderSmoke;
  fs.rmSync(temp, { recursive: true, force: true });
}
