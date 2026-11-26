import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ts = createRequire(import.meta.url)('typescript');
const parse = file => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const shared = parse('src/shared/guiHostError.ts');
let labels;
function findLabels(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(shared) === 'GUI_HOST_TIMEOUT_LABELS') {
    const initializer = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
    assert.ok(ts.isArrayLiteralExpression(initializer));
    labels = initializer.elements.map(value => { assert.ok(ts.isStringLiteral(value)); return value.text; });
  }
  ts.forEachChild(node, findLabels);
}
findLabels(shared);
assert.ok(labels?.length);
assert.equal(new Set(labels).size, labels.length, 'timeout label list must not contain duplicates');
const known = new Set(labels), found = new Set();
function walk(folder) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) { walk(file); continue; }
    if (!entry.name.endsWith('.ts')) continue;
    const tree = parse(file);
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(tree);
        const index = name === 'boundedAcpRequest' ? 2 : file.replaceAll('\\', '/').endsWith('/drivers/zcode/driver.ts') && name === 'timeout' ? 1 : -1;
        const argument = node.arguments[index];
        if (argument && ts.isStringLiteral(argument)) {
          found.add(argument.text);
          assert.ok(known.has(argument.text), `untranslated bounded request label in ${file}: ${argument.text}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
}
walk('src/main/agentSession');
assert.ok(found.has('外部 Pi 模型目录') && found.has('ZCode 会话建立'));
// The catalog IPC translates its own tagged deadline at the IPC boundary.
// Export its actual literal labels so the coverage gate checks the dictionary.
const ipc = parse('src/main/ipc/agentSession.ts'), catalogLabels = new Set();
function findCatalogLabels(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ipc) === 'boundedCatalogRequest') {
    const label = node.arguments[1];
    assert.ok(label && ts.isStringLiteral(label), 'catalog request labels must be stable literals');
    catalogLabels.add(label.text);
  }
  ts.forEachChild(node, findCatalogLabels);
}
findCatalogLabels(ipc);
for (const label of ['运行目录检查', 'ACP 检测', '外部引擎检测']) assert.ok(catalogLabels.has(label));
export const catalogRequestLabels = [...catalogLabels];
console.log(`GUI host timeout labels: ${found.size} bounded request labels covered`);
