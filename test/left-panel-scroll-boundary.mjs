import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = ts.createSourceFile('LeftPanel.tsx', readFileSync(new URL('../src/renderer/src/panels/LeftPanel.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
assert.equal(source.parseDiagnostics.length, 0, 'LeftPanel JSX must remain balanced');
const ancestors = [];
let workspaceFound = false;
let groupCount = 0;
function className(node) {
  const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
  return opening?.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(source) === 'className')?.initializer?.getText(source) ?? '';
}
function visit(node) {
  const cls = className(node);
  if (cls === '"left-ws-slot"') {
    workspaceFound = true;
    assert(ancestors.some(n => className(n) === '"left-panel"'));
    assert(!ancestors.some(n => className(n) === '"left-panel-scroll"'));
  }
  if (cls.includes('left-section-scroll')) {
    groupCount++;
    assert(ancestors.some(n => className(n) === '"left-panel-scroll"'));
  }
  ancestors.push(node);
  ts.forEachChild(node, visit);
  ancestors.pop();
}
visit(source);
assert(workspaceFound);
assert.equal(groupCount, 2);
