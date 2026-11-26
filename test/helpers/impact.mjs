/**
 * 「改了哪些文件 → 该跑哪些自测」的静态影响面分析。
 *
 * 原理：测试脚本引用 src 的方式高度统一——`compile('main/git/adopt.ts')`（相对 src/）、
 * `loadTs('src/...')`、`emitTree(..., 'src/...')`，都是字符串字面量。把这些字面量当入口，
 * 再沿相对 import 递归展开（与 helpers/shared-compile.mjs、helpers/transpile.mjs 同一套
 * 解析语义：`<spec>.ts` 或 `<spec>/index.ts`），就得到每个测试的 src 依赖闭包。
 *
 * 安全原则：**只有在「确实解析出了依赖集合」且改动不在其中时才跳过**。
 * 解析不出入口（纯函数自测、全仓扫描型守卫如 design-lint / i18n-coverage）一律归为
 * alwaysRun，宁可多跑。任何拿不准的情况都退化为「全跑」，不赌。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 纯类型 import 运行期不存在，不算依赖（与两个 transpile helper 一致） */
const TYPE_ONLY = /(?:import|export)\s+type\s+(?:\{[^}]*\}|[\w$]+)\s+from\s+'[^']+';?\r?\n/g;
const RELATIVE_SPECIFIER = /(?:from\s+|import\s*\(\s*)'(\.[^']*)'/g;

/** compile('main/x.ts') —— 路径相对 src/ */
const COMPILE_CALL = /\b(?:compile|compileShared)\(\s*'([^']+\.tsx?)'\s*\)/g;
const LOAD_CALL = /\b(?:load|loadTs)\(\s*'((?:src\/)?(?:main|shared|renderer)\/[^']+\.tsx?)'\s*\)/g;
/** 任何 'src/....ts' 字面量（loadTs / emitTree / path.join(root, 'src/...') 都覆盖） */
const SRC_LITERAL = /'(src\/[^']+\.tsx?)'/g;
/** 分段拼接：path.join(root, 'src', 'main', 'git', 'x.ts') */
const SRC_SEGMENTS = /'src'((?:\s*,\s*'[^']+')+\.?)/g;
const SEGMENT = /'([^']+)'/g;
/**
 * 全仓扫描型守卫（design-lint / i18n-coverage / surface-parity / renderer-safe-shared…）：
 * 遍历 src 目录做静态断言，没有固定入口，任何 src 改动都可能影响 → alwaysRun。
 * 判据要同时命中「目录遍历」和「src 路径段」，只看其一会把 path.join(x,'main') 之类误伤。
 */
const DIR_WALK = /\breaddirSync\b|\bglobSync\b|\breaddir\(/;
// A test that reads one src file and traverses a temporary fixture is not a whole-src scan.
const SRC_DIR = /'(?:\.\.\/)?src(?:\/[^']*)?'/g;
const SRC_DIR_SEGMENTS = /'src'((?:\s*,\s*'[^']+')*)/g;
function scansSource(source) {
  if (!DIR_WALK.test(source)) return false;
  const paths = [...source.matchAll(SRC_DIR)]
    .filter(match => !/^\s*,\s*'/.test(source.slice(match.index + match[0].length)))
    .map(match => match[0].slice(1, -1));
  for (const match of source.matchAll(SRC_DIR_SEGMENTS)) {
    paths.push(['src', ...[...match[1].matchAll(SEGMENT)].map(segment => segment[1])].join('/'));
  }
  return paths.some(file => !/\.[a-z0-9]+$/i.test(file));
}

/** 把相对 specifier 解析成实际 .ts/.tsx 文件（找不到返回 null） */
function resolveRelative(fromAbs, spec) {
  const base = path.resolve(path.dirname(fromAbs), spec);
  for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

/** 从入口出发，收集相对 import 闭包（返回相对仓库根、正斜杠的路径集合） */
function closureOf(entryAbs, root, cache) {
  const seen = new Set();
  const stack = [entryAbs];
  while (stack.length > 0) {
    const abs = stack.pop();
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (seen.has(rel)) continue;
    let deps = cache.get(abs);
    if (!deps) {
      if (!fs.existsSync(abs)) continue;
      const source = fs.readFileSync(abs, 'utf8').replace(TYPE_ONLY, '');
      deps = [...source.matchAll(RELATIVE_SPECIFIER)]
        .map((m) => resolveRelative(abs, m[1]))
        .filter(Boolean);
      cache.set(abs, deps);
    }
    seen.add(rel);
    stack.push(...deps);
  }
  return seen;
}

/**
 * @param root 仓库根
 * @param testFiles 测试文件名数组（test/ 顶层，如 'git-worktree.mjs'）
 * @returns { deps: Map<name, Set<relPath>>, alwaysRun: Set<name> }
 */
export function buildImpactGraph(root, testFiles) {
  const deps = new Map();
  const alwaysRun = new Set();
  const cache = new Map();
  const entryClosures = new Map();

  for (const name of testFiles) {
    const testAbs = path.join(root, 'test', name);
    let source;
    try {
      source = fs.readFileSync(testAbs, 'utf8');
    } catch {
      alwaysRun.add(name);
      continue;
    }

    // 全仓扫描型守卫 → 任何 src 改动都可能影响它
    if (scansSource(source)) {
      alwaysRun.add(name);
      continue;
    }

    const entries = new Set();
    for (const m of source.matchAll(COMPILE_CALL)) entries.add(path.join(root, 'src', m[1].replace(/^src\//, '')));
    for (const m of source.matchAll(LOAD_CALL)) entries.add(path.join(root, 'src', m[1].replace(/^src\//, '')));
    for (const m of source.matchAll(SRC_LITERAL)) entries.add(path.join(root, m[1]));
    for (const m of source.matchAll(SRC_SEGMENTS)) {
      const segs = [...m[1].matchAll(SEGMENT)].map((s) => s[1]);
      if (segs.length > 0 && /\.tsx?$/.test(segs.at(-1))) {
        entries.add(path.join(root, 'src', ...segs));
      }
    }

    const existing = [...entries].filter((p) => fs.existsSync(p));
    if (existing.length === 0) {
      // 解析不出任何 src 入口：纯函数自测或写法特殊，宁可多跑
      alwaysRun.add(name);
      continue;
    }

    const closure = new Set();
    for (const entry of existing) {
      // Cache within this analysis only, never across edits/runs.
      if (!entryClosures.has(entry)) entryClosures.set(entry, closureOf(entry, root, cache));
      for (const rel of entryClosures.get(entry)) closure.add(rel);
    }
    deps.set(name, closure);
  }

  return { deps, alwaysRun };
}

/**
 * 渲染层组件单测（Vitest）不在 run.mjs 管辖内，影响面也不同源：
 * 那些 spec 通过 mock 的 window.api 隔离了主进程，只吃 src/renderer 与 src/shared。
 */
export function needsRendererSuite(changedFiles) {
  return changedFiles.some((f) => {
    const p = f.replaceAll('\\', '/');
    return p.startsWith('src/renderer/') || p.startsWith('src/shared/') || p.startsWith('test/unit/');
  });
}

/** 组件单测基建：动了就可能影响任意 spec */
const isUnitInfra = (f) => f === 'test/unit/setup.ts' || f.startsWith('test/unit/helpers/');

/**
 * 挑组件单测：把改动文件交给 `vitest related`，由 Vitest 自己的模块图找出 import 了它们的 spec。
 *
 * 模块图看不见「用 fs.readFileSync 读源码/CSS 文本」的 spec（样式守卫类），
 * 所以另扫一遍：含 readFileSync 且文本里出现改动文件 basename 的 spec 直接点名带上。
 *
 * @param reason selectAffected 的 reason；以 'all' 开头（构建配置/删除类）时组件单测也全跑
 * @returns { mode: 'none' } | { mode: 'full' } | { mode: 'related', files: string[] }
 */
export function selectUnitSpecs(root, changedFiles, reason) {
  if (reason === 'no-changes' || reason === 'docs-only') return { mode: 'none' };
  if (reason.startsWith('all')) return { mode: 'full' };
  const changed = changedFiles.map((f) => f.split(path.sep).join('/'));
  if (changed.some(isUnitInfra)) return { mode: 'full' };
  const relevant = changed.filter((f) => needsRendererSuite([f]));
  if (relevant.length === 0) return { mode: 'none' };

  const files = new Set(relevant);
  const basenames = relevant
    .filter((f) => !/\.spec\.tsx?$/.test(f))
    .map((f) => path.posix.basename(f));
  if (basenames.length > 0) {
    for (const spec of listSpecs(path.join(root, 'test', 'unit'))) {
      const source = fs.readFileSync(spec, 'utf8');
      if (!source.includes('readFileSync')) continue;
      if (basenames.some((b) => source.includes(b))) {
        files.add(path.relative(root, spec).split(path.sep).join('/'));
      }
    }
  }
  return { mode: 'related', files: [...files] };
}

function listSpecs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listSpecs(p));
    else if (/\.spec\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 按改动文件挑选要跑的测试。
 * @param graph 可选的预建依赖图（buildImpactGraph 的结果）。建图要读遍整个 src 依赖树，
 *   不算便宜；生产路径只调一次无所谓，反复调用时传进来复用。
 * @returns { selected: string[], reason: string } —— reason 为 'all' 时表示无法安全裁剪
 */
export function selectAffected(root, testFiles, changedFiles, graph) {
  const changed = changedFiles.map((f) => f.split(path.sep).join('/')).filter(Boolean);
  if (changed.length === 0) return { selected: [], reason: 'no-changes' };

  const ignorable = (f) =>
    f.startsWith('docs/') ||
    f.startsWith('.muster/') ||
    f.endsWith('.md') ||
    f.startsWith('.tmp/');

  const relevant = changed.filter((f) => !ignorable(f));
  if (relevant.length === 0) return { selected: [], reason: 'docs-only' };

  // 删除/改名类改动：依赖闭包是在删除生效后的工作树上重建的，被删文件从图里消失
  // （入口被 fs.existsSync 滤掉、它人的 import 也解析不到），依赖它的测试会全部漏跑
  // ——false green。这类改动无法安全裁剪，一律全跑。
  const deleted = relevant.find((f) => !fs.existsSync(path.join(root, f)));
  if (deleted) return { selected: testFiles, reason: `all（${deleted} 已删除，闭包无法安全推断）` };

  // 测试基础设施 / 构建配置 / 脚本变了，影响面无法静态推断 → 全跑
  const wildcard = relevant.find(
    (f) =>
      f.startsWith('test/helpers/') ||
      f.startsWith('scripts/') ||
      (!f.startsWith('src/') && !f.startsWith('test/'))
  );
  if (wildcard) return { selected: testFiles, reason: `all（${wildcard} 影响面无法静态推断）` };

  const changedSrc = new Set(relevant.filter((f) => f.startsWith('src/')));
  const changedTests = new Set(
    relevant.filter((f) => f.startsWith('test/')).map((f) => f.slice('test/'.length))
  );

  // Editing only a spec cannot affect unrelated offline tests. Avoid rebuilding all source closures.
  if (changedSrc.size === 0) {
    return { selected: testFiles.filter(name => changedTests.has(name)), reason: 'affected' };
  }
  const { deps, alwaysRun } = graph ?? buildImpactGraph(root, testFiles);

  const matched = [];
  const selected = testFiles.filter((name) => {
    if (changedTests.has(name)) return true;
    if (alwaysRun.has(name)) return changedSrc.size > 0;
    const closure = deps.get(name);
    if (!closure) return true;
    for (const f of changedSrc) if (closure.has(f)) { matched.push(name); return true; }
    return false;
  });

  return { selected, reason: 'affected', matched };
}
