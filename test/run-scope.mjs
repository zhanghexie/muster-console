/**
 * 测试范围判定（test/helpers/runScope.mjs）：默认影响面、全量需显式、AI 环境降级。
 * 还原即红：resolveRunScope 退回「无参=全量」或去掉 --all 的 AI 降级、
 * vitestWholeSuiteByAgent 恒返回 null 时，下面对应断言转红。
 * 运行: node test/run-scope.mjs
 */
import assert from 'node:assert/strict';
import {
  AGENT_ENV_MARKERS,
  detectAgent,
  resolveRunScope,
  vitestWholeSuiteByAgent
} from './helpers/runScope.mjs';

const human = {};
const cursor = { CURSOR_AGENT: '1' };
const noFilter = { hasFilters: false };

// 1) 识别 AI 环境
assert.equal(detectAgent(human), null);
assert.equal(detectAgent(cursor), 'CURSOR_AGENT');
assert.equal(detectAgent({ CLAUDECODE: '1' }), 'CLAUDECODE');
assert.equal(detectAgent({ MUSTER_RUNTIME: 'claude' }), 'MUSTER_RUNTIME');
assert.equal(detectAgent({ CODEX_THREAD_ID: 'fixture' }), 'CODEX_THREAD_ID');
assert.equal(vitestWholeSuiteByAgent(['node', 'vitest.mjs', 'run'], { CODEX_SESSION_ID: 'fixture' }), 'CODEX_SESSION_ID');
// 工作台给所有终端都注入的宿主变量不算（人开的普通终端也有）
assert.equal(detectAgent({ MUSTER_HOST: '1', MUSTER_SESSION_TOKEN: 't' }), null);
assert.ok(!AGENT_ENV_MARKERS.includes('MUSTER_HOST'));

// 2) runner：默认影响面，人和 AI 一样
assert.deepEqual(resolveRunScope([], human, noFilter), { scope: 'changed' });
assert.deepEqual(resolveRunScope([], cursor, noFilter), { scope: 'changed' });
assert.deepEqual(resolveRunScope(['--changed'], human, noFilter), { scope: 'changed' });

// 3) --all：人跑全量，AI 降级并报出是谁
assert.deepEqual(resolveRunScope(['--all'], human, noFilter), { scope: 'full' });
assert.deepEqual(resolveRunScope(['--all'], cursor, noFilter), { scope: 'changed', downgradedBy: 'CURSOR_AGENT' });

// 4) --full / TEST_FULL=1 强制全量，AI 环境也不降级（门禁、定时任务靠它）
assert.deepEqual(resolveRunScope(['--full'], cursor, noFilter), { scope: 'full' });
assert.deepEqual(resolveRunScope(['--all'], { ...cursor, TEST_FULL: '1' }, noFilter), { scope: 'full' });
assert.deepEqual(resolveRunScope([], { TEST_FULL: '1' }, noFilter), { scope: 'full' });

// 5) 门禁清单 / 文件名过滤是显式范围，不受影响
assert.deepEqual(resolveRunScope(['--changed-files', 'x.txt'], cursor, noFilter), { scope: 'changed-files' });
assert.deepEqual(resolveRunScope(['git'], cursor, { hasFilters: true }), { scope: 'filter' });

// 6) vitest：AI 不带过滤跑整套才降级
const v = (...args) => ['node', 'vitest.mjs', ...args];
assert.equal(vitestWholeSuiteByAgent(v('run'), human), null);
assert.equal(vitestWholeSuiteByAgent(v('run'), cursor), 'CURSOR_AGENT');
assert.equal(vitestWholeSuiteByAgent(v(), cursor), 'CURSOR_AGENT');
assert.equal(vitestWholeSuiteByAgent(v('run', '--reporter=dot'), cursor), 'CURSOR_AGENT');
assert.equal(vitestWholeSuiteByAgent(v('run', 'test/unit/a.spec.tsx'), cursor), null);
assert.equal(vitestWholeSuiteByAgent(v('related', 'src/a.ts', '--run'), cursor), null);
assert.equal(vitestWholeSuiteByAgent(v('list'), cursor), null);
assert.equal(vitestWholeSuiteByAgent(v('run', '--coverage', '--pool=threads'), cursor), null);
assert.equal(vitestWholeSuiteByAgent(v('run'), { ...cursor, TEST_FULL: '1' }), null);

console.log('run-scope: all ok');
