/**
 * 定时任务去 headless：纯函数分区 / 会话 inheritMeta / 提示词摘要。
 * 运行: node test/prompt-tasks-purge.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-'));
const compile = createSharedCompiler(root, tmp);
const { partitionHeadlessPromptTasks, inheritMetaFromPromptTask, summarizePurgedHeadlessTask } =
  await import(pathToFileURL(compile('shared/promptTasks.ts')).href);

const long = `${'请汇总看板 needs_you 并写调度简报，'.repeat(6)}列出阻塞项。`;
const { kept, purged } = partitionHeadlessPromptTasks([
  { id: 't1', name: '终端巡检', prompt: 'ok', mode: 'terminal' },
  { id: 't2', name: '无头日报', prompt: long, mode: 'headless' },
  { id: 't3', name: '存量无 mode', prompt: 'legacy' }
]);
assert.deepEqual(
  kept.map((t) => t.id),
  ['t1', 't3']
);
assert.equal(purged.length, 1);
assert.equal(purged[0].name, '无头日报');
assert.ok(purged[0].promptPreview.endsWith('…'));
assert.ok(purged[0].promptPreview.length <= 81);
console.log('ok: partition 只删 mode=headless');

assert.deepEqual(summarizePurgedHeadlessTask({ id: 'a', name: '短', prompt: '  你好  ' }), {
  id: 'a',
  name: '短',
  promptPreview: '你好'
});

assert.equal(inheritMetaFromPromptTask({}), undefined);
assert.deepEqual(inheritMetaFromPromptTask({ guiMode: 'ask', thinking: 'low' }), {
  guiMode: 'ask',
  thinkingLevel: 'low'
});
assert.deepEqual(
  inheritMetaFromPromptTask({ providerId: 'cursor', modelId: 'grok-4.6', piModeId: 'x' }),
  {
    piModeId: 'x',
    modelOverride: { providerId: 'cursor', modelId: 'grok-4.6' }
  }
);
assert.equal(inheritMetaFromPromptTask({ providerId: 'cursor' }), undefined, '缺 modelId 不写覆盖');

// prompt-tasks F-02：半配模型降级经 onDegraded 上报（不再只有 console.warn）
{
  const notes = [];
  const degraded = inheritMetaFromPromptTask({ providerId: 'cursor', piModeId: 'x' }, (note) => notes.push(note));
  assert.equal(notes.length, 1, '半配模型降级回调一次');
  assert.match(notes[0], /模型只配置了一半/);
  assert.deepEqual(degraded, { piModeId: 'x' }, '降级仍返回无模型覆盖的 meta');
  const quiet = [];
  inheritMetaFromPromptTask({ providerId: 'cursor', modelId: 'm1' }, (note) => quiet.push(note));
  assert.equal(quiet.length, 0, '全配不回调');
  inheritMetaFromPromptTask({ piModeId: 'x' }, (note) => quiet.push(note));
  assert.equal(quiet.length, 0, '无模型字段不回调');
}
console.log('ok: inheritMetaFromPromptTask');

console.log('prompt-tasks-purge: ok');
