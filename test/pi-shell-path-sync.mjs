/**
 * syncPiShellPath 解冻结回归（评审返工②）。
 * 运行: node test/pi-shell-path-sync.mjs
 *
 * 旧实现：settings.json 已有 shellPath 即早退——首次同步后路径永久冻结，
 * Git 挪盘后设置页新手工值永不生效。现契约：
 * - 宿主同步值带 shellPathAuto 标记，探测结果变化时原地覆盖；
 * - 无标记的已有值视为用户手工：活着就尊重；
 * - 死值（卸载/挪盘，existsSync=false）无论是否标记都让位最新探测。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shell-sync-'));
const compile = createSharedCompiler(root, tmp);
// 同一编译树里取 piConfigSync 与 profiles：setManualGitBashPath 控制探测结果，
// 两模块必须共享同一 profiles 模块实例（缓存/手工值才互通）
const syncFile = compile('main/agent/piConfigSync.ts');
const nativeSync = (await import(pathToFileURL(syncFile).href)).syncPiShellPath;
let detected;
let syncPiShellPath = nativeSync;
let setManualGitBashPath = (await import(pathToFileURL(path.join(tmp, 'main', 'shell', 'profiles.mjs')).href)).setManualGitBashPath;
if (process.platform !== 'win32') {
  const source = fs.readFileSync(syncFile, 'utf8');
  const start = source.indexOf('export function syncPiShellPath(dir)');
  const end = source.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start);
  const functionSource = source.slice(start, end).replace('export ', '');
  syncPiShellPath = new Function('process', 'fs', 'path', 'detectGitBashPath', 'writeTextAtomicSync',
    functionSource + '\nreturn syncPiShellPath;')({ platform: 'win32' }, fs, path, () => detected, fs.writeFileSync);
  setManualGitBashPath = value => { detected = value; };
}
const home = path.join(tmp, 'home');
fs.mkdirSync(home, { recursive: true });

/** 造一个「真实存在」的假 bash 可执行文件（sync 只做 existsSync 校验） */
function fakeBash(name) {
  const p = path.join(tmp, name, 'bin', 'bash.exe');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '');
  return p;
}
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf-8'));
  } catch {
    return {};
  }
}

const f1 = fakeBash('git1');
const f2 = fakeBash('git2');

try {
  if (process.platform !== 'win32') {
    nativeSync(home);
    assert.equal(fs.existsSync(path.join(home, 'settings.json')), false);
  }
  // 1) 首次同步：探测结果（经手工值注入）写入 + 宿主同步标记
  setManualGitBashPath(f1);
  syncPiShellPath(home);
  let s = readSettings();
  assert.equal(s.shellPath, f1);
  assert.equal(s.shellPathAuto, true);
  console.log('ok: first sync writes shellPath + host marker');

  // 2) 幂等：重复同步不回退
  syncPiShellPath(home);
  s = readSettings();
  assert.equal(s.shellPath, f1);
  assert.equal(s.shellPathAuto, true);
  console.log('ok: re-sync idempotent');

  // 3) 解冻结回归：Git 挪盘（f1 变死值）+ 新探测 f2 → 覆盖，不再被首次值冻死
  fs.rmSync(f1);
  setManualGitBashPath(f2);
  syncPiShellPath(home);
  s = readSettings();
  assert.equal(s.shellPath, f2, '宿主同步死值必须让位最新探测（冻结回归）');
  assert.equal(s.shellPathAuto, true);
  console.log('ok: host-synced dead value replaced by new detection (unfrozen)');

  // 4) 无标记的活手工值：尊重，不加标记、不改写
  const f3 = fakeBash('git3-manual');
  fs.writeFileSync(
    path.join(home, 'settings.json'),
    JSON.stringify({ shellPath: f3, retry: { enabled: true } })
  );
  setManualGitBashPath(f2); // 探测结果 ≠ 手工值
  syncPiShellPath(home);
  s = readSettings();
  assert.equal(s.shellPath, f3, '用户手工活值必须被尊重');
  assert.equal(s.shellPathAuto, undefined, '不得给手工值打宿主标记');
  assert.equal(s.retry.enabled, true, '不得动用户其余键');
  console.log('ok: live manual value respected without marker');

  // 5) 死手工值（无标记）：让位最新探测并打标记
  fs.rmSync(f3);
  syncPiShellPath(home);
  s = readSettings();
  assert.equal(s.shellPath, f2, '死手工值必须让位最新探测');
  assert.equal(s.shellPathAuto, true);
  console.log('ok: dead manual value replaced + marked');

  console.log('pi-shell-path-sync: all passed');
} finally {
  setManualGitBashPath(null);
  fs.rmSync(tmp, { recursive: true, force: true });
}
