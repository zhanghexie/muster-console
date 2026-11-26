/** Exercise the real registry filter: Codex GUI must retain widgets and memory. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-toolset-'));
try {
  const compile = createSharedCompiler(process.cwd(), tmp);
  let source = fs.readFileSync('src/main/agentSession/tools/registry.ts', 'utf8');
  for (const spec of ['../../../shared/agentRuntimeCapabilities', '../../../shared/hostTools', './discovery']) {
    const rel = spec === './discovery' ? 'main/agentSession/tools/discovery.ts' : spec.includes('Capabilities') ? 'shared/agentRuntimeCapabilities.ts' : 'shared/hostTools/index.ts';
    source = source.replace(`from '${spec}'`, `from '${pathToFileURL(compile(rel)).href}'`);
  }
  const ids = ['ui.render', 'ui.inspect', 'memory.search', 'memory.list', 'memory.note', 'memory.journal', 'memory.correct', 'memory.correctionStatus', 'memory.remember', 'sessions.setStatus'];
  source = source.replace(/import \{ buildCatalogHostTools \}[^;]+;/, `const buildCatalogHostTools = () => ${JSON.stringify(ids)}.map(id => ({ id, description: id, permissionClass: 'read' }));`)
    .replace(/import \{ buildBgTaskTools \}[^;]+;/, 'const buildBgTaskTools = () => [];')
    .replace(/import \{ buildNodeReplTools \}[^;]+;/, 'const buildNodeReplTools = () => [];')
    .replace(/import \{ bindSessionHostTools \}[^;]+;/, 'const bindSessionHostTools = tools => tools;');
  const output = path.join(tmp, 'registry.mjs');
  fs.writeFileSync(output, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  const { buildSessionToolset } = await import(pathToFileURL(output));
  for (const runtimeId of ['codex-gui', 'pi', 'claude']) {
    const result = buildSessionToolset({}, { runtimeId });
    for (const id of ids) {
      assert.ok(result.hostTools.some(tool => tool.id === id), `${runtimeId} exposes ${id}`);
    }
  }
  const acp = buildSessionToolset({}, { runtimeId: 'acp' });
  assert.deepEqual(acp.hostTools.map(tool => tool.id), ids.filter(id => id.startsWith('memory.') || id === 'sessions.setStatus'));
  const denied = buildSessionToolset({}, { runtimeId: 'codex-gui', hostToolDeny: ['ui.render'], excludeHostTools: ['memory.note'] });
  assert.ok(!denied.hostTools.some(tool => ['ui.render', 'memory.note'].includes(tool.id)));
  console.log('ok: GUI tool registration, ACP boundary and deny filters');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
