/**
 * Capability management must reuse the themed CustomSelect rather than reintroduce
 * native select popups. Scan the production pane and its local settings children;
 * Also prevent new native popups anywhere in the renderer. Only CustomSelect owns a themed base-select; the fallback has no native popup.
 * Run: node test/capability-ui-controls.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pane = path.join(root, 'src/renderer/src/components/settings/CapabilityManagementPane.tsx');
const settingsDir = path.dirname(pane);
const resourcePage = path.join(settingsDir, 'CapabilityManagementResourcePage.tsx');
assert.match(fs.readFileSync(pane, 'utf8'), /<CapabilityManagementResourcePage/, '能力管理主面板必须委托资源页壳');
assert.match(fs.readFileSync(resourcePage, 'utf8'), /cm-manager-grid settings-split/, '资源页壳必须保留列表/详情布局合同');

function nativeSelectSites(sourceFile) {
  const sites = [];
  const visit = node => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
        && ts.isIdentifier(node.tagName) && node.tagName.text === 'select') {
      sites.push(node);
    }
    if (ts.isCallExpression(node) && node.arguments.length
        && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === 'select'
        && ((ts.isIdentifier(node.expression) && node.expression.text === 'createElement')
            || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'createElement'))) {
      sites.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

const parse = (file, source) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
// Guard sanity: comments and descriptive strings are not JSX controls.
assert.equal(nativeSelectSites(parse('fixture.tsx', '/* <select/> */ const note = "<select/>"; const ui = <CustomSelect value="all"/>;')).length, 0);
assert.equal(nativeSelectSites(parse('fixture.tsx', 'const ui = <select><option/></select>;')).length, 1);
assert.equal(nativeSelectSites(parse('fixture.tsx', 'const ui = React.createElement("select", {});')).length, 1);

const visited = new Set();
const violations = [];
function scan(file) {
  if (visited.has(file)) return;
  visited.add(file);
  const sourceFile = parse(file, fs.readFileSync(file, 'utf8'));
  for (const site of nativeSelectSites(sourceFile)) {
    const position = sourceFile.getLineAndCharacterOfPosition(site.getStart(sourceFile));
    violations.push(`${path.relative(root, file).replaceAll('\\', '/')}:${position.line + 1}:${position.character + 1}`);
  }
  // Follow only settings-local children. A refactor cannot hide a native popup in
  // another component while shared controls remain free to own their semantics.
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    const imported = path.resolve(path.dirname(file), specifier);
    const relative = path.relative(settingsDir, imported);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const child = [imported, `${imported}.tsx`, `${imported}.ts`, path.join(imported, 'index.tsx'), path.join(imported, 'index.ts')]
      .find(candidate => /\.tsx?$/.test(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (child) scan(child);
  }
}
scan(pane);
assert.deepEqual(violations, [], `Capability management native select controls must use CustomSelect:\n${violations.join('\n')}`);
const renderer = path.join(root, 'src/renderer/src');
const legacyCounts = new Map([
  ['components/CustomSelect.tsx', 1],
  ['components/ExtensionNavigationTree.tsx', 0],
  ['components/settings/CapabilityCatalog.tsx', 0],
  ['components/settings/ModelParametersPanel.tsx', 0],
  ['components/settings/ShellSettings.tsx', 0]
]);
let rendererFiles = 0;
function guardNewControls(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) guardNewControls(file);
    else if (/\.tsx?$/.test(entry.name)) {
      rendererFiles++;
      const sourceFile = parse(file, fs.readFileSync(file, 'utf8'));
      const sites = nativeSelectSites(sourceFile);
      const relative = path.relative(renderer, file).replaceAll('\\', '/');
      const allowance = legacyCounts.get(relative) ?? 0;
      assert.ok(sites.length <= allowance, `${relative}: ${sites.length} native select control(s), allowed ${allowance}. Reuse CustomSelect; only its shared implementation may own base-select.`);
    }
  }
}
guardNewControls(renderer);
console.log(`capability-ui-controls: ${visited.size} capability settings file(s) without native selects; ${rendererFiles} renderer file(s) checked for new controls`);

const shared = fs.readFileSync(path.join(renderer, 'components/CustomSelect.tsx'), 'utf8');
assert.match(shared, /CSS\.supports\('appearance', 'base-select'\)/, 'native picker must be feature detected');
assert.match(shared, /CustomSelectFallback/, 'unsupported browsers retain the themed fallback');
const css = fs.readFileSync(path.join(renderer, 'styles/base.css'), 'utf8');
assert.match(css, /\.c-select-native,\s*\.c-select-native::picker\(select\)\s*\{\s*appearance: base-select;/, 'both trigger and picker must opt into styling');
