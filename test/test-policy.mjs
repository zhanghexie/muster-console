/** Daily profiles, resource ceilings, opt-in hooks, dry-run and timeout behavior. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { suiteBudgetMs, testCaseBudgetMs, testJobs, testDeadline } from './helpers/resources.mjs';
import { dailySelection, dailyUnitPlan, SMOKE_TESTS, SMOKE_SPECS, testProfile } from './helpers/profiles.mjs';
import { execute } from './helpers/execute.mjs';
import { acquireTestLease } from './helpers/lease.mjs';
import { selectAffected, buildImpactGraph } from './helpers/impact.mjs';
import { uninstallHooks } from '../scripts/uninstall-hooks.mjs';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-policy-'));
try {
  assert.equal(testJobs({}), 2);
  for (const invalid of ['NaN', '0', '-1', '1.5', 'Infinity']) assert.equal(testJobs({ TEST_JOBS: invalid }), 2);
  assert.equal(testJobs({ TEST_JOBS: '1' }), 1);
  assert.equal(testJobs({ TEST_JOBS: '16' }), 4);
  assert.equal(suiteBudgetMs('full'), 3_600_000, 'full coverage has enough time for Git and browser tests');
  assert.equal(suiteBudgetMs('filter'), 175_000, 'specialized suites retain their three-minute limit');
  assert.equal(testCaseBudgetMs('full', 3_600_000), 300_000, 'one stuck process cannot consume the full suite');
  assert.equal(testCaseBudgetMs('full', 1000), 1000, 'the shared deadline still wins');
  assert.equal(testCaseBudgetMs('filter', 175_000), 175_000, 'non-full scopes keep their existing budget');
  assert.equal(testDeadline(suiteBudgetMs('full'), { TEST_BUDGET_MS: '9999999' }, 1000), 3_601_000, 'full budget cannot exceed its own limit');
  assert.equal(testDeadline(55_000, { TEST_BUDGET_MS: '999999' }, 1000), 56000, 'daily budget cannot be extended');
  assert.equal(testDeadline(175_000, { TEST_DEADLINE: '2000' }, 1000), 2000, 'all phases must share the earlier parent deadline');
  assert.equal(testDeadline(175_000, { TEST_BUDGET_MS: '500' }, 1000), 1500);
  for (const file of [...SMOKE_TESTS.map(name => `test/${name}`), ...SMOKE_SPECS]) {
    assert.ok(fs.existsSync(path.join(root, file)), `smoke test missing: ${file}`);
  }
  assert.equal(testProfile(root, 'git-hunk-adopt.mjs'), 'integration');
  assert.equal(testProfile(root, 'workspace-material-visual.mjs'), 'visual');
  assert.equal(testProfile(root, 'design-lint.mjs'), 'audit');
  assert.equal(testProfile(root, 'chat-time.mjs'), 'daily');
  const designLint = fs.readFileSync(path.join(root, 'test/design-lint.mjs'), 'utf8');
  assert.doesNotMatch(designLint, /\.muster\/extensions\/daily-report/, 'audit must not inspect a local installed extension');
  assert.match(designLint, /resources\/extensions\/daily-report\/(?:ui\/)?panel\.html/, 'audit must check the distributable source');

  fs.mkdirSync(path.join(tmp, 'test'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src/shared'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src/shared/a.ts'), 'export const a = 1;');
  fs.writeFileSync(path.join(tmp, 'src/shared/b.ts'), 'export const b = 1;');
  fs.writeFileSync(path.join(tmp, 'test/chat-time.mjs'), "compile('shared/a.ts'); readdirSync(temp); readFileSync('src/shared/a.ts');");
  fs.writeFileSync(path.join(tmp, 'test/other.mjs'), "load('shared/b.ts');");
  fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
  const graph = buildImpactGraph(tmp, ['chat-time.mjs', 'other.mjs']);
  assert.equal(graph.alwaysRun.size, 0, 'fixture traversal must not classify a behavioral test as a source scan');
  assert.ok(graph.deps.get('other.mjs').has('src/shared/b.ts'), 'load wrapper needs a dependency edge');
  assert.deepEqual(dailySelection(tmp, ['chat-time.mjs', 'other.mjs'], ['src/shared/b.ts'], selectAffected).selected, ['other.mjs']);
  const broad = dailySelection(tmp, ['chat-time.mjs', 'other.mjs'], ['package.json', 'src/shared/b.ts'], selectAffected);
  assert.deepEqual(broad.selected, ['chat-time.mjs', 'other.mjs'], 'smoke plus separately affected regression');
  assert.equal(broad.broad, true);
  assert.deepEqual(dailySelection(tmp, ['chat-time.mjs', 'other.mjs'], ['package.json'], selectAffected).selected, ['chat-time.mjs'], 'configuration must not silently request the full tier');
  assert.deepEqual(dailySelection(tmp, ['chat-time.mjs'], ['docs/x.md'], selectAffected).selected, []);
  const many = Array.from({ length: 25 }, (_, i) => `related-${i}.mjs`);
  for (const name of many) fs.writeFileSync(path.join(tmp, 'test', name), "load('shared/b.ts');");
  const bounded = dailySelection(tmp, many, ['src/shared/b.ts', 'test/related-24.mjs'], selectAffected);
  assert.equal(bounded.selected.length, 16);
  assert.ok(bounded.selected.includes('related-24.mjs'), 'directly edited daily tests outrank sampling');
  assert.equal(bounded.deferredRelated.length, 9);
  const guards = Array.from({ length: 20 }, (_, i) => `always-${i}.mjs`);
  for (const name of guards) fs.writeFileSync(path.join(tmp, 'test', name), '// unresolved source guard');
  fs.writeFileSync(path.join(tmp, 'test/zzz-specific.mjs'), "compile('shared/b.ts');");
  const provenHit = dailySelection(tmp, [...guards, 'zzz-specific.mjs'], ['src/shared/b.ts'], selectAffected);
  assert.equal(provenHit.selected[0], 'zzz-specific.mjs', 'actual dependency hits must outrank unrelated alwaysRun floors');
  for (const spec of [...SMOKE_SPECS, ...many.map(name => `test/unit/${name}.spec.tsx`)]) {
    fs.mkdirSync(path.dirname(path.join(tmp, spec)), { recursive: true });
    fs.writeFileSync(path.join(tmp, spec), "import './b';");
  }
  const boundedUnit = dailyUnitPlan(tmp, ['src/shared/b.ts', 'test/unit/related-24.mjs.spec.tsx'], { mode: 'full' });
  assert.equal(boundedUnit.files.length, 6);
  assert.ok(boundedUnit.files.includes('test/unit/related-24.mjs.spec.tsx'));
  assert.ok(SMOKE_SPECS.every(spec => boundedUnit.files.includes(spec)));
  fs.writeFileSync(path.join(tmp, 'src/shared/a.ts'), "export { b } from './b';");
  assert.ok(buildImpactGraph(tmp, ['chat-time.mjs']).deps.get('chat-time.mjs').has('src/shared/b.ts'), 'closure cache must not survive a later analysis');

  const env = {};
  const release = acquireTestLease(tmp, env);
  assert.throws(() => acquireTestLease(tmp, {}), /已有测试命令/);
  acquireTestLease(tmp, { ...env })();
  assert.throws(() => acquireTestLease(tmp, {}), /已有测试命令/);
  release();
  acquireTestLease(tmp, {})();

  const calls = [];
  assert.match(uninstallHooks(tmp, args => { calls.push(args); return 'scripts/githooks'; }), /已卸载/);
  assert.deepEqual(calls.at(-1), ['config', '--local', '--unset', 'core.hooksPath']);
  calls.length = 0;
  assert.match(uninstallHooks(tmp, args => { calls.push(args); return 'custom-hooks'; }), /保留/);
  assert.equal(calls.length, 1);
  assert.match(uninstallHooks(tmp, () => { throw Object.assign(new Error('absent'), { status: 1 }); }), /未安装/);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.prepare, undefined, 'npm install must not install test hooks');
  const install = execFileSync(process.execPath, [path.join(root, 'scripts/install-hooks.mjs')], { env: { ...process.env, npm_lifecycle_event: 'prepare' }, encoding: 'utf8' });
  assert.match(install, /默认不安装/);

  const list = path.join(tmp, 'changed.txt');
  fs.writeFileSync(list, 'test/unit/confirm-dialog.spec.tsx');
  const dryRun = await execute(process.execPath, [path.join(root, 'test/run.mjs'), '--changed-files', list, '--list'], { cwd: root, env: process.env, timeoutMs: 15_000 });
  assert.equal(dryRun.code, 0, dryRun.out);
  assert.match(dryRun.out, /unit:.*files/);
  assert.doesNotMatch(dryRun.out, /Vitest 组件单测|RUN v|passed/);
  const firstPush = await execute(process.execPath, [path.join(root, 'test/run.mjs'), '--list'], {
    cwd: root, env: { ...process.env, TEST_FULL: '0', GITHUB_ACTIONS: 'true', MUSTER_CI_TEST_BASE: '0'.repeat(40) }, timeoutMs: 15_000
  });
  assert.equal(firstPush.code, 0, firstPush.out);
  assert.match(firstPush.out, /quick-smoke/);
  assert.match(firstPush.out, /chat-time\.mjs/);
  assert.match(firstPush.out, /confirm-dialog\.spec\.tsx/);
  const fullList = await execute(process.execPath, [path.join(root, 'test/run.mjs'), '--full', '--list'], {
    cwd: root, env: { ...process.env, TEST_DEADLINE: '', TEST_BUDGET_MS: '200000' }, timeoutMs: 15_000
  });
  assert.equal(fullList.code, 0, fullList.out);
  assert.match(fullList.out, /unit: \{"mode":"full"\}/);
  assert.doesNotMatch(fullList.out, /refresh-all-metaagent\.mjs/, 'manual refresh must stay outside offline runs');
  assert.match(fullList.out, /budget=200s/, 'the full runner must not silently reinstate the old 175s limit');
  const playwrightBin = path.join(path.dirname(require.resolve('@playwright/test/package.json')), 'cli.js');
  // Listing registers specs. A fixture path keeps Electron module loading offline.
  const playwrightList = await execute(process.execPath, [playwrightBin, 'test', 'smoke', '--list'], {
    cwd: root, env: { ...process.env, ELECTRON_OVERRIDE_DIST_PATH: tmp }, timeoutMs: 5000
  });
  assert.equal(playwrightList.code, 0, playwrightList.out);
  assert.match(playwrightList.out, /Total:.*tests.*file/);

  // Exercise artifact retention through the real Playwright CLI in an isolated checkout.
  const playwrightRoot = path.join(tmp, 'playwright-output');
  const resultsRoot = path.join(playwrightRoot, 'test-results');
  const priorResult = path.join(resultsRoot, 'run-00000000-0000-0000-0000-000000000000', 'keep.txt');
  fs.mkdirSync(path.dirname(priorResult), { recursive: true });
  fs.writeFileSync(priorResult, 'previous run');
  const specDir = path.join(playwrightRoot, 'test', 'e2e'); fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, 'isolation.spec.cjs'), `
    const { test, expect } = require(${JSON.stringify(require.resolve('@playwright/test'))});
    const fs = require('node:fs');
    test('passes', async ({}, info) => {
      fs.writeFileSync(info.outputPath('result.txt'), 'passed fixture');
    });
    test('fails', async ({}, info) => {
      fs.writeFileSync(info.outputPath('result.txt'), 'failed fixture');
      expect(false).toBe(true);
    });
  `);
  const setupFile = 'test/helpers/e2e-artifacts.ts';
  fs.mkdirSync(path.join(playwrightRoot, path.dirname(setupFile)), { recursive: true });
  fs.copyFileSync(path.join(root, setupFile), path.join(playwrightRoot, setupFile));
  const configFile = path.join(playwrightRoot, 'playwright.config.cjs');
  require('esbuild').buildSync({ entryPoints: [path.join(root, 'playwright.config.ts')], outfile: configFile, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' });
  const moduleRoot = path.dirname(path.dirname(path.dirname(require.resolve('@playwright/test/package.json'))));
  const runPlaywright = (...args) => execute(process.execPath, [playwrightBin, 'test', '--config', configFile, '--retries=0', ...args], {
    cwd: playwrightRoot, env: { ...process.env, NODE_PATH: moduleRoot, TEST_LEASE_TOKEN: '', TEST_DEADLINE: '', TEST_BUDGET_MS: '', MUSTER_PLAYWRIGHT_RUN_ID: '' }, timeoutMs: 15_000
  });
  const passingRun = await runPlaywright('--grep', 'passes', '--reporter=list');
  assert.equal(passingRun.code, 0, passingRun.out);
  assert.deepEqual(fs.readdirSync(resultsRoot), [path.basename(path.dirname(priorResult))], `a passing run must remove its entire default output directory\n${passingRun.out}`);

  const failingRun = await runPlaywright();
  assert.equal(failingRun.code, 1, failingRun.out);
  const failedRuns = fs.readdirSync(resultsRoot).filter(name => name !== path.basename(path.dirname(priorResult)));
  assert.equal(failedRuns.length, 1, 'a failed run must retain its own output directory');
  assert.match(failedRuns[0], /^run-[\da-f-]+$/i);
  const failedOutput = path.join(resultsRoot, failedRuns[0]);
  assert.equal(fs.readFileSync(path.join(failedOutput, 'isolation-fails', 'result.txt'), 'utf8'), 'failed fixture');
  assert.equal(fs.readFileSync(path.join(failedOutput, 'isolation-passes', 'result.txt'), 'utf8'), 'passed fixture');

  const customOutput = path.join(playwrightRoot, 'acceptance evidence');
  const keptRun = await runPlaywright('--grep', 'passes', '--output', customOutput);
  assert.equal(keptRun.code, 0, keptRun.out);
  assert.equal(fs.readFileSync(path.join(customOutput, 'isolation-passes', 'result.txt'), 'utf8'), 'passed fixture');
  assert.equal(fs.readFileSync(priorResult, 'utf8'), 'previous run', 'a new run must preserve prior results');
  assert.equal(fs.readFileSync(path.join(failedOutput, 'isolation-fails', 'result.txt'), 'utf8'), 'failed fixture', 'a later run must preserve failed diagnostics');

  const success = await execute(process.execPath, ['-e', 'console.log("fixture-ok")'], { timeoutMs: 5000 });
  assert.equal(success.code, 0);
  let signalFirstOutput;
  const firstOutput = new Promise(resolve => { signalFirstOutput = resolve; });
  const streamed = execute(process.execPath, ['-e', 'console.log("started");setTimeout(()=>console.log("finished"),250)'], {
    timeoutMs: 5000, onOutput: () => signalFirstOutput('streamed')
  });
  assert.equal(await Promise.race([firstOutput, streamed.then(() => 'completed')]), 'streamed', 'progress must arrive before the test process ends');
  assert.match((await streamed).out, /started[\s\S]*finished/, 'streaming must retain the complete captured output');
  const failure = await execute(process.execPath, ['-e', 'process.exit(3)'], { timeoutMs: 5000 });
  assert.equal(failure.code, 3);
  const childScript = path.join(tmp, 'timeout.cjs');
  const pidFile = path.join(tmp, 'child.pid');
  fs.writeFileSync(childScript, `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`);
  const timed = await execute(process.execPath, [childScript], { timeoutMs: 600 });
  assert.equal(timed.timedOut, true);
  assert.equal(timed.code, 1, 'timeout must never pass');
  assert.ok(timed.ms < 5000, `timeout cleanup took ${timed.ms}ms`);
  const turnChanges = await execute(process.execPath, [path.join(root, 'test/turn-changes.mjs')], { cwd: root, timeoutMs: 30_000 });
  assert.equal(turnChanges.code, 0, `turn-change fixtures must close watchers and exit: ${turnChanges.out}`);
  assert.match(turnChanges.out, /turn-changes: 18 passed/);
  const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(childPid, 0), undefined, 'timed-out grandchild must be gone');
  const watchdogScript = path.join(tmp, 'watchdog.mjs');
  fs.writeFileSync(watchdogScript, `import {armProcessDeadline} from ${JSON.stringify(new URL('./helpers/execute.mjs', import.meta.url).href)};armProcessDeadline(Date.now()+300,'fixture');setInterval(()=>{},1000);`);
  const watchdog = await execute(process.execPath, [watchdogScript], { timeoutMs: 5000 });
  assert.notEqual(watchdog.code, 0, 'direct CLI watchdog must fail');
  assert.equal(watchdog.timedOut, false, 'the CLI must stop itself before the parent limit');
  assert.match(watchdog.out, /验证未完成/);
  const fullTimeout = await execute(process.execPath, [path.join(root, 'scripts/test-full.mjs'), '--full'], {
    cwd: root, env: { ...process.env, TEST_BUDGET_MS: '600' }, timeoutMs: 5000
  });
  assert.notEqual(fullTimeout.code, 0, fullTimeout.out);
  assert.equal(fullTimeout.timedOut, false, 'the full wrapper must enforce its own shared budget');
  assert.match(fullTimeout.out, /预算已用完|验证未完成/);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('test-policy: all ok');
