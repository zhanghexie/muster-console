/**
 * 渲染层会 import 的 src/shared 不得依赖 Node 全局。
 * 这次黑屏就是 pathKey 直接读 process。
 * 运行: node test/renderer-safe-shared.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { builtinModules, createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rendererDir = path.join(root, 'src', 'renderer');
const sharedDir = path.join(root, 'src', 'shared');

function walk(dir, acc = []) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(name.name)) acc.push(p);
  }
  return acc;
}

/** Read runtime imports from the syntax tree; a type import of the same
 * module must never hide a separate value import. */
function runtimeImports(source, file = 'source.ts') {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports = [];
  for (const node of parsed.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause?.isTypeOnly) continue;
      const named = clause?.namedBindings;
      if (clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length > 0 &&
          named.elements.every(element => element.isTypeOnly)) continue;
      imports.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.isTypeOnly) continue;
      const named = node.exportClause;
      if (named && ts.isNamedExports(named) && named.elements.length > 0 && named.elements.every(element => element.isTypeOnly)) continue;
      imports.push(node.moduleSpecifier.text);
    }
  }
  const visitDynamic = node => {
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visitDynamic);
  };
  visitDynamic(parsed);
  return imports;
}

assert.deepEqual(runtimeImports(`
  import type { A } from './mixed';
  import { B } from './mixed';
  import { type C } from './type-only';
  import { type D, E } from './mixed';
  import './side-effect';
  export type { F } from './type-export';
  export { value } from './value-export';
  const lazy = () => import('node:fs');
  const other = require('path');
`), ['./mixed', './mixed', './side-effect', './value-export', 'node:fs', 'path']);

const nodeBuiltins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const isNodeBuiltin = specifier => specifier.startsWith('node:') || nodeBuiltins.has(specifier);
assert.ok(isNodeBuiltin('fs') && isNodeBuiltin('node:fs') && !isNodeBuiltin('./fs'));

/** 渲染层值 import 的 shared 模块名（不含 import type） */
function rendererSharedModules() {
  const names = new Set();
  for (const file of walk(rendererDir)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const specifier of runtimeImports(src, file)) {
      const match = specifier.match(/^(?:\.\.\/)+shared\/(.+)$/);
      if (match) names.add(match[1].replace(/\.ts$/, ''));
    }
  }
  assert.ok(names.has('pathKey'), '扫描应至少看到 GitPanel 的 pathKey');
  return [...names].sort();
}

function unguardedProcessRefs(src) {
  const hits = [];
  const parsed = ts.createSourceFile('shared.ts', src, ts.ScriptTarget.Latest, true);
  const lines = src.split(/\r?\n/);
  const guardLines = new Set();
  const findGuards = node => {
    if (ts.isTypeOfExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'process') {
      guardLines.add(parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line);
    }
    ts.forEachChild(node, findGuards);
  };
  findGuards(parsed);
  const visit = node => {
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        ts.isIdentifier(node.expression) && node.expression.text === 'process') {
      const index = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line;
      const line = lines[index];
      if (!guardLines.has(index)) hits.push(`${index + 1}:${line.trim()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return hits;
}

assert.deepEqual(unguardedProcessRefs('/** process. is a comment */\nconst x = typeof process !== "undefined" ? process.env.X : "";'), []);
assert.equal(unguardedProcessRefs('const x = process.env.X;').length, 1);
assert.equal(unguardedProcessRefs('const note = "typeof process"; process.env.X;').length, 1);

function loadInRendererVm(relName) {
  const file = path.join(sharedDir, `${relName}.ts`);
  if (!fs.existsSync(file)) return { skipped: 'no-file' };
  const src = fs.readFileSync(file, 'utf8');
  const imports = runtimeImports(src, file);
  if (imports.some(isNodeBuiltin)) {
    throw new Error(`${relName} 含 Node 内置模块 import，渲染层不能用`);
  }
  const unguarded = unguardedProcessRefs(src);
  assert.equal(unguarded.length, 0, `${relName} 未守卫的 process：\n${unguarded.join('\n')}`);

  if (imports.length) return { skipped: 'has-imports' };

  const { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    }
  });
  const sandbox = {
    exports: {},
    module: { exports: {} },
    navigator: { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }
  };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(outputText, sandbox, { filename: `${relName}.cjs` });
  return sandbox.module.exports;
}

const modules = rendererSharedModules();
const loaded = [];
for (const name of modules) {
  const exp = loadInRendererVm(name);
  if (exp?.skipped) continue;
  loaded.push(name);
  assert.ok(exp && typeof exp === 'object', `${name} 应能在无 process 的 VM 里加载`);
}

const pathKeyMod = loadInRendererVm('pathKey');
assert.equal(typeof pathKeyMod.pathKey, 'function');
assert.equal(pathKeyMod.pathKey('D:/Foo/Bar'), pathKeyMod.pathKey('D:\\Foo\\Bar'));
assert.equal(pathKeyMod.pathKey('D:/Foo/Bar/'), pathKeyMod.pathKey('D:/Foo/Bar'));

console.log(
  `renderer-safe-shared ok (${modules.length} imported, ${loaded.length} vm-loaded: ${loaded.join(', ')})`
);
