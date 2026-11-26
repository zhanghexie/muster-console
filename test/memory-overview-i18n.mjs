import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-overview-i18n-'));
try {
  const compile = createSharedCompiler(root, temp);
  const { en } = await import(pathToFileURL(compile('shared/i18n/locales/en.ts')));
  const ts = createRequire(import.meta.url)('typescript');
  const source = fs.readFileSync(path.join(root, 'src/renderer/src/components/MemoryOverview.tsx'), 'utf8');
  const ast = ts.createSourceFile('MemoryOverview.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const labels = [];
  const visit = node => {
    if (ts.isPropertyAssignment(node) && ['titleKey', 'subKey', 'tipTitleKey', 'tipKey'].includes(node.name.getText(ast)) && ts.isStringLiteral(node.initializer)) labels.push(node.initializer.text);
    if (ts.isVariableDeclaration(node) && ['LABELS', 'KIND_LABEL_KEY'].includes(node.name.getText(ast)) && node.initializer) {
      const collect = child => {
        if (ts.isPropertyAssignment(child) && ts.isStringLiteral(child.initializer) && /[\u4e00-\u9fff]/.test(child.initializer.text)) labels.push(child.initializer.text);
        ts.forEachChild(child, collect);
      };
      collect(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const routeSource = fs.readFileSync(path.join(root, 'src/renderer/src/memoryCenterRoute.ts'), 'utf8');
  const routeAst = ts.createSourceFile('memoryCenterRoute.ts', routeSource, ts.ScriptTarget.Latest, true);
  const visitRoute = node => {
    if (ts.isPropertyAssignment(node) && node.name.getText(routeAst) === 'labelKey' && ts.isStringLiteral(node.initializer)) labels.push(node.initializer.text);
    ts.forEachChild(node, visitRoute);
  };
  visitRoute(routeAst);
  // Profile-write summaries are persisted as translation keys with arguments,
  // then rendered by the same event view. Check the actual producer, too.
  const serviceSource = fs.readFileSync(path.join(root, 'src/main/memory/service.ts'), 'utf8');
  const serviceAst = ts.createSourceFile('service.ts', serviceSource, ts.ScriptTarget.Latest, true);
  const eventKeys = [];
  const visitService = node => {
    if (ts.isObjectLiteralExpression(node)) {
      const props = node.properties.filter(ts.isPropertyAssignment);
      if (props.some(p => p.name.getText(serviceAst) === 'kind' && ts.isStringLiteral(p.initializer) && p.initializer.text === 'profile_write')) {
        const summary = props.find(p => p.name.getText(serviceAst) === 'summary');
        assert.ok(summary && ts.isStringLiteral(summary.initializer), 'profile event needs a stable display key');
        eventKeys.push(summary.initializer.text);
      }
    }
    ts.forEachChild(node, visitService);
  };
  visitService(serviceAst);
  assert.equal(eventKeys.length, 1, 'must inspect the actual profile event producer');
  labels.push(...eventKeys);
  assert.ok(labels.length > 20, 'must inspect the actual memory overview data');
  assert.deepEqual(labels.filter(label => !Object.hasOwn(en, label)), [], 'memory overview labels need English translations');
  console.log('memory-overview-i18n: ok');
} finally {
  const resolved = fs.realpathSync(temp);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('memory-overview-i18n-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
