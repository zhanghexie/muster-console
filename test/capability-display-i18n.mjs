import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-display-i18n-'));
try {
  const compile = createSharedCompiler(root, temp);
  const { en } = await import(pathToFileURL(compile('shared/i18n/locales/en.ts')).href);
  const { ATTACHMENT_PROCESSING_FIELDS } = await import(pathToFileURL(compile('shared/attachmentPolicy.ts')).href);
  const ts = createRequire(import.meta.url)('typescript');
  const notesFile = path.join(root, 'src/main/agent/capabilitiesView.ts');
  const notesAst = ts.createSourceFile(notesFile, fs.readFileSync(notesFile, 'utf8'), ts.ScriptTarget.Latest, true);
  const evaluate = node => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => evaluate(span.expression) + span.literal.text).join('');
    throw new Error(`Unsupported init note expression: ${node.getText(notesAst)}`);
  };
  let notes;
  const findNotes = node => {
    if (ts.isPropertyAssignment(node) && node.name.getText(notesAst) === 'initNotes') {
      assert.ok(ts.isArrayLiteralExpression(node.initializer));
      notes = node.initializer.elements.map(evaluate);
    }
    ts.forEachChild(node, findNotes);
  };
  findNotes(notesAst);
  assert.ok(notes && notes.length >= 6, 'inspect the production init notes');

  const paneFile = path.join(root, 'src/renderer/src/components/settings/CapabilityManagementPane.tsx');
  const paneAst = ts.createSourceFile(paneFile, fs.readFileSync(paneFile, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const labels = [];
  const collect = node => {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.initializer)) labels.push(node.initializer.text);
    ts.forEachChild(node, collect);
  };
  const findLabels = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(paneAst) === 'dialogTitle' && node.initializer) collect(node.initializer);
    ts.forEachChild(node, findLabels);
  };
  findLabels(paneAst);
  assert.ok(labels.length >= 5, 'inspect the capability dialog labels');
  assert.deepEqual([...notes, ...labels, ...ATTACHMENT_PROCESSING_FIELDS.map(([, label]) => label)].filter(key => !Object.hasOwn(en, key)), []);
  console.log('capability display i18n: all dynamic labels have translations');
} finally {
  const resolved = fs.realpathSync(temp);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('capability-display-i18n-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
