/**
 * electron-builder beforePack 钩子：依赖收集前剔除非目标平台的 @esbuild 预编译二进制。
 *
 * 为什么有这么多平台二进制：`esbuild` 是 `@earendil-works/chord`（pi-coding-agent 闭包内）的真实
 * 运行时依赖，不能整包排除；它把 26 个平台包全列进 optionalDependencies，而 pi-coding-agent 自带
 * npm-shrinkwrap.json 会把它们全装进嵌套 node_modules（绕过了 npm 的 os/cpu 过滤），traversal
 * 收集器再把嵌套包提升到顶层，于是 android / darwin / linux / aix / sunos …… 全套都进了安装包。
 * 0.1.22 实测：非 win32-x64 的 25 个包共 271MB，占解包树 36%。
 *
 * 为什么不用 electron-builder 的 files 排除：按包名排除只能写成平台专属的
 * `win.files: ['!node_modules/@esbuild/!(win32-x64)/**']`，但**平台专属 files 会让顶层 files 的
 * 正向模式在主匹配器里失效**，electron-builder 随即判定「只有排除模式」并自动补 `**\/*`，把整个
 * 仓库根目录（refs/、.dev-sandbox/、.tmp/）扫进 asar——2026-09-15 实测 Setup.exe 266MB→1061MB。
 * 详见 electron-builder.yml 末尾「排除模式合同」。故改在收集前把目录移走，不碰 files 语义。
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforePack as verifyDesktopDriver } from './desktop-driver/build.mjs';

/** builder-util 的 Arch 枚举顺序 → esbuild 平台包后缀 */
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];

/**
 * 目标平台要保留的 @esbuild 子目录名。
 * mac 无论目标架构一律保留 darwin 两个架构：electron-builder.yml 的 mac target 是
 * [x64, arm64] 双架构**一次运行连打**，而本钩子的裁剪是破坏性的（直接删 node_modules），
 * 若按 arch 只留一个，第一架构的 pass 会删掉第二架构 pass 需要的目录（2026-10-07
 * 首次 mac 构建实测：x64 dmg 里 @esbuild 整体缺失、esbuild 运行时必挂）。
 * @param {string} platform electronPlatformName：win32 | darwin | linux
 * @param {number|string} arch builder-util 的 Arch 枚举值（或直接给名字）
 * @returns {string[]}
 */
export function keepDirsFor(platform, arch) {
  const archName = typeof arch === 'number' ? ARCH_NAMES[arch] : String(arch);
  if (platform === 'darwin') {
    return ['darwin-x64', 'darwin-arm64'];
  }
  return [`${platform}-${archName}`];
}

/**
 * 找出所有 @esbuild 目录（含嵌套 node_modules），规划要删除的平台子目录。
 * 只读不删，便于测试。
 * @param {string} nodeModulesDir 根 node_modules 绝对路径
 * @param {string[]} keep 要保留的子目录名
 * @returns {{ remove: string[], missingKeep: string[] }}
 */
export function planEsbuildPrune(nodeModulesDir, keep) {
  const remove = [];
  const missingKeep = [];
  const keepSet = new Set(keep);

  /** @param {string} dir 一个 node_modules 目录 */
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === '@esbuild') {
        let hasKeep = false;
        for (const child of fs.readdirSync(full, { withFileTypes: true })) {
          if (!child.isDirectory()) continue;
          if (keepSet.has(child.name)) hasKeep = true;
          else remove.push(path.join(full, child.name));
        }
        if (!hasKeep) missingKeep.push(full);
        continue;
      }
      // scope 目录（@foo/）要下钻一层；普通包只看它自己的嵌套 node_modules
      if (entry.name.startsWith('@')) walk(full);
      else {
        const nested = path.join(full, 'node_modules');
        if (fs.existsSync(nested)) walk(nested);
      }
    }
  };

  walk(nodeModulesDir);
  return { remove, missingKeep };
}

/** @param {number} bytes */
function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 裁剪执行器：删除清单里的路径并返回总字节数。
 * 清单可混合目录和文件。导出仅为可测。
 * @param {string[]} paths
 * @returns {number} 删除的总字节数
 */
export function removePruneTargets(paths) {
  let total = 0;
  for (const p of paths) {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue; // 已被并发删除/不存在，按 force 语义跳过
    }
    if (st.isDirectory()) total += dirSize(p);
    else total += st.size;
    fs.rmSync(p, { recursive: true, force: true });
  }
  return total;
}

/** @param {string} dir */
function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

/** @param {{ packager: { projectDir: string }, electronPlatformName: string, arch: number }} context */
export default async function beforePack(context) {
  // Check before the existing pruning hook mutates node_modules.
  await verifyDesktopDriver(context);
  const repoRoot = context.packager.projectDir;
  const nodeModulesDir = path.join(repoRoot, 'node_modules');
  const keep = keepDirsFor(context.electronPlatformName, context.arch);
  const { remove, missingKeep } = planEsbuildPrune(nodeModulesDir, keep);

  for (const dir of missingKeep) {
    // 异常上报：宿主平台二进制缺失意味着 esbuild 运行时会崩，不能静默放过
    console.warn(
      `[before-pack] 警告：${path.relative(repoRoot, dir)} 下没有 ${keep.join(' / ')}，` +
        'esbuild 运行时将无法加载，请检查 npm install 是否完整'
    );
  }

  if (remove.length > 0) {
    const bytes = removePruneTargets(remove);
    console.log(
      `[before-pack] 已剔除 ${remove.length} 个非目标平台 @esbuild 包（${mb(bytes)}），` +
        `保留 ${keep.join(' / ')}；需要恢复就跑 npm install`
    );
  } else {
    console.log(`[before-pack] @esbuild 无需裁剪（已只有 ${keep.join(' / ')}）`);
  }

  // ── mac：node-pty prebuilds 的 spawn-helper 补执行位 ──
  if (context.electronPlatformName === 'darwin') {
    const changed = ensureDarwinPtyPrebuildExecBits(nodeModulesDir);
    if (changed.length > 0) {
      console.log(
        `[before-pack] 已为 ${changed.length} 个 node-pty prebuilds 的 spawn-helper 补执行位` +
          '（npm 装出来是 644，无 +x 时 posix_spawnp 直接失败）'
      );
    }
  }

  // ── node-pty helperPath 双重 unpack 补丁（全平台；unix 侧 bug，win 的 conpty 不走这段）──
  patchNodePtyHelperPath(nodeModulesDir);
}

/**
 * node-pty 1.1.0 的 unixTerminal.js 在模块加载时做
 * `helperPath.replace('app.asar', 'app.asar.unpacked')`——它假设自己住在 app.asar 里、
 * 运行时映射到解包孪生路径。但本仓把 node_modules 整树 asarUnpack，node-pty
 * 从 require 起就解析在真实的 `.../app.asar.unpacked/node_modules/...` 路径上，这行 replace
 * 把它二次拼接成 `app.asar.unpacked.unpacked/...`，spawn-helper ENOENT → 终端创建即
 * "posix_spawnp failed."（2026-10-07 首次 mac 出包实测；仓库 dev 路径不含 app.asar 子串
 * 所以 dev 永远复现不了，只有打包版中招）。
 *
 * 修法：把两行 replace 的匹配锚到路径分隔符（`'app.asar' + path.sep`）：asar 内路径
 * `.../app.asar/node_modules/...` 仍正确映射一次；已解包路径 `.../app.asar.unpacked/...`
 * 不含 `app.asar/` 子串、不再被碰（幂等）。node_modules.asar 同理。
 * 精确匹配 1.1.0 源码行；node-pty 升级后模式漂移时打 warn 不静默（按异常上报原则），
 * 需要人工核对新版路径处理。
 * @param {string} nodeModulesDir 根 node_modules 绝对路径
 * @returns {boolean} 本次是否改写了文件（已打过补丁/模式未命中返回 false）
 */
export function patchNodePtyHelperPath(nodeModulesDir) {
  const file = path.join(nodeModulesDir, 'node-pty', 'lib', 'unixTerminal.js');
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch {
    console.warn('[before-pack] 警告：node-pty/lib/unixTerminal.js 不存在，跳过 helperPath 补丁');
    return false;
  }
  const original =
    "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');\n" +
    "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');";
  const patched =
    "helperPath = helperPath.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);\n" +
    "helperPath = helperPath.replace('node_modules.asar' + path.sep, 'node_modules.asar.unpacked' + path.sep);";
  if (src.includes(patched)) return false; // 已打过补丁（重复构建），幂等
  if (!src.includes(original)) {
    console.warn(
      '[before-pack] 警告：node-pty unixTerminal.js 的 helperPath replace 模式未命中（版本升级过？），' +
        '请人工核对新版对 app.asar.unpacked 布局的路径处理，否则打包版终端可能创建即失败'
    );
    return false;
  }
  fs.writeFileSync(file, src.replace(original, patched));
  console.log(
    '[before-pack] 已补丁 node-pty helperPath 的双重 unpack 映射' +
      '（整树 asarUnpack 布局下原样 replace 会拼出 app.asar.unpacked.unpacked）'
  );
  return true;
}

/**
 * mac 包里 node-pty 的回退加载路径（2026-10-07 首次 mac 构建实测）：
 * `npm run rebuild` 只能产出宿主架构（如 arm64）的 build/Release 产物，另一架构 dmg 的
 * pty.node 由 lib/utils.js 回退到 `prebuilds/darwin-<arch>/`（N-API，实测 Electron 43 可加载）。
 * 但 npm 装出来的 prebuilds 各 darwin 架构目录里的 spawn-helper 是 644，node-pty 的 unixTerminal 用
 * posix_spawnp 拉它，无执行位时终端创建必失败（"posix_spawnp failed."）；
 * build/Release 那份由 node-gyp 安装自带 +x。这里给 darwin prebuilds 的 spawn-helper 补
 * 执行位。幂等；返回实际修改过的文件列表（测试据此刻断行为）。
 * @param {string} nodeModulesDir 根 node_modules 绝对路径
 * @returns {string[]}
 */
export function ensureDarwinPtyPrebuildExecBits(nodeModulesDir) {
  const changed = [];
  const prebuilds = path.join(nodeModulesDir, 'node-pty', 'prebuilds');
  let archDirs;
  try {
    archDirs = fs.readdirSync(prebuilds, { withFileTypes: true });
  } catch {
    return changed; // node-pty 不在包里（理论上不可能），静默跳过
  }
  for (const d of archDirs) {
    if (!d.isDirectory() || !d.name.startsWith('darwin-')) continue;
    const helper = path.join(prebuilds, d.name, 'spawn-helper');
    try {
      const st = fs.statSync(helper);
      if ((st.mode & 0o111) === 0) {
        fs.chmodSync(helper, st.mode | 0o111);
        changed.push(helper);
      }
    } catch {
      // 单个文件缺失不阻断打包：对应架构 prebuild 不存在时本就无回退可言
    }
  }
  return changed;
}
