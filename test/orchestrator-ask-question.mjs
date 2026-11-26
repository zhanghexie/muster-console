/**
 * 调度 askQuestion：Catalog 注册 / 挂卡结算 / 重启消毒 / 回答回注形状。
 * 运行: node test/orchestrator-ask-question.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ask-'));
const compile = createSharedCompiler(root, tmp);

const catalogOut = compile('main/capabilities/catalog.ts');
const { CATALOG_VERSION, getToolDef, WORKER_TOOL_ALLOWLIST, isWorkerAllowedTool } = await import(
  pathToFileURL(catalogOut).href
);

assert.ok(Number(CATALOG_VERSION.split('.')[1] || 0) >= 37, `Catalog 版本随 R-18b 多仓组 bump（≥1.37，当前 ${CATALOG_VERSION}）`);
const def = getToolDef('askQuestion');
assert.ok(def, '调度 Catalog 应有 askQuestion');
assert.equal(def.dangerous, false);
assert.deepEqual(def.parameters.required, ['questions']);
assert.match(def.description, /single\/multi-select and custom input/);
assert.match(def.description, /instead of prose questions/);
assert.match(def.description, /Workers use their own question channel/);
assert.equal(WORKER_TOOL_ALLOWLIST.includes('askQuestion'), false);
assert.equal(isWorkerAllowedTool('askQuestion'), false);
assert.equal(isWorkerAllowedTool('ui.askQuestion'), false);
console.log('ok: catalog / 白名单');

const { mapCursorAskQuestionArgs, formatCursorAskQuestionResult } = await import(
  pathToFileURL(compile('shared/cursorAskQuestion.ts')).href
);
const {
  attachAskQuestionCard,
  buildAskQuestionCard,
  dispatchWaitState,
  findAskQuestionAnchor,
  sanitizeRestoredAskQuestions,
  settleAskQuestionCard
} = await import(pathToFileURL(compile('shared/orchestratorAskQuestion.ts')).href);

const mapped = mapCursorAskQuestionArgs({
  title: '选方案',
  questions: [
    {
      id: 'arch',
      prompt: '用哪种架构？',
      options: [{ label: 'A' }, { label: 'B' }],
      allow_multiple: false
    }
  ]
});
assert.equal(mapped.questions[0].id, 'arch');
assert.equal(mapped.questions[0].header, '选方案');

const assistant = {
  id: 'a1',
  role: 'assistant',
  content: '',
  parts: [{ kind: 'tool', toolCall: { id: 't1', name: 'askQuestion' } }],
  createdAt: 1
};
const queued = { id: 'u2', role: 'user', content: '插话', queued: true, createdAt: 2 };
const card = buildAskQuestionCard('q-1', mapped, assistant.parts.length);
attachAskQuestionCard(assistant, card);
assert.equal(assistant.userQuestion.questionId, 'q-1');
assert.equal(assistant.userQuestion.status, 'pending');
assert.equal(assistant.userQuestion.anchorPartIndex, 1);
// 提问卡选项不写入建议输入。
assert.equal(assistant.suggestedReplies, undefined);
assert.equal(dispatchWaitState(assistant), 'question');
assert.equal(findAskQuestionAnchor([assistant, queued])?.id, 'a1');
console.log('ok: 挂卡 / 等待态 / 锚点');

const settled = settleAskQuestionCard(assistant, 'q-1', {
  kind: 'answered',
  answers: [{ id: 'arch', selected: ['A'] }]
});
assert.ok(settled);
assert.equal(assistant.userQuestion.status, 'answered');
assert.deepEqual(assistant.userQuestion.answers, [{ id: 'arch', selected: ['A'] }]);
assert.equal(dispatchWaitState(assistant), null);
// 结算即失效：建议只是作答快捷方式，答完/取消都摘掉
assert.equal(assistant.suggestedReplies, undefined);
assert.equal(settleAskQuestionCard(assistant, 'other', { kind: 'aborted' }), null);
console.log('ok: 回答回注 / 建议摘除');

const aborted = formatCursorAskQuestionResult({ kind: 'aborted' });
assert.equal(aborted.ok, false);
assert.match(aborted.text, /aborted/);

const restored = sanitizeRestoredAskQuestions([
  {
    id: 'a2',
    role: 'assistant',
    content: 'hi',
    createdAt: 3,
    suggestedReplies: ['A', 'B'],
    userQuestion: { questionId: 'q-old', questions: mapped.questions, status: 'pending' }
  },
  {
    id: 'a3',
    role: 'assistant',
    content: 'done',
    createdAt: 4,
    userQuestion: {
      questionId: 'q-done',
      questions: mapped.questions,
      status: 'answered',
      answers: [{ id: 'arch', selected: ['B'] }]
    }
  }
]);
assert.equal(restored[0].userQuestion.status, 'aborted');
// pending→aborted 翻卡时随卡建议一并剥离（无人应答=建议无处投递）
assert.equal(restored[0].suggestedReplies, undefined);
assert.equal(restored[1].userQuestion.status, 'answered');
assert.equal(
  sanitizeRestoredAskQuestions(restored) === restored,
  true,
  '已消毒再跑应返回原数组'
);
console.log('ok: 重启消毒');

/* ── 提问卡选项不生成建议，单题仍可发送即作答 ── */

// 多个选项也不生成建议
const manyMapped = mapCursorAskQuestionArgs({
  questions: [
    {
      id: 'q',
      prompt: '选哪个？',
      options: [{ label: '一' }, { label: '二' }, { label: '二' }, { label: '三' }, { label: '四' }]
    }
  ]
});
const manyAssistant = { id: 'a9', role: 'assistant', content: '', createdAt: 9 };
attachAskQuestionCard(manyAssistant, buildAskQuestionCard('q-9', manyMapped));
assert.equal(manyAssistant.suggestedReplies, undefined);
manyAssistant.suggestedReplies = ['旧建议'];

// 无选项卡不写建议；且挂新卡时把上一张卡的遗留建议摘净
const freeMapped = mapCursorAskQuestionArgs({ questions: [{ id: 'qf', prompt: '说说想法？' }] });
attachAskQuestionCard(manyAssistant, buildAskQuestionCard('q-10', freeMapped));
assert.equal(manyAssistant.suggestedReplies, undefined);
console.log('ok: 提问卡不生成建议，换卡清除旧建议');

const { answerFromText } = await import(
  pathToFileURL(compile('shared/orchestratorAskQuestion.ts')).href
);
const singleCard = buildAskQuestionCard('q-1', mapped);
// 选项命中 → selected
assert.deepEqual(answerFromText(singleCard, 'A'), [{ id: 'arch', selected: ['A'] }]);
// 自由文本保留普通消息语义
assert.equal(answerFromText(singleCard, 'A，但先跑测试'), null);
assert.deepEqual(answerFromText(singleCard, '  A  '), [{ id: 'arch', selected: ['A'] }]);
for (const label of ['> A', 'A\nB', '[会话批注] 原文：“A”', '[文件批注 a.ts] 原文：“A”', '[网页批注 A] 页面：https://example.test']) {
  assert.equal(answerFromText({ questions: [{ id: 'q', question: '选择', options: [{ label }] }] }, label), null);
}
assert.equal(answerFromText({ questions: [{ id: 'q', question: '选择', options: [{ label: 'A' }, { label: 'A' }] }] }, 'A'), null);

// 多题卡不抢发送通道（回落普通发送/排队）；空文本同 null
const multiCard = buildAskQuestionCard('q-2', {
  questions: [
    { id: 'q1', question: '一？', options: [{ label: 'x' }] },
    { id: 'q2', question: '二？', options: [{ label: 'y' }] }
  ]
});
assert.equal(answerFromText(multiCard, 'x'), null);
assert.equal(answerFromText(singleCard, '   '), null);
console.log('ok: 发送即作答映射');

const promptSrc = fs.readFileSync(path.join(root, 'src/main/agent/systemPrompt.ts'), 'utf8');
assert.match(promptSrc, /Use host\.ask \(kind=choice\) when the user must choose, supply a key fact, or confirm a plan/);
// R-20 来源二教学：决策类提问优先带 options
assert.match(promptSrc, /focused questions with clear options/);
assert.match(promptSrc, /presented through the question card rather than asking for an answer in prose/);
assert.match(promptSrc, /cancel, refusal, or no answer does not count as consent/);
console.log('ok: 系统提示指引');
