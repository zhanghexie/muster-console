/**
 * Cursor 自定义 askQuestion → Host 提问卡映射（纯函数）。
 * 运行: node test/cursor-ask-question.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-ask-'));
const compile = createSharedCompiler(root, tmp);

const {
  CURSOR_ASK_QUESTION_NAME,
  cursorAskQuestionToolDef,
  mapCursorAskQuestionArgs,
  formatCursorAskQuestionResult
} = await import(pathToFileURL(compile('shared/cursorAskQuestion.ts')).href);

assert.equal(CURSOR_ASK_QUESTION_NAME, 'askQuestion');
const def = cursorAskQuestionToolDef();
assert.equal(def.name, 'askQuestion');
assert.match(def.description, /question|survey/i);
assert.equal(def.inputSchema.required.includes('questions'), true);

{
  const mapped = mapCursorAskQuestionArgs({
    title: '选方案',
    questions: [
      {
        id: 'arch',
        prompt: '用哪种架构？',
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B', description: '更简单' }
        ]
      },
      {
        id: 'libs',
        prompt: '依赖',
        allow_multiple: true,
        options: [{ label: 'React' }, { label: 'Vue' }]
      }
    ]
  });
  assert.equal(mapped.questions.length, 2);
  assert.equal(mapped.questions[0].header, '选方案');
  assert.equal(mapped.questions[0].question, '用哪种架构？');
  assert.deepEqual(
    mapped.questions[0].options,
    [
      { label: 'A' },
      { label: 'B', description: '更简单' }
    ]
  );
  assert.equal(mapped.questions[1].multiSelect, true);
  assert.equal(mapped.questions[1].header, undefined);
}

{
  const mapped = mapCursorAskQuestionArgs({
    questions: [
      {
        question: '继续吗？',
        multiSelect: true,
        options: [{ label: '是', description: '批准' }]
      }
    ]
  });
  assert.equal(mapped.questions[0].question, '继续吗？');
  assert.equal(mapped.questions[0].multiSelect, true);
  assert.equal(mapped.questions[0].options[0].description, '批准');
}

{
  const mapped = mapCursorAskQuestionArgs({
    questions: [{ prompt: '备注', options: ['红', { id: 'blue' }] }]
  });
  assert.equal(mapped.questions[0].options[0].label, '红');
  assert.equal(mapped.questions[0].options[1].label, 'blue');
}

{
  const mapped = mapCursorAskQuestionArgs({ title: '随便说点' });
  assert.equal(mapped.questions.length, 1);
  assert.equal(mapped.questions[0].question, '随便说点');
}

{
  const answered = formatCursorAskQuestionResult({
    kind: 'answered',
    answers: [{ id: 'arch', selected: ['A'], custom: '再想想' }]
  });
  assert.equal(answered.ok, true);
  assert.deepEqual(JSON.parse(answered.text), {
    answers: [{ id: 'arch', selected: ['A'], custom: '再想想' }]
  });
  const aborted = formatCursorAskQuestionResult({ kind: 'aborted' });
  assert.equal(aborted.ok, false);
  assert.ok(aborted.text.includes('aborted'));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] cursor-ask-question');
