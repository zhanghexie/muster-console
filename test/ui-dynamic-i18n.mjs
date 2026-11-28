import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-dynamic-i18n-'));
try {
  const compile = createSharedCompiler(root, temp);
  const { en } = await import(pathToFileURL(compile('shared/i18n/locales/en.ts')).href);
  const ts = createRequire(import.meta.url)('typescript');
  for (const [name, variable, consumer, min, optional] of [
    ['src/renderer/src/components/settings/FontSettings.tsx', 'SCALE_OPTIONS', 't(s.labelKey)', 3],
    ['src/renderer/src/components/KnowledgePanel.tsx', 'relation', 't(relation)', 5],
    ['src/renderer/src/components/FeedbackCenter.tsx', 'MANUAL_FIELDS', 'fieldCaption(field.label', 8, true],
    ['src/renderer/src/components/FeedbackCenter.tsx', 'STATUS', 't(STATUS[', 6, true],
    ['src/renderer/src/panels/PrReviewPanel.tsx', 'CHECK_LABELS', 't(CHECK_LABELS[', 4],
    ['src/renderer/src/panels/PrReviewPanel.tsx', 'DECISIONS', 't(DECISIONS[', 3],
    ['src/renderer/src/panels/PrReviewPanel.tsx', 'REVIEW_EVENTS', 't(REVIEW_EVENTS[', 3]
  ]) {
    const file = path.join(root, name);
    if (optional && !fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const values = [];
    const collect = node => { if (ts.isStringLiteral(node) && /[\u4e00-\u9fff]/.test(node.text)) values.push(node.text); ts.forEachChild(node, collect); };
    const visit = node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === variable && node.initializer) collect(node.initializer);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    assert.ok(values.length >= min, `${name}: expected the production label initializer`);
    assert.ok(source.includes(consumer), `${name}: labels must be translated at display`);
    if (variable === 'MANUAL_FIELDS') assert.match(source, /fieldCaption\s*=\s*\(label:[\s\S]*?\{t\(label\)\}/, `${name}: field captions must translate their label`);
    if (variable === 'REVIEW_EVENTS') assert.match(source, /TEXT_REVIEW_EVENTS\.map[\s\S]*?\{t\(REVIEW_EVENTS\[event\]\)\}/, `${name}: review options must translate their label`);
    assert.deepEqual(values.filter(value => !Object.hasOwn(en, value)), [], `${name}: missing English labels`);
  }
  for (const key of ['审查完成，结果待核对', '当前引擎不支持此权限模式。', '类型', '反馈正文', '标题']) assert.ok(Object.hasOwn(en, key), `missing English label: ${key}`);
  console.log('ui dynamic i18n: display label resources verified');
} finally {
  const resolved = fs.realpathSync(temp);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('ui-dynamic-i18n-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
