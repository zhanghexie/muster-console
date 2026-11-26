/** Offline import-graph regression: active memory entry points must not load retired approval UI/services. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainLeaf = 'src/main/memory/centerState.ts';
const viewLeaf = 'src/renderer/src/components/MemoryIntentTab.tsx';
const source = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const normalize = abs => path.relative(root, abs).split(path.sep).join('/');

// Transpile first so a type-only service reference cannot be mistaken for a runtime dependency.
function runtimeEdges(rel) {
  const emitted = ts.transpileModule(source(rel), {
    fileName: rel,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.Preserve }
  }).outputText;
  const file = ts.createSourceFile(rel, emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edges = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      edges.push({ spec: node.moduleSpecifier.text, node });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      edges.push({ spec: node.arguments[0].text, node });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return edges;
}

function resolveRelative(rel, spec) {
  const base = path.resolve(root, path.dirname(rel), spec);
  const resolved = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]
    .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  assert.ok(resolved, `${rel}: missing relative dependency ${spec}`);
  return normalize(resolved);
}

function importedNames(edge) {
  if (!ts.isImportDeclaration(edge.node)) return [];
  const bindings = edge.node.importClause?.namedBindings;
  return bindings && ts.isNamedImports(bindings) ? bindings.elements.map(element => (element.propertyName ?? element.name).text) : [];
}

const liveMainNames = ['memoryCenterIntents', 'memoryCenterCancelIntent', 'memoryCenterRearmIntent'];
for (const [consumer, target, names] of [
  ['src/main/memory/ipc.ts', mainLeaf, liveMainNames],
  ['src/renderer/src/components/KnowledgeCenter.tsx', viewLeaf, ['IntentTab']]
]) {
  const edges = runtimeEdges(consumer);
  const leafImports = edges.filter(edge => edge.spec.startsWith('.') && resolveRelative(consumer, edge.spec) === target);
  assert.equal(leafImports.length, 1, `${consumer} must import the live leaf directly`);
  for (const name of names) assert.ok(importedNames(leafImports[0]).includes(name), `${consumer} must import ${name} from ${target}`);
  for (const edge of edges) {
    if (!edge.spec.startsWith('.')) continue;
    assert.ok(!/\/(?:center\.ts|MemoryCenterTabs\.tsx)$/.test(resolveRelative(consumer, edge.spec)), `${consumer} must not import the retired hub`);
  }
}
assert.ok(!runtimeEdges('src/renderer/src/components/settings/MemoryPane.tsx').some(edge=>edge.spec.startsWith('.')&&resolveRelative('src/renderer/src/components/settings/MemoryPane.tsx',edge.spec)===viewLeaf),'memory settings no longer depend on vector status UI');

const seen = new Set();
function walk(rel, trail = []) {
  assert.ok(!/^src\/main\/memory\/(?:center\.ts|consolidation\/)/.test(rel), `retired approval/consolidation dependency: ${[...trail, rel].join(' -> ')}`);
  assert.ok(!/^src\/renderer\/src\/components\/(?:MemoryCenterTabs|MemoryPanel)\.tsx$/.test(rel), `retired memory UI dependency: ${[...trail, rel].join(' -> ')}`);
  if (seen.has(rel)) return;
  seen.add(rel);
  for (const edge of runtimeEdges(rel)) {
    if (!edge.spec.startsWith('.')) continue;
    const next = resolveRelative(rel, edge.spec);
    if (/\.tsx?$/.test(next)) walk(next, [...trail, rel]);
  }
}
walk(mainLeaf);
walk(viewLeaf);
assert.ok(!seen.has('src/main/memory/service.ts'), 'the service singleton reference must remain type-only');

for (const [legacy, target, names] of [
  ['src/main/memory/center.ts', mainLeaf, [...liveMainNames]]
  // X4-F06（2026-10-25）：MemoryCenterTabs/MemoryPanel 死组件树已删除，渲染层不再
  // 有 legacy 重导出节点；walk() 的 retired-UI 断言保留作复燃绊线。
]) {
  const exports = runtimeEdges(legacy).filter(edge => ts.isExportDeclaration(edge.node) && edge.spec.startsWith('.') && resolveRelative(legacy, edge.spec) === target);
  const exportedNames = exports.flatMap(edge => edge.node.exportClause && ts.isNamedExports(edge.node.exportClause)
    ? edge.node.exportClause.elements.map(element => element.name.text) : []);
  for (const name of names) {
    assert.ok(exportedNames.includes(name), `${legacy} must re-export ${name} for legacy tests`);
    assert.ok(!new RegExp(`export\\s+function\\s+${name}\\b`).test(source(legacy)), `${name} must have a single implementation in its leaf`);
  }
}

console.log(`memory curator legacy boundary passed (${seen.size} runtime source modules inspected; no storage or model access)`);
