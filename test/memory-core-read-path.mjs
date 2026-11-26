/**
 * memory core 读路径三缺口回归（docs/audits/reliability/memory-system.md F-01①②③；
 * 2026-10-26 用户卡片批准排修，草案 D10-D14 取向 B）：
 * ① injectKnowledge 携带执行仓库/分支（gitScopeFor 缓存 + refreshGitScope 预热；
 *    四个调用面均为同步注入，故 TTL 内缓存、过期后台刷新）——绑定当前分支的
 *    active 条目进 core；异分支/异仓库条目仍排除（不放宽为无分支全注入）；
 * ② core 注入行携带例外（exceptions）——否定边界不丢，条目不比用户原意更强；
 * ③ recallKnowledge 整体 1500ms 截止保留已完成命中——工作范围命中先重检入部分
 *    结果，profile 慢查询不再把已完成命中整包拖丢；全量路径仍在 profile await 后
 *    重检两侧（删除/修订竞态防护，memory-curator-recall 合同）。
 * Run: node test/memory-core-read-path.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { sqliteFts5Supported } from './helpers/sqlite-fts5.mjs';

if (!(await sqliteFts5Supported())) {
  console.log('skip: 当前 Node 的 node:sqlite 缺 fts5 扩展，记忆库（FTS 全文索引）用例无法运行');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-core-read-'));
const compile = createSharedCompiler(root, tmp);
const load = (file) => import(pathToFileURL(compile(file)).href);

const { MemoryService } = await load('main/memory/service.ts');
const { KnowledgeStore } = await load('main/memory/knowledgeStore.ts');
const { KnowledgeSearch } = await load('main/memory/knowledgeSearch.ts');
const { knowledgeRepoKey } = await load('main/memory/knowledgePolicy.ts');
const { setUserProfileFilePath } = await load('main/memory/userProfile.ts');

const ctxUser = (id, namespace = 'worker') => ({
  namespace,
  origin: 'user',
  explicit: true,
  evidence: [{ id, source: 'fixture-host', eventTime: Date.now(), verification: 'user_confirmed', observation: 'user_input' }]
});
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
/** 红绿验证用分节过滤：node test/memory-core-read-path.mjs scope|exceptions|deadline */
const ONLY = process.argv[2];
const want = (name) => !ONLY || ONLY === name;

const stores = [];
const services = [];
try {
  // ---------- ① 注入执行范围：绑定分支条目进 core（还原即红：injectKnowledge 不带 branch 即转红） ----------
  if (want('scope')) {
    const ws = fs.mkdtempSync(path.join(tmp, 'git-ws-'));
    git(ws, 'init');
    git(ws, 'config', 'user.email', 'fixture@example.com');
    git(ws, 'config', 'user.name', 'fixture');
    fs.writeFileSync(path.join(ws, 'a.txt'), 'init');
    git(ws, 'add', 'a.txt');
    git(ws, 'commit', '-m', 'init');

    const svc = new MemoryService();
    services.push(svc);
    // 预热前回落：仅 repoKey（与旧行为一致，不猜分支）
    assert.deepEqual(svc.gitScopeFor(ws), { repoKey: path.resolve(ws) }, '未预热回落仅仓库键');
    const scope = await svc.refreshGitScope(ws);
    assert.equal(typeof scope.branch, 'string', 'git 工作区读到分支');
    assert.equal(knowledgeRepoKey(scope.repoKey), knowledgeRepoKey(ws), 'repoKey 归一后与工作区一致');
    assert.deepEqual(svc.gitScopeFor(ws), scope, '预热后命中缓存');

    const store = svc.knowledge(ws, 'worker');
    const onBranch = store.submit(
      { kind: 'stable_constraint', summary: '当前分支约束：合并前必须过回归测试', applicability: [], repoKey: knowledgeRepoKey(scope.repoKey), branch: scope.branch },
      ctxUser('ev-on-branch')
    ).record;
    const otherBranch = store.submit(
      { kind: 'stable_constraint', summary: '异分支专属约束：允许实验性 API', applicability: [], repoKey: knowledgeRepoKey(scope.repoKey), branch: 'feature/does-not-exist' },
      ctxUser('ev-other-branch')
    ).record;
    const otherRepo = store.submit(
      { kind: 'stable_constraint', summary: '异仓库约束：不应注入本区', applicability: [], repoKey: 'another-repo-key' },
      ctxUser('ev-other-repo')
    ).record;
    const global = store.submit(
      { kind: 'user_preference', summary: '回复保持简洁', applicability: [] },
      ctxUser('ev-global')
    ).record;
    for (const r of [onBranch, otherBranch, otherRepo, global]) assert.equal(r.status, 'active');

    const inj = svc.injectKnowledge(ws, 'worker');
    assert.ok(inj.text.includes('当前分支约束：合并前必须过回归测试'), '绑定当前分支的 active 条目进入 core 常驻注入（缺口①）');
    assert.ok(inj.text.includes('回复保持简洁'), '无范围条目不受影响');
    assert.ok(!inj.text.includes('异分支专属约束'), '异分支条目仍排除（不放宽）');
    assert.ok(!inj.text.includes('异仓库约束'), '异仓库条目仍排除');
    console.log('ok: ① 注入执行范围（分支/仓库命中与排除）');
  }

  // ---------- ② core 注入行携带例外（还原即红：去掉 exceptions 拼接即转红） ----------
  if (want('exceptions')) {
    const dir = path.join(tmp, 'core-exc');
    const store = new KnowledgeStore(dir);
    stores.push(store);
    const withExc = store.submit(
      { kind: 'stable_constraint', summary: '禁止直接 push 主分支', applicability: [], exceptions: ['发布当日热修例外'] },
      ctxUser('ev-exc')
    ).record;
    const plain = store.submit(
      { kind: 'user_preference', summary: '偏好简洁回复', applicability: [] },
      ctxUser('ev-plain')
    ).record;
    const core = store.core('worker', 2000, {});
    assert.ok(core.includes(`- 禁止直接 push 主分支（例外：发布当日热修例外） [记忆 ${withExc.id}]`), '注入行携带例外边界（缺口②）');
    assert.ok(core.includes(`- 偏好简洁回复 [记忆 ${plain.id}]`), '无例外条目保持原格式');
    // 多例外合并；整行超预算仍整条省略（不截断半句丢边界）
    const multi = store.submit(
      { kind: 'stable_constraint', summary: '发布走灰度', applicability: [], exceptions: ['紧急修复例外', '内网环境例外'] },
      ctxUser('ev-multi')
    ).record;
    const coreMulti = store.core('worker', 2000, {});
    assert.ok(coreMulti.includes('发布走灰度（例外：紧急修复例外；内网环境例外）'), '多例外以；拼接');
    const tight = store.core('worker', `- 发布走灰度（例外：紧急修复例外；内网环境例外） [记忆 ${multi.id}]`.length - 1, {});
    assert.ok(!tight.includes('发布走灰度'), '超预算整条省略（不落半句）');
    console.log('ok: ② core 注入携带例外');
  }

  // ---------- ③ 召回截止保留已完成命中（还原即红：超时整包丢弃即转红） ----------
  if (want('deadline')) {
    const dir = path.join(tmp, 'recall-deadline');
    const workerStore = new KnowledgeStore(path.join(dir, 'worker'));
    const profileStore = new KnowledgeStore(path.join(dir, 'profile'));
    stores.push(workerStore, profileStore);
    const workerEngine = new KnowledgeSearch(workerStore);
    const profileEngine = new KnowledgeSearch(profileStore);
    const workerRecord = workerStore.submit(
      { kind: 'stable_constraint', summary: '部署前必须跑回归测试', applicability: [], repoKey: 'repo' },
      ctxUser('ev-recall-worker')
    ).record;
    const profileRecord = profileStore.submit(
      { kind: 'user_preference', summary: '偏好中文回复', applicability: [] },
      ctxUser('ev-recall-profile', 'profile')
    ).record;
    setUserProfileFilePath(path.join(dir, 'profile-home'));
    try {
      const workerHits = workerStore.search({ query: '部署 回归测试', namespace: 'worker', repoKey: 'repo', limit: 5 });
      assert.equal(workerHits.length, 1, '词法命中一条');
      const profileHits = profileStore.search({ query: '回复 语言', namespace: 'profile', limit: 3 });
      assert.equal(profileHits.length, 1);

      let releaseProfile;
      const profileDone = new Promise((r) => { releaseProfile = r; });
      let slowProfile = true;
      const fake = {
        knowledgeSearches: new Map([[workerStore, workerEngine], [profileStore, profileEngine]]),
        knowledge(_root, ns) { return ns === 'profile' ? profileStore : workerStore; },
        async queryKnowledge(_root, input) {
          if (input.namespace === 'profile') {
            if (!slowProfile) return profileHits;
            await profileDone; // 卡住 profile 查询，模拟探针 A9 的慢第二段
            return profileHits;
          }
          await new Promise((r) => setTimeout(r, 600)); // 工作范围命中 600ms 即绪
          return workerHits;
        }
      };

      const t0 = Date.now();
      const partial = await MemoryService.prototype.recallKnowledge.call(fake, dir, '部署前要做什么', 'worker', { root: 'repo', branch: 'main' });
      const elapsed = Date.now() - t0;
      assert.ok(partial.includes('部署前必须跑回归测试'), '1500ms 截止保留已完成命中（缺口③）');
      assert.ok(elapsed < 3000, '不等待慢 profile 查询');
      releaseProfile();
      await new Promise((r) => setTimeout(r, 50)); // 让后台查询自然结束（结果已弃，不产生副作用）

      // 快路径不回归：两段都快时合并 worker+profile 命中
      slowProfile = false;
      const merged = await MemoryService.prototype.recallKnowledge.call(fake, dir, '部署前要做什么 回复语言', 'worker', { root: 'repo', branch: 'main' });
      assert.ok(merged.includes('部署前必须跑回归测试'), '快路径 worker 命中在');
      assert.ok(merged.includes('偏好中文回复'), '快路径 profile 命中合并');
      void workerRecord; void profileRecord;
    } finally {
      setUserProfileFilePath(null);
    }
    workerEngine.close();
    profileEngine.close();
    console.log('ok: ③ 召回截止保留已完成命中');
  }

  console.log('memory-core-read-path: all ok');
} finally {
  for (const s of services) s.closeAll();
  for (const s of stores) s.close();
  const rel = path.relative(fs.realpathSync(os.tmpdir()), tmp);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) fs.rmSync(tmp, { recursive: true, force: true });
}
