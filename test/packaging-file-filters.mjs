/**
 * 打包裁剪的回归守卫（对应 electron-builder.yml 末尾「排除模式合同」）。
 *
 * 守三件事：
 * 1. 死重被排掉（sourcemap / .d.ts / .ts 源码 / README）——它们是安装耗时的主因
 *    （落盘文件数 + Defender 逐文件扫描），且运行时零用途。
 * 2. **运行时资产没被误杀**：.node/.dll/.exe/.wasm/package.json 这些必须留着。
 * 3. **不许给 win/mac/linux 加平台专属 `files`**——加了会让顶层 files 的正向模式失效，
 *    electron-builder 自动补 `**\/*` 把仓库根目录（refs/、.dev-sandbox/、.tmp/）扫进 asar，
 *    构建还照常成功。2026-09-15 实测 Setup.exe 266MB→1061MB，这类静默膨胀必须在测试里拦住。
 * 另外覆盖 before-pack 钩子的 @esbuild 平台裁剪规划（宿主平台那个包一个都不能删），
 * 以及 Claude 平台 vendor 排除、JS SDK 本体保留。
 * 还守国内镜像配置在位（.npmrc registry + package.json config 二进制镜像，2026-09-20 起）。
 * 双语 README 的克隆地址与 GitHub 更新源需要一致。
 *
 * 匹配逻辑复刻 app-builder-lib：node_modules 过滤器只采纳 `!` 模式并 prependPattern('**\/*')
 * （getNodeModuleFileMatcher），判定用 minimatchAll（util/filter.js）。
 *
 * 运行: node test/packaging-file-filters.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { keepDirsFor, planEsbuildPrune, removePruneTargets, ensureDarwinPtyPrebuildExecBits, patchNodePtyHelperPath } from '../scripts/before-pack.mjs';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const require = createRequire(import.meta.url);
const { Minimatch } = require('minimatch');
const YAML = require('yaml');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = YAML.parse(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));

const updateSource = config.publish;
assert.equal(updateSource?.provider, 'github', 'The update source must use GitHub Releases');
const cloneCommand = `git clone https://github.com/${updateSource.owner}/${updateSource.repo}.git`;
for (const file of ['README.md', 'README.zh-CN.md']) {
  const readme = fs.readFileSync(path.join(root, file), 'utf8');
  assert.ok(
    readme.split(/\r?\n/).includes(cloneCommand),
    `${file} clone command must match the GitHub update repository`
  );
}

const bundledExtensions = (config.extraResources ?? []).filter(entry => typeof entry === 'object' && /^extensions(?:\/|$)/.test(entry.to ?? ''));
assert.equal(bundledExtensions.length, 1, 'Only Daily Report ships with the app');
const [dailyReport] = bundledExtensions;
assert.equal(dailyReport.from, 'resources/extensions/daily-report');
assert.equal(dailyReport.to, 'extensions/daily-report');
for (const file of ['extension.json', 'domain.mjs', 'agent.md', 'ui/panel.html', 'ui/panel.css']) {
  assert.ok(dailyReport.filter.some(pattern => new Minimatch(pattern).match(file)), `Daily Report packaging must include ${file}`);
  assert.ok(fs.existsSync(path.join(root, dailyReport.from, file)));
}

// PowerShell cannot execute a script inside asar; the helper must be unpacked.
assert.ok((config.asarUnpack ?? []).includes('out/main/desktop/windows-escape-monitor.ps1'));
assert.ok(fs.existsSync(path.join(root, 'src/main/desktop/windows-escape-monitor.ps1')));

// Removed memory inference dependencies and model assets must not return to a fresh package.
{
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
  assert.equal(pkg.dependencies['@huggingface/transformers'],undefined);
  assert.equal(lock.packages['node_modules/@huggingface/transformers'],undefined);
  assert.ok(!(config.extraResources??[]).some(item=>typeof item==='object'&&(item.from==='build/memory-model'||item.to==='memory-model')));
}

/** app-builder-lib/out/util/filter.js 的 minimatchAll */
function minimatchAll(target, patterns, isDir) {
  let match = false;
  for (const pattern of patterns) {
    if (match !== pattern.negate) continue;
    match = pattern.match(target, isDir && !pattern.negate);
  }
  return match;
}

/** 复刻 getNodeModuleFileMatcher：顶层 files 里只取 `!` 模式，前置 '**\/*' */
function nodeModuleFilter() {
  const raw = (config.files ?? []).filter((it) => typeof it === 'string' && it.startsWith('!'));
  assert.ok(raw.length > 0, '顶层 files 里没有任何 ! 排除模式，配置可能被改坏');
  const patterns = ['**/*', ...raw].map((it) => new Minimatch(it, { dot: true }));
  return (target, isDir = false) => minimatchAll(target, patterns, isDir);
}

// ── 1. 平台专属 files 是禁区（顶层 files 的正向模式会被它整体废掉）──
{
  for (const platform of ['win', 'mac', 'linux']) {
    const block = config[platform];
    assert.ok(
      block == null || block.files == null,
      `${platform}.files 不允许存在：它会让顶层 files 的正向模式失效，` +
        'electron-builder 会自动补 **/* 把仓库根目录扫进 asar（见 electron-builder.yml 排除模式合同第 1 条）'
    );
  }
  // 顶层 files 必须留有正向模式，否则同样会触发 containsOnlyIgnore → 自动补 '**/*'
  const positives = (config.files ?? []).filter((it) => typeof it === 'string' && !it.startsWith('!'));
  assert.ok(
    positives.includes('out/**/*'),
    `顶层 files 必须保留 out/**/* 这类正向模式，当前只有：${JSON.stringify(positives)}`
  );
}

// ── 2. 与平台无关的文件类型裁剪 ──
{
  const keep = nodeModuleFilter();
  const dropped = [
    'node_modules/openai/index.js.map',
    'node_modules/@earendil-works/pi-coding-agent/dist/index.js.map',
    'node_modules/openai/index.d.ts',
    'node_modules/openai/index.d.mts',
    'node_modules/zod/src/index.ts',
    'node_modules/@earendil-works/pi-coding-agent/docs/skills.md',
    'node_modules/undici/docs/api/Dispatcher.md',
    'node_modules/openai/README.md',
    'node_modules/openai/LICENSE',
    // Claude 原生 vendor 由用户安装，JS SDK 保留。
    'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
  ];
  for (const f of dropped) assert.equal(keep(f), false, `应被排除却保留了：${f}`);

  // 运行时真会加载的东西一个都不能少
  const kept = [
    'node_modules/openai/index.js',
    'node_modules/openai/index.mjs',
    'node_modules/openai/package.json',
    'node_modules/yaml/dist/index.js',
    'node_modules/i18next/index.js',
    'node_modules/node-pty/build/Release/pty.node',
    'node_modules/node-pty/build/Release/conpty.dll',
    'node_modules/tree-sitter-wasms/out/tree-sitter-cpp.wasm',
    'node_modules/@colbymchenry/codegraph-win32-x64/node.exe',
    'node_modules/@colbymchenry/codegraph-win32-x64/lib/kernel/codegraph-kernel.node',
    'node_modules/@vscode/ripgrep/bin/rg.exe',
    'node_modules/@esbuild/win32-x64/esbuild.exe',
    // Claude GUI 仍使用 JS SDK。
    'node_modules/@anthropic-ai/claude-agent-sdk/package.json',
    'out/main/agentSession/drivers/codex/worker/native-worker.mjs'
  ];
  for (const f of kept) assert.equal(keep(f), true, `运行时资产被误杀：${f}`);
}

// ── 3. locales 裁剪必须与 i18n 的 supportedLngs 对齐 ──
{
  const langs = config.electronLanguages;
  assert.ok(Array.isArray(langs) && langs.length > 0, 'electronLanguages 应为非空数组');
  // en-US 是 Chromium 的兜底 locale，缺了内置 UI（右键菜单/PDF 阅读器等）会退化
  assert.ok(langs.includes('en-US'), 'electronLanguages 必须含 en-US（Chromium 兜底）');
  assert.ok(langs.includes('zh-CN'), 'electronLanguages 必须含 zh-CN（应用源语言）');
}

// ── 4. asarUnpack 整树解包这条不能丢（子进程按真实文件解析，见 packaging.md）──
assert.ok((config.asarUnpack ?? []).includes('out/main/extensions/sdk/extension-runtime-worker.mjs'),
  'The extension runtime entry must be unpacked for the Electron-as-Node worker');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.deepEqual(
    Object.keys(lock.packages).filter(name => /(?:^|\/)node_modules\/@openai\/codex(?:[-/]|$)/.test(name)),
    [],
    'The lockfile must not install another codex launcher that can shadow the user CLI on npm PATH'
  );
  assert.ok((config.asarUnpack ?? []).includes('out/main/agentSession/drivers/codex/worker/**'),
    'The native app-server worker must launch from a real unpacked file');
  for (const name of ['koffi', 'ajv']) {
    assert.ok(pkg.dependencies[name], `${name} is a extension production dependency`);
    assert.ok(lock.packages[''].dependencies[name], `${name} is present in the production lockfile root`);
  }
  assert.ok(
    (config.asarUnpack ?? []).includes('node_modules/**/*'),
    'asarUnpack 必须保留 node_modules 整树解包'
  );
}

// ── 5. beforePack 钩子接线在位 ──
{
  assert.equal(
    config.beforePack,
    './scripts/before-pack.mjs',
    'beforePack 钩子没接上，@esbuild 平台裁剪会失效（安装包多 271MB）'
  );
}

// ── 5b. extraResources 收录：宿主域技能真源必须随包分发（P1 安装/升级链，2026-10-23）──
// resources/skills 只能走 extraResources：顶层 files 的 '!**/*.md' 会把 asar 里的 SKILL.md
// 排掉，而 extraResources 是独立复制链不受 files 过滤（与 resources/cli 同机制）。
// 运行时解析（src/main/metaAgent/hostSkillProvision.ts）：打包=process.resourcesPath/skills。
{
  const extra = config.extraResources ?? [];
  const entry = extra.find(
    (it) => typeof it === 'object' && it.from === 'resources/skills' && it.to === 'skills'
  );
  assert.ok(entry != null, 'extraResources 必须收录 resources/skills → skills（宿主域技能正文进安装包）');
  // 源目录与运行时声明清单双向对账（单一真源：hostSkillDomainDirs 从声明派生）。
  // 这里不再硬编码域数量：新增宿主资源必须同时补声明与真源正文，丢任一侧即红。
  const gateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-skills-'));
  try {
    const compile = createSharedCompiler(root, gateTmp);
    const { hostSkillDomainDirs } = await import(pathToFileURL(compile('main/metaAgent/hostDomainSkills.ts')).href);
    const declared = [...hostSkillDomainDirs()].sort();
    const skillsDir = path.join(root, 'resources', 'skills');
    const domains = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((it) => it.isDirectory())
      .map((it) => it.name)
      .sort();
    assert.deepEqual(
      domains,
      declared,
      `resources/skills 域目录必须与运行时声明清单一致（实得 ${JSON.stringify(domains)}，hostSkillDomainDirs 声明 ${JSON.stringify(declared)}）`
    );
    for (const dir of domains) {
      assert.ok(
        fs.existsSync(path.join(skillsDir, dir, 'SKILL.md')),
        `resources/skills/${dir}/SKILL.md 缺失（安装链会跳过该域并 warn）`
      );
    }
  } finally {
    fs.rmSync(gateTmp, { recursive: true, force: true });
  }
}

// ── 6. @esbuild 平台裁剪规划：只删非目标平台，宿主平台一个都不许删 ──
{
  assert.deepEqual(keepDirsFor('win32', 1), ['win32-x64'], 'Arch 枚举 1 应解析为 x64');
  assert.deepEqual(keepDirsFor('linux', 0), ['linux-ia32']);
  // mac 双架构 dmg 一次运行连打（yml target arch [x64, arm64]），darwin 无论目标架构两个都保留：
  // 裁剪是破坏性的，按 arch 只留一个会让第一架构 pass 删掉第二架构 pass 需要的目录
  // （2026-10-07 首次 mac 构建实测 x64 dmg 里 @esbuild 整体缺失、esbuild 运行时必挂）
  assert.deepEqual(keepDirsFor('darwin', 1), ['darwin-x64', 'darwin-arm64']);
  assert.deepEqual(keepDirsFor('darwin', 3), ['darwin-x64', 'darwin-arm64']);
  assert.deepEqual(keepDirsFor('darwin', 4), ['darwin-x64', 'darwin-arm64'], 'universal 同样双架构');

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'esbuild-prune-'));
  try {
    const platforms = ['win32-x64', 'win32-arm64', 'android-arm', 'darwin-x64', 'linux-mips64el'];
    // 顶层 @esbuild + 嵌套在 @earendil-works/pi-coding-agent/node_modules 下的一份
    // （真实布局就是嵌套那份被 traversal 提升到顶层，两处都要被规划到）
    const nests = ['', path.join('@earendil-works', 'pi-coding-agent', 'node_modules')];
    for (const nest of nests) {
      for (const p of platforms) {
        fs.mkdirSync(path.join(fixture, nest, '@esbuild', p), { recursive: true });
        fs.writeFileSync(path.join(fixture, nest, '@esbuild', p, 'package.json'), '{}');
      }
    }
    // 同名以外的包不该被碰到
    fs.mkdirSync(path.join(fixture, 'esbuild', 'lib'), { recursive: true });

    const { remove, missingKeep } = planEsbuildPrune(fixture, keepDirsFor('win32', 1));
    assert.equal(missingKeep.length, 0, `宿主平台包存在时不该报缺失：${missingKeep.join(', ')}`);
    const names = remove.map((it) => path.relative(fixture, it).replace(/\\/g, '/')).sort();
    assert.deepEqual(names, [
      '@earendil-works/pi-coding-agent/node_modules/@esbuild/android-arm',
      '@earendil-works/pi-coding-agent/node_modules/@esbuild/darwin-x64',
      '@earendil-works/pi-coding-agent/node_modules/@esbuild/linux-mips64el',
      '@earendil-works/pi-coding-agent/node_modules/@esbuild/win32-arm64',
      '@esbuild/android-arm',
      '@esbuild/darwin-x64',
      '@esbuild/linux-mips64el',
      '@esbuild/win32-arm64'
    ]);

    // 宿主平台包缺失是异常，必须被报出来（钩子会打 warn）
    const orphan = planEsbuildPrune(fixture, keepDirsFor('linux', 0));
    assert.equal(orphan.missingKeep.length, 2, '两处 @esbuild 都没有 linux-ia32，应各报一次缺失');

    // darwin 双架构保留：目标 arm64 时不能删 darwin-x64；fixture 里有 darwin-x64 就不算缺失
    const darwinPlan = planEsbuildPrune(fixture, keepDirsFor('darwin', 3));
    assert.equal(darwinPlan.missingKeep.length, 0, 'fixture 有 darwin-x64，不该报缺失');
    assert.ok(
      !darwinPlan.remove.some((it) => it.includes(`@esbuild${path.sep}darwin-x64`) || it.endsWith('@esbuild/darwin-x64')),
      'darwin 目标不允许删 darwin-x64（另一架构 dmg 的 pass 还要用）'
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

// ── 7. 国内镜像配置在位（2026-09-20 起；误删则打包链路静默直连 GitHub 超时）──
{
  const npmrc = fs.readFileSync(path.join(root, '.npmrc'), 'utf8');
  assert.match(
    npmrc,
    /^registry=https:\/\/registry\.npmmirror\.com\s*$/m,
    '.npmrc 的 npmmirror registry 不在位，npm install 会直连 npmjs（国内网络经常超时）'
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const key of ['electron_mirror', 'electron_builder_binaries_mirror']) {
    const url = (pkg.config ?? {})[key];
    assert.ok(
      typeof url === 'string' && /^https:\/\/npmmirror\.com\/mirrors\/.+\/$/.test(url),
      `package.json config.${key} 缺失或不是 npmmirror 镜像 URL（须以 / 结尾，@electron/get 按纯字符串拼接）：` +
        'npm run 打包链路会静默直连 GitHub 超时'
    );
  }
}

// ── 8. 裁剪执行器同时接受文件和目录 ──
{
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-prune-'));
  try {
    const directory = path.join(fixture, 'remove-dir');
    const file = path.join(fixture, 'remove-file');
    const keep = path.join(fixture, 'keep');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'nested'), '123');
    fs.writeFileSync(file, '45');
    fs.writeFileSync(keep, '6');
    assert.equal(removePruneTargets([directory,file]), 5);
    assert.ok(!fs.existsSync(directory));
    assert.ok(!fs.existsSync(file));
    assert.ok(fs.existsSync(keep));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

// ── 9. mac：node-pty prebuilds 的 spawn-helper 执行位（2026-10-07 首次 mac 构建实测：
//     npm 装出来 644，posix_spawnp 直接失败；非宿主架构 dmg 的 pty 走 prebuilds 回退路径）──
{
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-exec-'));
  try {
    const nm = path.join(fixture, 'node_modules');
    const mk = (rel, mode) => {
      const p = path.join(nm, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, 'x'.repeat(16));
      fs.chmodSync(p, mode);
      return p;
    };
    const arm64Helper = mk('node-pty/prebuilds/darwin-arm64/spawn-helper', 0o644);
    const x64Helper = mk('node-pty/prebuilds/darwin-x64/spawn-helper', 0o644);
    const winHelper = mk('node-pty/prebuilds/win32-x64/spawn-helper.exe', 0o644); // 非 darwin 不碰
    mk('node-pty/build/Release/spawn-helper', 0o755); // node-gyp 产物已有 +x，不碰

  const changed = ensureDarwinPtyPrebuildExecBits(nm);
  assert.deepEqual([...changed].sort(), [arm64Helper, x64Helper].sort(), '只补 darwin prebuilds 两个 helper');
  // 执行位断言仅在支持 POSIX 权限位的文件系统上成立：Windows（NTFS）fs.chmod 不落 +x，
  // mode 恒 0o666/0o444——此前 5b 首断言短路使本节从未在 Windows 跑到（2026-10-26 解短路后补）
  const posixBits = process.platform !== 'win32';
  if (posixBits) {
    assert.equal(fs.statSync(arm64Helper).mode & 0o111, 0o111, 'darwin-arm64 helper 应有执行位');
    assert.equal(fs.statSync(x64Helper).mode & 0o111, 0o111, 'darwin-x64 helper 应有执行位');
  }
  assert.equal(fs.statSync(winHelper).mode & 0o111, 0, 'win32 的执行位不该被碰');
  if (posixBits) {
    assert.equal(fs.statSync(path.join(nm, 'node-pty/build/Release/spawn-helper')).mode & 0o111, 0o111, 'build/Release 保持不变');
  }

  const again = ensureDarwinPtyPrebuildExecBits(nm);
  // win32 上 mode 恒无 +x，函数会重复报告同一批文件（幂等语义只在 POSIX 成立，不算回归）
  if (posixBits) assert.equal(again.length, 0, '幂等：第二次调用不应再改任何文件');
  else assert.deepEqual([...again].sort(), [arm64Helper, x64Helper].sort(), 'win32 无权限位可落，重复报告同一批（幂等仅 POSIX 承诺）');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

// ── 10. node-pty helperPath 双重 unpack 补丁（2026-10-07 首次 mac 出包实测：
//     整树 asarUnpack 下 unixTerminal 的 replace 会拼出 app.asar.unpacked.unpacked，
//     打包版终端创建即 "posix_spawnp failed."，dev 路径复现不了）──
{
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-patch-'));
  try {
    const nm = path.join(fixture, 'node_modules');
    const target = path.join(nm, 'node-pty', 'lib', 'unixTerminal.js');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const original =
      "var helperPath = native.dir + '/spawn-helper';\n" +
      "helperPath = path.resolve(__dirname, helperPath);\n" +
      "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');\n" +
      "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');\n";
    fs.writeFileSync(target, original);

    assert.equal(patchNodePtyHelperPath(nm), true, '首次应对 1.1.0 源码命中并改写');
    const patched = fs.readFileSync(target, 'utf8');
    assert.ok(!patched.includes("'app.asar', 'app.asar.unpacked'"), '裸子串 replace 必须被替换掉');
    assert.ok(patched.includes("'app.asar' + path.sep"), '替换后须锚定路径分隔符');
    assert.equal(patchNodePtyHelperPath(nm), false, '重复构建应幂等返回 false');

    // 模式漂移（node-pty 升级改了源码）：打 warn 不改文件，不静默吞
    fs.writeFileSync(target, '// some future node-pty source');
    assert.equal(patchNodePtyHelperPath(nm), false, '未知源码应返回 false');

    // 语义验证：锚定分隔符后，两种布局都只映射一次（样例是 mac 布局，分隔符显式用 /，
    // 不随测试机的 path.sep 变——Windows 上跑本节时 path.sep 是反斜杠会匹配不到）
    const inAsar = '/Applications/App.app/Contents/Resources/app.asar/node_modules/node-pty/build/Release/spawn-helper';
    const unpacked = '/Applications/App.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper';
    const sep = '/';
    const map = (p) => p.replace('app.asar' + sep, 'app.asar.unpacked' + sep);
    assert.equal(map(inAsar), unpacked, 'asar 内路径应映射到解包孪生');
    assert.equal(map(unpacked), unpacked, '已解包路径不得二次拼接（原 bug 形态）');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

// The release workflow must retain unpacked app directories for packaged smoke.
{
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release-quality.yml'), 'utf8');
  assert.match(workflow, /electron-builder \$\{\{ matrix\.args \}\} --publish never/, 'CI package targets must build installers without publishing them');
  assert.match(workflow, /Upload packaged smoke diagnostics/, 'packaged smoke must upload failure diagnostics');
  assert.match(workflow, /MUSTER_PACKAGED_KEEP_PROFILE: '1'/, 'packaged smoke workflow must preserve failed userData');
  const definition = YAML.parse(workflow);
  const reviewWorkflow = YAML.parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'github-pr-review-draft.yml'), 'utf8'));
  const node24ActionMajors = new Map([
    ['actions/checkout', 5],
    ['actions/setup-node', 5],
    ['actions/upload-artifact', 6],
    ['actions/download-artifact', 7],
  ]);
  for (const workflowDefinition of [definition, reviewWorkflow]) {
    for (const job of Object.values(workflowDefinition.jobs)) {
      const setupNode = job.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
      assert.equal(setupNode?.with?.['node-version'], 24, `${workflowDefinition.name}: CI scripts must run on Node.js 24`);
      for (const step of job.steps) {
        const [action, version] = step.uses?.split('@') ?? [];
        const minimumMajor = node24ActionMajors.get(action);
        if (minimumMajor !== undefined) {
          const major = Number(version?.match(/^v(\d+)(?:\.|$)/)?.[1]);
          assert.ok(major >= minimumMajor, `${step.uses}: use an Action version that declares Node.js 24 support`);
        }
      }
    }
  }
  assert.deepEqual(definition.on.push?.branches, ['main'], 'PRs provide quality checks for work branches');
  assert.ok(Object.hasOwn(definition.on, 'pull_request'), 'PRs must trigger the quality matrix');
  assert.deepEqual(definition.on.workflow_dispatch?.inputs?.quality_only, {
    description: 'Run quality checks only', type: 'boolean', default: false
  });
  assert.deepEqual(definition.on.workflow_dispatch?.inputs?.signed_release, {
    description: 'Build signed release artifacts (main only)', type: 'boolean', default: false
  });
  const jobs = definition.jobs;
  const qualitySteps = jobs.quality.steps;
  const dependenciesIndex = qualitySteps.findIndex(step => step.run === 'npm ci');
  const testIndex = qualitySteps.findIndex(step => step.run === 'npm test');
  assert.ok(dependenciesIndex >= 0 && dependenciesIndex < testIndex, 'quality must install npm dependencies before testing');
  assert.equal(qualitySteps.find(step => step.uses?.startsWith('actions/checkout@'))?.with?.['fetch-depth'], 0);
  assert.equal(qualitySteps[testIndex]?.env?.MUSTER_CI_TEST_BASE,
    '${{ github.event.pull_request.base.sha || github.event.before }}');
  const browserSetup = qualitySteps.slice(dependenciesIndex + 1, testIndex)
    .filter(step => step.run?.startsWith('npx playwright install'))
    .map(step => ({ if: step.if, run: step.run }));
  assert.deepEqual(browserSetup, [
    { if: "runner.os == 'Linux'", run: 'npx playwright install --with-deps --only-shell chromium' },
    { if: "runner.os != 'Linux'", run: 'npx playwright install --only-shell chromium' },
  ], 'quality must provision Chromium after npm ci and before visual tests can run');
  assert.equal(qualitySteps.find(step => step.name === 'Validate signed release inputs')?.if,
    "inputs.signed_release && (inputs.quality_only || github.ref != 'refs/heads/main')");
  const typecheck = qualitySteps.find(step => step.run === 'npm run typecheck');
  assert.equal(typecheck?.env?.NODE_OPTIONS, '--max-old-space-size=4096', 'cold CI typecheck needs more than the runner default heap');
  const packageJob = jobs.package;
  assert.equal(packageJob.if,
    "(github.event_name == 'workflow_dispatch' && !inputs.quality_only) || (github.event_name == 'push' && github.ref == 'refs/heads/main' && github.event.repository.private)",
    'package installers for private main pushes and manual packaging runs');
  assert.equal(packageJob.strategy.matrix.include.find(target => target.name === 'windows')?.os, 'windows-2022', 'the pinned node-gyp recognizes Visual Studio 2022');
  assert.deepEqual(packageJob.strategy.matrix.include.map(target => target.driver_cache), ['win-x64', 'mac-x64', 'mac-arm64', 'linux-x64']);
  const prepareIndex = packageJob.steps.findIndex(step => step.run?.includes('desktop-driver/prepare.mjs --prepare'));
  const buildIndex = packageJob.steps.findIndex(step => step.run?.includes('npx electron-builder'));
  const archiveIndex = packageJob.steps.findIndex(step => step.run?.includes('tar -cf'));
  const uploadIndex = packageJob.steps.findIndex(step => step.with?.name?.startsWith('packaged-'));
  assert.ok(prepareIndex >= 0 && prepareIndex < buildIndex, 'each clean package runner must prepare its pinned Cua bundle before packaging');
  assert.match(packageJob.steps[prepareIndex].run, /--output "\$\{\{ github\.workspace \}\}\/\.tmp\/desktop-driver\/\$\{\{ matrix\.driver_cache \}\}"/);
  assert.ok(buildIndex < archiveIndex && archiveIndex < uploadIndex, 'package output must be archived before upload to preserve Unix modes and links');
  assert.match(packageJob.steps[uploadIndex].with.path, /packaged-.*\.tar$/);
  const signing = packageJob.steps.find(step => step.name === 'Prepare protected release signing');
  assert.equal(signing?.if, "inputs.signed_release && runner.os != 'Linux'");
  assert.equal(packageJob.env, undefined, 'verification steps must not inherit release signing secrets');
  assert.match(packageJob.steps[buildIndex].run, /"-c\.forceCodeSigning=\$\{\{ inputs\.signed_release && runner\.os != 'Linux' && 'true' \|\| 'false' \}\}"/, 'pass a literal signing boolean as one argument in Bash and PowerShell');
  assert.equal(packageJob.steps.find(step => step.name === 'Verify macOS notarization')?.if, "inputs.signed_release && runner.os == 'macOS'");
  const smokeJob = jobs['packaged-smoke'];
  assert.equal(smokeJob.needs, 'package', 'installer smoke should follow the package job');
  assert.doesNotMatch(JSON.stringify(smokeJob.env ?? {}), /\brunner\s*\./, 'GitHub Actions cannot resolve runner context in job-level env');
  const smokeSteps = smokeJob.steps.filter(step => step.run?.includes('node scripts/test-packaged-smoke.mjs'));
  assert.equal(smokeSteps.length, 3, 'packaged smoke must run on X11, Wayland, and macOS/Windows');
  for (const display of ['x11', 'wayland']) {
    assert.equal(smokeSteps.find(step => step.if === `matrix.display == '${display}'`)?.env?.XDG_SESSION_TYPE, display, `Electron must select the ${display} compositor explicitly`);
  }
  const restoreIndex = smokeJob.steps.findIndex(step => step.run?.includes('tar -xf'));
  assert.ok(restoreIndex >= 0 && restoreIndex < smokeJob.steps.indexOf(smokeSteps[0]), 'packaged smoke must unpack the tar before launching the executable');
  const manifestSteps = jobs['release-artifact'].steps;
  assert.deepEqual(jobs['release-artifact'].needs, ['package', 'packaged-smoke']);
  assert.ok(!manifestSteps.some(step => step.run === 'npm ci'), 'the checksum manifest job only needs Node built-ins');
  const extractManifestIndex = manifestSteps.findIndex(step => step.run?.includes('tar -xf'));
  assert.ok(extractManifestIndex >= 0 && extractManifestIndex < manifestSteps.findIndex(step => step.run?.includes('verify-release-artifacts.mjs')), 'release manifest must hash the extracted installers');
  for (const step of smokeSteps) {
    assert.equal(step.env?.MUSTER_PACKAGED_PROFILE_DIR, '${{ runner.temp }}/muster-packaged-smoke-${{ matrix.name }}', step.name);
  }
  assert.match(workflow, /verify-release-signing-env\.mjs --prepare/, 'protected release package must fail closed before unsigned signing');
  assert.match(workflow, /WIN_CSC_LINK: \$\{\{ secrets\.WIN_CSC_LINK \}\}/, 'Windows signing secret must be injected only through Actions secrets');
  assert.match(workflow, /APPLE_APP_SPECIFIC_PASSWORD: \$\{\{ secrets\.APPLE_APP_SPECIFIC_PASSWORD \}\}/, 'macOS notarization secret must be injected only through Actions secrets');
}

// Packaged smoke must be able to isolate userData from an installed instance.
// The override is test-marker gated so a normal packaged launch still owns the
// canonical product directory and single-instance lock.
{
  const productStorage = fs.readFileSync(path.join(root, 'src', 'main', 'productStorage.ts'), 'utf8');
  assert.match(productStorage, /MUSTER_PACKAGED_SMOKE === '1'/, 'packaged userData override must be smoke-only');
  assert.match(productStorage, /MUSTER_PACKAGED_USER_DATA/, 'packaged smoke must provide an isolated userData path');
  assert.match(productStorage, /path\.resolve\(smokeUserData\)/, 'smoke userData must be normalized before app.setPath');
  const smoke = fs.readFileSync(path.join(root, 'scripts', 'test-packaged-smoke.mjs'), 'utf8');
  assert.match(smoke, /MUSTER_PACKAGED_USER_DATA: profile/, 'smoke runner must pass its temporary profile to the packaged app');
  assert.match(smoke, /MUSTER_PACKAGED_PROFILE_DIR/, 'packaged smoke must support a runner-owned diagnostic profile');
  assert.match(smoke, /MUSTER_PACKAGED_KEEP_PROFILE/, 'packaged smoke must preserve the profile after a failed run');
  assert.match(smoke, /\.app\$\{path\.sep\}Contents\$\{path\.sep\}MacOS/, 'macOS smoke must locate the executable inside the app bundle');
}

console.log('packaging-file-filters ok (files 排除 + 平台 files 禁区 + electronLanguages + extraResources 技能真源 + @esbuild 裁剪规划 + 依赖裁剪 + node-pty darwin 执行位 + helperPath 补丁 + 国内镜像在位)');
