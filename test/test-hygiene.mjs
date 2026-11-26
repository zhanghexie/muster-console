/**
 * 自测套件自身的卫生守卫（测试的测试）。
 *
 * 守四条不变量，前两条是被真事故催出来的：
 *
 * 1. 长定时器必须 unref 或 clearTimeout。
 *    extensions-tool-registry.mjs 里 `setTimeout(() => r(1), 60_000)` 只是用来造一个
 *    「比超时更慢的底层任务」，断言 1ms 就过了，但这个句柄把 Node 事件循环吊住，
 *    进程打印完 ok 还要空等 60 秒才退出——单文件占掉全套 220s 里的 60s。
 *
 * 2. 默认套件里的测试不得监听固定端口。
 *    test/run.mjs 现在并行跑，两个测试抢同一个端口必然偶发红。要开服务一律 listen(0)。
 *
 * 3. pre-commit 必须抹掉 git 注入的仓库定位变量（见第 3 节）。
 * 4. pre-commit 必须 LF 行尾（见第 4 节）。
 * 5. pre-commit 必须先执行全源码 i18n 审计（见第 5 节）。
 *
 * 运行: node test/test-hygiene.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const runner = fs.readFileSync(path.join(testDir, 'run.mjs'), 'utf8');

/** 复用 run.mjs 里那份 EXCLUDE，避免两处名单漂移 */
const EXCLUDE = new Set(
  runner
    .match(/const EXCLUDE = new Set\(\[([\s\S]*?)\]\);/)[1]
    .match(/'([^']+)'/g)
    .map((s) => s.slice(1, -1))
);
assert.ok(EXCLUDE.size > 10, 'EXCLUDE 解析失败，守卫会形同虚设');

const files = fs
  .readdirSync(testDir)
  .filter((n) => n.endsWith('.mjs') && !EXCLUDE.has(n))
  .sort();
assert.ok(files.length > 100, `默认套件文件数异常：${files.length}`);

const LONG_MS = 10_000;

/** Parse actual calls, not example code or generated subprocess scripts inside strings. */
function findLiteralTimers(src) {
  const source = ts.createSourceFile('fixture.mjs', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const hits = [], clears = new Set();
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'clearTimeout' && node.arguments[0] && ts.isIdentifier(node.arguments[0])) clears.add(node.arguments[0].text);
      if (node.expression.text === 'setTimeout' && node.arguments.length >= 2 && ts.isNumericLiteral(node.arguments[1])) {
        const parent = node.parent;
        hits.push({
          index: node.getStart(source),
          delay: Number(node.arguments[1].text.replace(/_/g, '')),
          unrefed: ts.isPropertyAccessExpression(parent) && parent.name.text === 'unref' && ts.isCallExpression(parent.parent),
          assigned: ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : undefined
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { hits, clears };
}

{
  const fixture = findLiteralTimers('const generated = `setTimeout(() => {}, 20000)`; // setTimeout(() => {}, 30000)\nconst timer = setTimeout(() => {}, 12000); clearTimeout(timer); setTimeout(() => {}, 15000).unref(); setTimeout(() => {}, 11000);');
  assert.equal(fixture.hits.length, 3, 'timer-like text in fixtures and comments is not executed here');
  assert.ok(fixture.clears.has(fixture.hits[0].assigned));
  assert.equal(fixture.hits[1].unrefed, true);
  assert.equal(fixture.hits[2].unrefed, false, 'a real unbounded timer remains detectable');
}

// ---------- 1) 长定时器必须 unref / clearTimeout ----------
{
  const offenders = [];

  for (const name of files) {
    const src = fs.readFileSync(path.join(testDir, name), 'utf8');
    const { hits, clears } = findLiteralTimers(src);
    for (const hit of hits) {
      if (hit.delay < LONG_MS || hit.unrefed) continue;

      // 形如 `const keepAlive = setTimeout(...)` 且后面有 clearTimeout(keepAlive) 的放行
      if (hit.assigned && clears.has(hit.assigned)) continue;

      const line = src.slice(0, hit.index).split(/\r?\n/).length;
      offenders.push(`${name}:${line} setTimeout(..., ${hit.delay}) 既未 unref 也未 clearTimeout`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `长定时器会把测试进程吊到到点才退出，拖慢整套：\n${offenders.join('\n')}`
  );
}

// ---------- 2) 并行安全：不得监听固定端口 ----------
{
  /** listen(<非 0 的数字字面量>…) —— listen(0) / listen(port 变量) 都合法 */
  const FIXED_LISTEN = /\.listen\(\s*([0-9][0-9_]*)\s*[,)]/g;
  const offenders = [];

  for (const name of files) {
    const src = fs.readFileSync(path.join(testDir, name), 'utf8');
    for (const m of src.matchAll(FIXED_LISTEN)) {
      if (Number(m[1].replace(/_/g, '')) === 0) continue;
      const line = src.slice(0, m.index).split(/\r?\n/).length;
      offenders.push(`${name}:${line} listen(${m[1]})`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `run.mjs 并行跑，固定端口会互相抢占；改成 listen(0) 再读 server.address().port：\n${offenders.join('\n')}`
  );
}

// ---------- 3) 门禁跑测试前必须抹掉 git 注入的仓库定位变量 ----------
{
  // git 跑 hook 时会设 GIT_DIR=.git、GIT_INDEX_FILE=.git/index（相对路径）等，
  // 继承到测试里的 git 子进程后，临时目录里新建的仓库会被指回本仓 .git，
  // git-worktree / git-hunk-adopt 直接 status 128。首次上门禁即被这个咬中。
  const { GIT_ENV_VARS, stripGitEnv } = await import('../scripts/gate.mjs');
  for (const v of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) {
    assert.ok(GIT_ENV_VARS.includes(v), `门禁未抹掉 ${v}——会污染测试里的 git 子进程`);
  }
  const stripped = stripGitEnv({ GIT_DIR: '.git', GIT_INDEX_FILE: '.git/index', PATH: 'p' });
  assert.deepEqual(stripped, { PATH: 'p' });

  const src = fs.readFileSync(path.join(testDir, '..', 'scripts', 'gate.mjs'), 'utf8');
  // 测试子进程的 env 必须由 stripGitEnv 派生；读暂存区的 git 调用则必须保留原 env
  assert.match(src, /const env = \{ \.\.\.stripGitEnv\(process\.env\)/, '测试子进程 env 必须经 stripGitEnv');
  assert.doesNotMatch(
    src.match(/const git = \(args\) =>[^\n]*/)[0],
    /stripGitEnv|env:/,
    '读暂存区的 git 调用不得抹 env：git commit -a 的 GIT_INDEX_FILE 指向临时索引'
  );
  // staged 过滤必须含 D（删除）：否则纯删除提交 staged 为空、整单免测，
  // 删除引发的破坏（孤儿 import、漏改的引用方）无门禁拦截
  assert.match(src, /--diff-filter=ACMRD\b/, '门禁的 --diff-filter 必须含 D，纯删除提交不得免测');
}

// ---------- 4) git 钩子必须是 LF 行尾、只做 exec 转发 ----------
{
  // CRLF 会让 sh 把行尾 \r 当成参数的一部分（`--mode staged\r`），整个门禁起不来
  // （用 PowerShell 的 Set-Content 改这些文件就会踩到）。
  for (const [hook, mode] of [
    ['pre-commit', 'staged'],
    ['pre-merge-commit', 'full']
  ]) {
    const raw = fs.readFileSync(path.join(testDir, '..', 'scripts', 'githooks', hook));
    assert.ok(!raw.includes('\r\n'), `scripts/githooks/${hook} 必须 LF 行尾，CRLF 会让 sh 解析失败`);
    assert.match(
      raw.toString(),
      new RegExp(`^exec node scripts/gate\\.mjs --mode ${mode}$`, 'm'),
      `${hook} 必须 exec 转发到 gate.mjs --mode ${mode}`
    );
  }
}

// ---------- 5) 提交门禁必须包含全源码 i18n 审计 ----------
{
  const src = fs.readFileSync(path.join(testDir, '..', 'scripts', 'gate.mjs'), 'utf8');
  assert.match(src, /i18n-coverage\.mjs/,
    'pre-commit 门禁必须执行全源码 i18n 审计');
  assert.match(src, /path\.join\(tree, 'test', 'i18n-coverage\.mjs'\), '--audit'/,
    'i18n 门禁必须使用 --audit 全源码范围');
}

// ---------- 6) 文件内分片：声明与使用必须成对 ----------
{
  // 声明了 `// @test-shards N` 却没用 inShard → run.mjs 把整个文件完整跑 N 遍（白烧 CPU）；
  // 用了 inShard 却没声明 → 只起一个进程，分片形同虚设。
  const mismatched = [];
  for (const name of files) {
    const src = fs.readFileSync(path.join(testDir, name), 'utf8');
    const declared = /^\/\/ @test-shards \d+\s*$/m.test(src.slice(0, 4096));
    const used = /\binShard\(\d+\)/.test(src);
    if (declared !== used) mismatched.push(`${name}（声明 ${declared}，使用 ${used}）`);
  }
  assert.deepEqual(mismatched, [], `分片声明与 inShard 使用不成对：\n${mismatched.join('\n')}`);

  // inShard 语义：无 TEST_SHARD 全跑；有则按 k % N 恰好落一片
  const load = async (spec) => {
    if (spec) process.env.TEST_SHARD = spec;
    else delete process.env.TEST_SHARD;
    return (await import(`./helpers/shard.mjs?spec=${spec ?? 'none'}`)).inShard;
  };
  const all = await load(null);
  assert.ok([0, 1, 2, 7].every(all), '无 TEST_SHARD 时每块都跑');
  const hits = [];
  for (let i = 0; i < 3; i++) {
    const inShard = await load(`${i}/3`);
    hits.push([0, 1, 2, 3, 4, 5, 6].filter(inShard));
  }
  delete process.env.TEST_SHARD;
  assert.deepEqual(hits, [[0, 3, 6], [1, 4], [2, 5]], '每块恰好落在一个分片');
}

console.log(
  `test-hygiene: ok（${files.length} 个默认套件文件：长定时器 + 固定端口 + 分片成对；门禁：git env + 钩子 LF）`
);
