/**
 * sessions.setStatus 纯决策核：参数校验、按 phase 补默认胶囊、粘性命中不动胶囊。
 * Run: node test/set-status-plan.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'set-status-plan-'));
const compile = createSharedCompiler(root, tmp);

const { normalizeSetStatus, capsuleForSetStatus, defaultNoteFor, defaultKindFor } = await import(
  pathToFileURL(compile('shared/setStatus.ts')).href
);

// ---------- normalizeSetStatus：至少一项 + 非法值 ----------
{
  assert.throws(() => normalizeSetStatus({}), /phase 与 note 至少传一个/);
  assert.throws(() => normalizeSetStatus({ phase: '   ', note: '  ' }), /phase 与 note 至少传一个/);
  assert.throws(() => normalizeSetStatus({ phase: 'working' }), /phase 必须是 needs_you 或 done/);
  assert.throws(() => normalizeSetStatus({ phase: 'idle', note: '聊天结束' }), /空闲由宿主判断/);
  assert.throws(() => normalizeSetStatus({ phase: 'done2' }), /phase 必须是/);
  // phase 带首尾空白：trim 后是合法值，应通过
  assert.equal(normalizeSetStatus({ phase: ' done ', note: 'x' }).phase, 'done');
  assert.equal(normalizeSetStatus({ note: '自由描述新进展' }).note, '自由描述新进展');
  assert.equal(normalizeSetStatus({ note: '  一二三四五六七八九十  ' }).note, '一二三四五六七八九十');
  assert.equal(normalizeSetStatus({ note: '🔧'.repeat(10) }).note, '🔧'.repeat(10));
  for (const note of ['一二三四五六七八九十一', 'x'.repeat(11), '🔧'.repeat(11)]) {
    assert.throws(() => normalizeSetStatus({ phase: 'done', note }), /10/);
  }

  const onlyNote = normalizeSetStatus({ note: '  排查中  ' });
  assert.equal(onlyNote.note, '排查中', 'note 归一去空白');
  assert.equal(onlyNote.phase, undefined);
  assert.equal(onlyNote.kind, undefined);

  const full = normalizeSetStatus({ phase: 'needs_you', note: '等验收', kind: 'waiting' });
  assert.deepEqual(full, { phase: 'needs_you', note: '等验收', kind: 'waiting' });

  // 非法 kind 不抛（宽松），归一为 undefined 走默认着色
  assert.equal(normalizeSetStatus({ note: 'x', kind: 'bogus' }).kind, undefined);
  console.log('ok: normalizeSetStatus 校验与归一');
}

// ---------- 默认文案 / 着色表 ----------
{
  assert.equal(defaultNoteFor('needs_you'), '等验收');
  assert.equal(defaultNoteFor('done'), '已完成');
  assert.equal(defaultNoteFor('idle'), '空闲');
  assert.equal(defaultKindFor('needs_you'), 'waiting');
  assert.equal(defaultKindFor('done'), 'done');
  assert.equal(defaultKindFor('idle'), 'info');
  console.log('ok: phase 默认胶囊表');
}

// ---------- capsuleForSetStatus：默认补齐 / 粘性命中不动胶囊 ----------
{
  // phase 写入成功且省略 note → 默认文案 + 默认着色（Worker 想漏都难）
  assert.deepEqual(capsuleForSetStatus({ phase: 'needs_you' }, true), {
    label: '等验收',
    kind: 'waiting'
  });
  assert.deepEqual(capsuleForSetStatus({ phase: 'done' }, true), { label: '已完成', kind: 'done' });
  assert.deepEqual(capsuleForSetStatus({ phase: 'idle' }, true), { label: '空闲', kind: 'info' });

  // phase 写入成功 + 显式 note → note 优先，着色借 phase 默认
  assert.deepEqual(capsuleForSetStatus({ phase: 'needs_you', note: '登录修复完成，等验收' }, true), {
    label: '登录修复完成，等验收',
    kind: 'waiting'
  });
  // 显式 kind 永远优先
  assert.deepEqual(capsuleForSetStatus({ phase: 'done', kind: 'error' }, true), {
    label: '已完成',
    kind: 'error'
  });

  // 粘性命中（phase 未写入）且无 note → 不动胶囊
  assert.equal(capsuleForSetStatus({ phase: 'needs_you' }, false), undefined);
  // 粘性命中但显式 note → 照写，按进行中着色
  assert.deepEqual(capsuleForSetStatus({ phase: 'needs_you', note: '等构建' }, false), {
    label: '等构建',
    kind: 'active'
  });

  // 只传 note（干活中途只更新胶囊，看板列不变）→ 进行中着色
  assert.deepEqual(capsuleForSetStatus({ note: '等构建' }, false), { label: '等构建', kind: 'active' });
  assert.deepEqual(capsuleForSetStatus({ note: '构建失败', kind: 'error' }, false), {
    label: '构建失败',
    kind: 'error'
  });
  console.log('ok: capsuleForSetStatus 决策矩阵');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] set-status-plan');
