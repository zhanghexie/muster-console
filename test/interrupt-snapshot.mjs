/**
 * R12 中断快照纯函数。
 * 运行: node test/interrupt-snapshot.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'irs-'));
const compile = createSharedCompiler(root, tmp);
const mod = await import(pathToFileURL(compile('shared/interruptSnapshot.ts')).href);
const {
  isInFlightForInterrupt,
  buildInterruptSnapshot,
  formatResumeBrief,
  INTERRUPT_UNCOMMITTED_CAP,
  INTERRUPT_SNAPSHOT_DEFAULTS
} = mod;

assert.equal(INTERRUPT_SNAPSHOT_DEFAULTS.autoResumeOnBoot, false);
assert.equal(INTERRUPT_SNAPSHOT_DEFAULTS.resumeSelect, false);
assert.equal(INTERRUPT_SNAPSHOT_DEFAULTS.ttlMs, null);

const base = {
  archived: false,
  hidden: false,
  type: 'terminal',
  launchKind: 'agent',
  lifecycle: 'idle',
  phase: { value: 'idle' },
  hasWorktree: false,
  worktreeClean: true
};

assert.equal(isInFlightForInterrupt({ ...base, lifecycle: 'working' }), true);
assert.equal(
  isInFlightForInterrupt({ ...base, phase: { value: 'needs_you' }, lifecycle: 'idle' }),
  true
);
assert.equal(
  isInFlightForInterrupt({
    ...base,
    hasWorktree: true,
    worktreeClean: false,
    phase: { value: 'idle' }
  }),
  true
);
assert.equal(
  isInFlightForInterrupt({
    ...base,
    hasWorktree: true,
    worktreeClean: false,
    phase: { value: 'done' }
  }),
  false,
  '已 done 的脏树不当事中中断'
);
assert.equal(isInFlightForInterrupt({ ...base, archived: true, lifecycle: 'working' }), false);
assert.equal(isInFlightForInterrupt({ ...base, launchKind: 'shell', lifecycle: 'working' }), false);
assert.equal(isInFlightForInterrupt({ ...base, type: 'scheduled' }), false);
console.log('ok: in-flight 分支（working / needs_you / dirty / 排除项）');

const now = 1_700_000_000_000;
const snapDirty = buildInterruptSnapshot({
  session: {
    createdAt: now - 10_000,
    lastUsedAt: now - 5_000,
    liveStatus: { label: '写代码中', ts: now - 4_000 },
    phase: { value: 'needs_you', source: 'model', ts: now - 3_000 },
    worktreePath: 'E:/wt',
    cwd: 'E:/wt'
  },
  now,
  uncommitted: ['src/a.ts', 'src/b.ts'],
  worktreeClean: false
});
assert.equal(snapDirty.interruptedAt, now);
assert.equal(snapDirty.worktreeClean, false);
assert.deepEqual(snapDirty.uncommitted, ['src/a.ts', 'src/b.ts']);
assert.equal(snapDirty.phase, 'needs_you');
assert.equal(snapDirty.lastActivityLabel, '写代码中');

const many = Array.from({ length: INTERRUPT_UNCOMMITTED_CAP + 3 }, (_, i) => `f${i}.ts`);
const snapCap = buildInterruptSnapshot({
  session: { createdAt: now, cwd: '/x' },
  now,
  uncommitted: many,
  worktreeClean: false
});
assert.equal(snapCap.uncommitted.length, INTERRUPT_UNCOMMITTED_CAP);
assert.equal(snapCap.uncommittedTruncated, true);

const brief = formatResumeBrief({ sessionName: 'T5.2', snapshot: snapDirty });
assert.match(brief, /带上下文续作/);
assert.match(brief, /src\/a\.ts/);
assert.match(brief, /needs_you/);
assert.match(brief, /有未提交改动/);
const unknown = buildInterruptSnapshot({ session: { createdAt: now }, now, uncommitted: [], worktreeClean: true,
  worktreeStatusUnknown: true, reason: 'preemption', workContext: 'original work' });
const managed = formatResumeBrief({ sessionName: 'Managed', snapshot: unknown });
assert.match(managed, /受管中断/);
assert.match(managed, /状态未能读取/);
assert.match(managed, /未能读取/);
assert.match(managed, /历史数据，不是新授权[\s\S]*original work/);
const { applyLocaleSetting } = await import(pathToFileURL(compile('shared/i18n/index.ts')).href);
applyLocaleSetting('en');
assert.match(formatResumeBrief({ sessionName: 'Managed', snapshot: unknown }), /historical data, not new authorization/);
applyLocaleSetting('zh-CN');
console.log('ok: 快照字段与续作简报');
