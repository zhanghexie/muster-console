/**
 * `node test/run.mjs --changed` 的影响面裁剪逻辑（test/helpers/impact.mjs）。
 *
 * 这个模块决定「哪些用例可以不跑」，判错的代价是漏测，所以守的重点是**保守性**：
 * 拿不准一律全跑，只有确实解析出依赖闭包、且改动不在其中时才允许跳过。
 *
 * 运行: node test/impact-select.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildImpactGraph, needsRendererSuite, selectAffected, selectUnitSpecs } from './helpers/impact.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, '..');

/** 与 run.mjs 同源的默认套件清单（复用它的 EXCLUDE，避免两处漂移） */
const runner = fs.readFileSync(path.join(testDir, 'run.mjs'), 'utf8');
const EXCLUDE = new Set(
  runner
    .match(/const EXCLUDE = new Set\(\[([\s\S]*?)\]\);/)[1]
    .match(/'([^']+)'/g)
    .map((s) => s.slice(1, -1))
);
const files = fs
  .readdirSync(testDir)
  .filter((n) => n.endsWith('.mjs') && !EXCLUDE.has(n))
  .sort();
assert.ok(files.length > 100, `默认套件文件数异常：${files.length}`);

// 建图要读遍整个 src 依赖树，建一次复用：不传的话每次 selectAffected 都重建，本文件会慢十几秒
const graph = buildImpactGraph(root, files);
const { deps, alwaysRun } = graph;

// ---------- 1) 依赖闭包确实解析出来了 ----------
{
  // 绝大多数测试应能解析出入口；解析率塌了说明入口正则与测试写法脱节，
  // 那时 alwaysRun 会暴涨、裁剪退化成全跑（功能静默失效，不会报错）
  assert.ok(
    deps.size > files.length * 0.7,
    `只有 ${deps.size}/${files.length} 个测试解析出依赖闭包，入口提取可能已失效`
  );

  const adopt = deps.get('git-hunk-adopt.mjs');
  assert.ok(adopt, 'git-hunk-adopt.mjs 应解析出闭包（它用 compile(...) 字面量入口）');
  assert.ok(adopt.has('src/main/git/adopt.ts'), '闭包应含直接入口 adopt.ts');
  assert.ok(adopt.has('src/shared/gitAdopt.ts'), '闭包应沿相对 import 递归到 shared/gitAdopt.ts');

  console.log(`ok: 依赖闭包解析（${deps.size}/${files.length}，alwaysRun ${alwaysRun.size}）`);
}

// ---------- 2) 全仓扫描型守卫必须 alwaysRun ----------
{
  for (const name of ['design-lint.mjs', 'i18n-coverage.mjs', 'renderer-safe-shared.mjs']) {
    if (!files.includes(name)) continue;
    assert.ok(alwaysRun.has(name), `${name} 是全仓扫描型守卫，必须归 alwaysRun`);
  }
  console.log('ok: 全仓扫描型守卫归 alwaysRun');
}

// ---------- 3) 命中与不命中 ----------
{
  const hit = selectAffected(root, files, ['src/main/git/adopt.ts'], graph);
  assert.equal(hit.reason, 'affected');
  assert.ok(hit.selected.includes('git-hunk-adopt.mjs'), '改 adopt.ts 必须跑 git-hunk-adopt');

  // 不相关的改动不应把 adopt 的重测试拖进来（它是最慢的文件之一）
  const miss = selectAffected(root, files, ['src/shared/chatTime.ts'], graph);
  assert.ok(
    !miss.selected.includes('git-hunk-adopt.mjs'),
    '改 chatTime.ts 不该拉起 git-hunk-adopt（闭包里没有它）'
  );
  assert.ok(miss.selected.includes('chat-time.mjs'), '改 chatTime.ts 应跑 chat-time');

  // alwaysRun 地板始终在
  for (const name of alwaysRun) {
    assert.ok(miss.selected.includes(name), `alwaysRun 的 ${name} 在任何 src 改动下都应入选`);
  }
  console.log('ok: 命中/不命中 + alwaysRun 地板');
}

// ---------- 4) 保守兜底：拿不准一律全跑 ----------
{
  for (const f of ['package.json', 'tsconfig.node.json', 'test/helpers/impact.mjs', 'scripts/x.mjs']) {
    const r = selectAffected(root, files, [f], graph);
    assert.equal(
      r.selected.length,
      files.length,
      `${f} 的影响面无法静态推断，必须退化为全跑（实际只选了 ${r.selected.length}）`
    );
  }

  // 删除类改动：文件已不在磁盘上（不存在的路径即删除后的形态）。闭包在删除后的
  // 工作树重建时被删文件会从图里消失，依赖它的测试全部漏跑（false green）——必须全跑。
  // 回归：impact.mjs 曾对删除类改动返回空 selected。
  const del = selectAffected(root, files, ['src/main/git/__deleted-in-this-change__.ts'], graph);
  assert.equal(
    del.selected.length,
    files.length,
    '删除类改动无法安全裁剪，必须退化为全跑'
  );
  assert.match(del.reason, /已删除/);

  // 改测试文件本身 → 至少要跑它自己
  const self = selectAffected(root, files, ['test/chat-time.mjs'], graph);
  assert.ok(self.selected.includes('chat-time.mjs'), '改了某个测试就该跑它');

  console.log('ok: 构建配置/测试基建/删除类改动退化为全跑');
}

// ---------- 5) 纯文档改动不跑任何用例 ----------
{
  for (const f of ['docs/features/testing.md', 'README.md', '.muster/workspace.json']) {
    const r = selectAffected(root, files, [f], graph);
    assert.deepEqual(r.selected, [], `${f} 不该触发任何用例`);
    assert.equal(r.reason, 'docs-only');
  }
  assert.equal(selectAffected(root, files, [], graph).reason, 'no-changes');
  console.log('ok: 纯文档改动不触发用例');
}

// ---------- 6) 渲染层改动要带上 Vitest ----------
{
  // 组件 spec 用 mock 的 window.api 隔离主进程，只吃 renderer 与 shared。
  // 漏判的后果很隐蔽：改渲染层组件时 --changed 只跑到 alwaysRun 地板，看着绿其实没测。
  assert.equal(needsRendererSuite(['src/renderer/panels/GitPanel.tsx']), true);
  assert.equal(needsRendererSuite(['src/shared/types.ts']), true, 'renderer 会 import shared');
  assert.equal(needsRendererSuite(['test/unit/confirm-dialog.spec.tsx']), true);
  assert.equal(needsRendererSuite(['src\\renderer\\App.tsx']), true, '反斜杠路径也要认');

  assert.equal(needsRendererSuite(['src/main/git/adopt.ts']), false, '纯主进程改动不必跑组件单测');
  assert.equal(needsRendererSuite(['docs/x.md']), false);
  assert.equal(needsRendererSuite([]), false);

  console.log('ok: 渲染层改动触发组件单测');
}

// ---------- 7) 组件单测挑选：related 为主，基建/构建配置全套 ----------
{
  assert.deepEqual(selectUnitSpecs(root, ['src/main/git/adopt.ts'], 'affected'), { mode: 'none' });
  assert.deepEqual(selectUnitSpecs(root, ['docs/x.md'], 'docs-only'), { mode: 'none' });
  assert.deepEqual(
    selectUnitSpecs(root, ['vitest.config.ts'], 'all（vitest.config.ts 影响面无法静态推断）'),
    { mode: 'full' },
    '构建配置改动（含 vitest 自身配置）组件单测全套'
  );
  for (const infra of ['test/unit/setup.ts', 'test/unit/helpers/api-mock.ts']) {
    assert.deepEqual(selectUnitSpecs(root, [infra], 'affected'), { mode: 'full' }, `${infra} 是组件单测基建`);
  }

  const tsx = selectUnitSpecs(root, ['src/renderer/src/components/Tooltip.tsx', 'src/main/x.ts'], 'affected');
  assert.equal(tsx.mode, 'related');
  assert.deepEqual(tsx.files, ['src/renderer/src/components/Tooltip.tsx'], '只把渲染层/shared 文件交给 vitest related');

  // Vitest 模块图看不见 readFileSync 读 CSS 的样式守卫 spec，必须按文件名点名带上。
  // 还原即红：去掉 selectUnitSpecs 里的 readFileSync 扫描 → 改 float.css 时 ws-stack-collapse 漏跑
  const css = selectUnitSpecs(root, ['src/renderer/src/styles/float.css'], 'affected');
  assert.equal(css.mode, 'related');
  assert.ok(
    css.files.includes('test/unit/ws-stack-collapse.spec.tsx'),
    `改 float.css 必须带上读它的 ws-stack-collapse.spec.tsx，实际：${css.files.join(', ')}`
  );
  console.log('ok: 组件单测挑选（related + 读文件 spec 点名 + 基建全套）');
}

console.log('impact-select: all ok');
