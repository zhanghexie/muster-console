/**
 * 离线自测入口。排除必须开着应用 / 改本机配置 / 拉真实 MCP 的脚本。
 *
 * 运行:
 *   node test/run.mjs              有界日常验证（默认；同 --changed，一分钟目标）
 *   node test/run.mjs git notify   只跑文件名含 git 或 notify 的
 *   node test/run.mjs --changed-files <清单文件>
 *                                  同上，但改动清单从文件读（一行一个路径）；
 *                                  提交门禁用它传入暂存区清单（scripts/gate.mjs）
 *   node test/run.mjs --all        离线全量 + 组件单测全套；AI 编码环境里降级为影响面
 *   node test/run.mjs --full       同 --all 但不降级（或 TEST_FULL=1），一小时上限
 *   node test/run.mjs --integration / --visual / --audit  显式专项，三分钟上限
 *   node test/run.mjs --list       只打印将要跑的文件，不执行
 *   TEST_JOBS=1 node test/run.mjs  退回串行（排查并行引入的干扰时用）
 *
 * --changed 的安全边界：靠 helpers/impact.mjs 静态解析「测试 → src 依赖闭包」，
 * 只有在确实解析出闭包且改动不在其中时才跳过；解析不出入口、全仓扫描型守卫、
 * 日常档只选纯逻辑/行为回归；宽泛改动用冒烟子集，额外覆盖范围明确留给专项/全量。
 * 默认最多 16 个离线文件 + 6 个组件 spec。两条反盲区规则（D14 testing P2）：
 *   1) audit 档静态守卫按同一改动闭包并入默认档——扫描型守卫随任意 src 改动入选、
 *      闭包型守卫随目标文件入选、宽泛/删除改动全带，守卫的红不再对 npm test 隐形；
 *   2) 直接改动的测试文件无论档位一律执行（EXCLUDE 手动脚本除外）——把专项守卫
 *      改红的提交必然在门禁见到该文件；重专项可能吃满预算，超时失败而非假绿。
 *
 * 文件内分片：文件头写 `// @test-shards N` 的慢文件会被起 N 个进程（TEST_SHARD=i/N），
 * 场景块用 helpers/shard.mjs 的 inShard(k) 分配，见该文件说明。
 *
 * 并行安全前提：默认套件里的 HTTP 服务一律 listen(0) 取随机端口，临时目录一律 mkdtemp。
 * 新增测试若要占固定端口或固定路径，请改成随机分配，否则并行下会互相踩。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectAffected, selectUnitSpecs } from './helpers/impact.mjs';
import { downgradeNotice, resolveRunScope } from './helpers/runScope.mjs';
import { suiteBudgetMs, testCaseBudgetMs, testJobs, testDeadline } from './helpers/resources.mjs';
import { dailySelection, dailyUnitPlan, SMOKE_SPECS, testProfile } from './helpers/profiles.mjs';
import { execute } from './helpers/execute.mjs';
import { acquireTestLease } from './helpers/lease.mjs';

const suiteStarted = Date.now();

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
if (!process.argv.includes('--list')) {
  try { acquireTestLease(repoRoot); }
  catch (error) { console.error(error.message); process.exit(1); }
}
/**
 * 上轮各文件耗时，用于「慢的先起跑」缩短总墙钟；缺失不影响正确性。
 * 门禁在暂存快照里跑时用 TEST_TIMINGS 指回真仓，否则每次都是冷排序。
 */
const timingCache = process.env.TEST_TIMINGS || path.join(repoRoot, '.tmp', 'test-timings.json');
/** 暂存快照里没有 node_modules，按本文件位置向上解析到真仓那份 */
const vitestBin = path.join(
  path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs'
);

/** 这些不是「改完就能跑」的回归，不进 npm test */
const EXCLUDE = new Set([
  'run.mjs',
  'e2e2.mjs',
  'dump-black.mjs',
  'dump-bubble.mjs',
  'screenshot.mjs',
  'mock-llm.mjs',
  'mcp-smoke.mjs',
  'pi-electron-smoke.mjs',
  'terminal-raster-smoke.mjs',
  'pi-skills-probe.mjs',
  'refresh-all-metaagent.mjs',
  'ui-sandbox.mjs',
  'theme-ui-verify.mjs',
  // Real Windows input probes open and operate an isolated visible Electron fixture.
  'desktop-win32-native-electron.mjs',
  'desktop-win32-control-electron.mjs',
  'desktop-cua-visible-electron.mjs',
  'desktop-screen-win32-visible-electron.mjs',
  'desktop-stop-escape-win32-electron.mjs',
  // Real model/network probe is opt-in and uses only a local no-op MCP tool.
  'codex-delivery-live.mjs',
  'codex-image-live.mjs',
  // GUI 聊天 CDP 驱动：需要 dev 实例 + MUSTER_DEVTOOLS_PORT
  'gui-chat-cdp.mjs',
  // 文件预览全格式实测：需要 dev 实例 + MUSTER_DEVTOOLS_PORT=9333（见文件头注释）
  'preview-cdp.mjs',
  // 内置浏览器实机冒烟：需要 dev 实例 + MUSTER_DEVTOOLS_PORT=9333
  'browser-cdp-smoke.mjs',
  // 网页访问网关 e2e：需要先 npm run build + Electron（见文件头注释），手动跑
  'web-access.mjs',
  // 手机表面 e2e：需要 npm run build + Electron + 系统 Chrome（见文件头注释），手动跑
  'web-mobile.mjs',
  // Claude Agent SDK 冒烟（T2.0）：要本机 claude 鉴权/中转 + 网络；node / electron 三形态可跑
  'claude-sdk-smoke.mjs',
  // Claude GUI driver 在线冒烟（T2.1）：同上鉴权前提，驱动 ClaudeRuntimeDriver 本体
  'claude-driver-smoke.mjs',
  // ACP GUI driver 在线冒烟（T5.2）：要本机 opencode/gemini ACP CLI + 厂商鉴权
  'acp-driver-smoke.mjs'
]);

const argv = process.argv.slice(2);
const profile = ['integration', 'visual', 'audit'].find(name => argv.includes(`--${name}`));
const changedFilesArg = argv.indexOf('--changed-files');
const changedListPath = changedFilesArg >= 0 ? argv[changedFilesArg + 1] : null;
const filters = argv.filter(
  (a, i) => !a.startsWith('-') && (changedFilesArg < 0 || i !== changedFilesArg + 1)
);
const runScope = resolveRunScope(argv, process.env, { hasFilters: filters.length > 0 || !!profile });
const onlyChanged = runScope.scope === 'changed' || runScope.scope === 'changed-files';
const withUnit = runScope.scope === 'full';
const listOnly = argv.includes('--list');
const daily = onlyChanged && !profile;
// Leave time for process-tree cleanup and summary output. A broad release change
// can carry several directly edited component specs. Give that explicit regression
// set a bounded 90-second window while keeping the ordinary daily target at 55s.
const budgetChanged = onlyChanged
  ? (changedListPath
    ? fs.readFileSync(changedListPath, 'utf8').split(/\r?\n/).filter(Boolean)
    : changedFiles())
  : [];
const directUnitTestCount = budgetChanged.filter(file => /test\/unit\/.*\.spec\.tsx?$/.test(file)).length;
const capMs = daily ? (directUnitTestCount > 6 ? 90_000 : 55_000) : suiteBudgetMs(runScope.scope);
const deadline = testDeadline(capMs, process.env, suiteStarted);
const budgetMs = Math.max(0, deadline - suiteStarted);
const remaining = () => Math.max(0, deadline - Date.now());
if (runScope.downgradedBy) console.log(downgradeNotice(runScope.downgradedBy, '全量请求'));

const allFiles = fs
  .readdirSync(testDir)
  .filter((n) => n.endsWith('.mjs') && !EXCLUDE.has(n))
  .sort();

/** 读 git status 的改动清单（已暂存/未暂存/未跟踪） */
function workingTreeChanges() {
  // porcelain -z 的 rename/copy 旧路径是紧随其后的独立 token（无状态前缀），
  // 取新路径后跳过旧路径——否则旧路径被截成残片，不匹配 src//test/ 前缀就把裁剪静默打成全跑
  const raw = execFileSync('git', ['status', '--porcelain', '-z'], { cwd: repoRoot })
    .toString()
    .split('\0')
    .filter(Boolean);
  const changed = [];
  for (let i = 0; i < raw.length; i++) {
    const status = raw[i].slice(0, 2);
    changed.push(raw[i].slice(3));
    if (status.includes('R') || status.includes('C')) i++;
  }
  return changed;
}

function changedFiles() {
  if (process.env.GITHUB_ACTIONS !== 'true') return workingTreeChanges();
  const base = process.env.MUSTER_CI_TEST_BASE ?? '';
  if (/^[0-9a-f]{40}$/i.test(base) && !/^0+$/.test(base)) {
    try {
      const files = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, 'HEAD', '--'], {
        cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
      }).split('\0').filter(Boolean);
      if (files.length > 0) return files;
    } catch (error) {
      if (error.status !== 128) throw error;
      console.log('CI: 基线提交不可用，运行有界冒烟。');
    }
  }
  // A first push or a manual run has no comparison base. Use the existing
  // configuration-change smoke profile so a clean checkout still runs tests.
  return ['package.json'];
}

let files = allFiles;
let selectionNote = '';
/** @type {{ mode: 'none' } | { mode: 'full' } | { mode: 'related' | 'files', files: string[] }} */
let unitPlan = withUnit ? { mode: 'full' } : { mode: 'none' };
let deferred = [];
let mergedSpecial = 0;

if (onlyChanged) {
  const changed = budgetChanged;
  const tierOf = new Map(allFiles.map((name) => [name, testProfile(repoRoot, name)]));
  const { selected, reason, broad, deferredRelated } = dailySelection(repoRoot, allFiles, changed, selectAffected);
  const picked = [...selected];
  // D14 F-02：直接改动的测试文件无论档位一律纳入本轮（audit/integration/visual 专项档
  // 也不例外；EXCLUDE 手动脚本需要活的应用，除外）——否则把专项守卫改红的提交可以在
  // 门禁全绿下带着仍红的测试入库。重专项可能吃满日常预算：预算耗尽按既有语义记
  // failed（不静默跳过），需要完整验证时用显式专项命令。
  const changedOffline = new Set(
    changed
      .map((file) => file.split(path.sep).join('/'))
      .filter((file) => file.startsWith('test/') && file.endsWith('.mjs'))
      .map((file) => file.slice('test/'.length))
  );
  const directSpecial = allFiles.filter((name) => changedOffline.has(name) && !picked.includes(name));
  picked.push(...directSpecial);
  // D14 F-01：audit 档静态守卫不再对默认档隐形——按同一改动清单做闭包选取并入：
  // 扫描型守卫随任意 src 改动入选，闭包型守卫在其目标文件改动时入选，宽泛/删除
  // 改动全带。守卫均为秒级静态断言，闭包选取保证「日常一分钟」预算不被整档拖垮。
  const auditTier = allFiles.filter((name) => tierOf.get(name) === 'audit');
  const auditMerged = selectAffected(repoRoot, auditTier, changed)
    .selected.filter((name) => !picked.includes(name));
  picked.push(...auditMerged);
  files = picked;
  mergedSpecial = directSpecial.length + auditMerged.length;
  if (broad) {
    const narrow = changed.filter(file =>
      (file.startsWith('src/') || file.startsWith('test/unit/')) &&
      file !== 'test/unit/setup.ts' && !file.startsWith('test/unit/helpers/') &&
      fs.existsSync(path.join(repoRoot, file))
    );
    const related = selectUnitSpecs(repoRoot, narrow, 'affected');
    unitPlan = { mode: 'related', files: [...new Set([...SMOKE_SPECS, ...(related.mode === 'related' ? related.files : [])])] };
  } else {
    unitPlan = selectUnitSpecs(repoRoot, changed, reason);
    // Changes to shared component fixtures use smoke in the daily tier as well.
    if (unitPlan.mode === 'full') unitPlan = { mode: 'related', files: SMOKE_SPECS };
  }
  deferred = allFiles.filter(name => tierOf.get(name) !== 'daily');
  unitPlan = dailyUnitPlan(repoRoot, changed, unitPlan);
  if (deferredRelated.length > 0) {
    console.log(`daily: ${deferredRelated.length} 个额外相关离线测试留给显式全量；日常最多 16 个离线文件、6 个组件 spec（直接修改的测试无论档位保留）。`);
  }
  if (mergedSpecial > 0) {
    console.log(`daily: 并入 ${mergedSpecial} 个专项档测试（audit 守卫按改动闭包 ${auditMerged.length} 个；直接修改的专项测试 ${directSpecial.length} 个）。`);
  }
  const unitNote =
    unitPlan.mode === 'full'
      ? ' + 组件单测全套'
      : unitPlan.mode === 'files'
        ? ` + 日常组件单测（${unitPlan.files.length} 个 spec）`
        : '';
  selectionNote = `${changedListPath ? '--changed-files' : '--changed'}: ${changed.length} 个改动文件 → ${reason}${unitNote}`;
}

if (profile) files = allFiles.filter(name => testProfile(repoRoot, name) === profile);

if (filters.length > 0) {
  files = files.filter((n) => filters.some((f) => n.includes(f)));
}

/** 起 Vitest 组件单测。buffered：输出留到最后一并打印 */
function startUnitSuite(plan) {
  const args =
    plan.mode === 'related'
      ? [vitestBin, 'related', ...plan.files, '--run', '--passWithNoTests']
      : plan.mode === 'files'
        ? [vitestBin, 'run', ...plan.files]
      : [vitestBin, 'run'];
  if (remaining() === 0) return Promise.resolve({ code: 1, ms: 0, out: '时间预算已用完，组件测试未执行。', timedOut: true });
  return execute(process.execPath, args, {
      cwd: repoRoot,
      // 全量为显式请求，别让 vitest.config 的 AI 守卫再降级一次
      env: plan.mode === 'full' ? { ...process.env, TEST_FULL: '1', TEST_FULL_SUITE: '1', TEST_DEADLINE: String(deadline) } : process.env,
      onOutput: plan.mode === 'full' ? data => process.stdout.write(data) : undefined,
      timeoutMs: remaining()
  });
}

const unitLabel = (plan) => (plan.mode === 'full' ? 'test:unit' : 'test:unit(daily)');

if (daily && deferred.length > 0) {
  console.log(`daily: 其余 ${deferred.length - mergedSpecial} 个专项测试不默认执行（test:integration / test:visual / test:audit）；本次结果只代表日常范围加并入项。`);
}
// A dry run must never spawn Vitest, including when only component specs are selected.
if (listOnly) {
  if (selectionNote) console.log(selectionNote);
  console.log(files.join('\n'));
  console.log(`unit: ${JSON.stringify(unitPlan)}`);
  console.log(`\n${files.length}/${allFiles.length} selected, jobs=${testJobs()}, budget=${Math.round(budgetMs / 1000)}s`);
  process.exit(0);
}

if (files.length === 0) {
  if (onlyChanged) {
    if (unitPlan.mode === 'none') {
      console.log(`${selectionNote}\n没有受影响的自测，跳过。`);
      process.exit(0);
    }
    // 只动了渲染层 spec 之类：离线套件没得跑，但组件单测必须跑
    console.log(`${selectionNote}\n离线自测无命中，只跑组件单测。`);
    const unit = await startUnitSuite(unitPlan);
    if (unit.code !== 0) console.log(unit.out.trimEnd());
    if (unit.timedOut) console.log('时间预算已用完，组件验证未完成。');
    console.log(`${unit.code === 0 ? 'ok  ' : 'FAIL'} ${unitLabel(unitPlan)}  ${unit.ms}ms（Vitest 组件单测）`);
    process.exit(unit.code === 0 ? 0 : 1);
  }
  console.error(
    filters.length > 0
      ? `npm test: 没有匹配 ${filters.join(' / ')} 的自测`
      : 'npm test: 没有可跑的自测'
  );
  process.exit(1);
}

/** `// @test-shards N`：该文件拆成 N 个进程并行（只读文件头，声明须在 import 之前） */
function shardCount(name) {
  const head = fs.readFileSync(path.join(testDir, name), 'utf8').slice(0, 4096);
  const m = head.match(/^\/\/ @test-shards (\d+)\s*$/m);
  return m ? Math.max(1, Number(m[1])) : 1;
}

/** 队列项：分片文件展开成多项，key 用于显示与耗时缓存 */
const items = files.flatMap((name) => {
  const n = shardCount(name);
  if (n === 1) return [{ name, key: name, shard: null }];
  return Array.from({ length: n }, (_, i) => ({ name, key: `${name}#${i + 1}/${n}`, shard: `${i}/${n}` }));
});

/** 上轮耗时：慢的排前面，避免长任务卡在队尾拖长总时间；没记录的按中位偏上排 */
let prevTimings = {};
try {
  prevTimings = JSON.parse(fs.readFileSync(timingCache, 'utf8'));
} catch {
  // 首次运行或缓存损坏：按字母序跑，下一轮就有数据了
}
const queue = [...items].sort((a, b) => (prevTimings[b.key] ?? 1000) - (prevTimings[a.key] ?? 1000));

const jobs = testJobs();

function runOne(item) {
  const file = path.join(testDir, item.name);
  const env = { ...process.env };
  const remainingMs = remaining();
  const caseBudgetMs = testCaseBudgetMs(runScope.scope, remainingMs);
  if (caseBudgetMs <= 0) return Promise.resolve({ key: item.key, code: 1, ms: 0, out: '', timedOut: true, caseTimedOut: false });
  if (item.shard) env.TEST_SHARD = item.shard;
  else delete env.TEST_SHARD;
  return execute(process.execPath, [file], {
      cwd: repoRoot,
      env,
      timeoutMs: caseBudgetMs
  }).then(result => ({ ...result, key: item.key, caseTimedOut: result.timedOut && caseBudgetMs < remainingMs }));
}

const started = Date.now();
const results = [];
let failed = 0;
let cursor = 0;

async function worker() {
  while (cursor < queue.length && remaining() > 0) {
    const item = queue[cursor++];
    const r = await runOne(item);
    results.push(r);
    // 并行下输出按完成顺序打印；每个文件的 stdout 已整块缓冲，不会互相穿插
    if (r.code === 0) {
      const tail = r.out.trim().split(/\r?\n/).pop() ?? '';
      console.log(`ok   ${r.key}  ${r.ms}ms${tail ? `  ${tail}` : ''}`);
    } else {
      failed += 1;
      console.log(`FAIL ${r.key}  ${r.ms}ms`);
      if (r.caseTimedOut) console.log('单个测试超过五分钟，已终止其进程树；该测试失败，继续其余用例。');
      else if (r.timedOut) console.log('时间预算已用完，已终止该测试进程树；验证未完成。');
      if (r.out.trim()) console.log(r.out.trimEnd());
    }
  }
}

if (selectionNote) console.log(selectionNote);
console.log(`running ${files.length}/${allFiles.length} tests（${queue.length} 个进程）, jobs=${jobs}, budget=${Math.round(budgetMs / 1000)}s`);

await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker));

// Offline and component phases share one CPU budget; never launch both pools at once.
const unit = unitPlan.mode === 'none' ? null : await startUnitSuite(unitPlan);
if (unit) {
  if (unit.code !== 0) {
    failed += 1;
    if (unit.timedOut) console.log('时间预算已用完，组件验证未完成。');
    console.log(`\n--- 组件单测失败（${unitLabel(unitPlan)}）---`);
    if (unitPlan.mode !== 'full') console.log(unit.out.trimEnd());
  }
  console.log(`${unit.code === 0 ? 'ok  ' : 'FAIL'} ${unitLabel(unitPlan)}  ${unit.ms}ms（Vitest 组件单测）`);
}

const wall = Date.now() - started;
const notRun = queue.length - results.length;
if (notRun > 0) {
  failed += 1;
  console.log(`时间预算已用完，${notRun} 个测试进程未执行；验证未完成。`);
}

// 回写耗时缓存（只更新本轮跑过的，保留其他文件的历史值）
try {
  fs.mkdirSync(path.dirname(timingCache), { recursive: true });
  const next = { ...prevTimings };
  for (const r of results) next[r.key] = r.ms;
  fs.writeFileSync(timingCache, JSON.stringify(next, null, 2));
} catch {
  // 缓存写失败只影响下轮调度顺序，不影响结论
}

const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);
console.log(`\nslowest: ${slowest.map((r) => `${r.key} ${r.ms}ms`).join(', ')}`);
// 组件单测算作一项（它自己内部有上百个 spec，这里只计成败）
const total = results.length + (unit ? 1 : 0);
console.log(failed ? `${failed}/${total} failed  ${wall}ms` : `${total} passed  ${wall}ms（${Date.now() - suiteStarted}ms 含选测）`);
process.exit(failed ? 1 : 0);
