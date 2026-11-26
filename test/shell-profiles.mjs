/**
 * Shell 配置档探测单测。
 * 运行: node test/shell-profiles.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-profiles-'));
// profiles.ts 现 import shared/i18n（i18next）与 shared/types：用带目录解析与
// i18next shim 的 shared-compile 按依赖树转译，isShellProfileId/winUtf8 用真实现
const compile = createSharedCompiler(root, tmp);
const outFile = compile('main/shell/profiles.ts');
const mod = await import(pathToFileURL(outFile).href);

const env = {
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  PATH: ''
};

function norm(p) {
  return path.normalize(p);
}

{
  const files = new Set([
    norm(path.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')),
    norm(path.join(env.SystemRoot, 'System32', 'cmd.exe'))
  ]);
  const list = mod.listShellProfiles({
    exists: (p) => files.has(norm(p)),
    which: () => null,
    hasWslDistro: () => false,
    env,
    platform: 'win32'
  });
  assert.deepEqual(
    list.map((p) => p.id),
    ['powershell', 'cmd']
  );
  console.log('ok: only powershell+cmd when others missing');
}

{
  const files = new Set([
    norm(path.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')),
    norm(path.join(env.SystemRoot, 'System32', 'cmd.exe')),
    norm(path.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe')),
    norm(path.join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe')),
    norm(path.join(env.SystemRoot, 'System32', 'wsl.exe'))
  ]);
  const deps = {
    exists: (p) => files.has(norm(p)),
    which: () => null,
    hasWslDistro: () => true,
    env,
    platform: 'win32'
  };
  const list = mod.listShellProfiles(deps);
  assert.deepEqual(
    list.map((p) => p.id),
    ['powershell', 'pwsh', 'cmd', 'git-bash', 'wsl']
  );
  const launch = mod.resolveShellLaunch('cmd', deps);
  assert.equal(launch.command, path.join(env.SystemRoot, 'System32', 'cmd.exe'));
  assert.deepEqual(launch.args, ['/d', '/k', 'chcp 65001>nul']);
  const ps = list.find((p) => p.id === 'powershell');
  assert.ok(ps);
  assert.equal(ps.args[0], '-NoLogo');
  assert.ok(ps.args.includes('-Command'));
  assert.throws(() => mod.resolveShellLaunch('nope', deps));
  console.log('ok: all five profiles when present');
}

{
  const files = new Set([norm(path.join(env.SystemRoot, 'System32', 'wsl.exe'))]);
  const list = mod.listShellProfiles({
    exists: (p) => files.has(norm(p)),
    which: () => null,
    hasWslDistro: () => false,
    env,
    platform: 'win32'
  });
  assert.ok(!list.some((p) => p.id === 'wsl'));
  console.log('ok: wsl skipped without distro');
}

// ---- POSIX：注入 platform 走 zsh/bash 分支（在 Windows 上也能测） ----
{
  const files = new Set(['/bin/zsh', '/bin/bash']);
  const list = mod.listShellProfiles({
    exists: (p) => files.has(p),
    which: () => null,
    hasWslDistro: () => false,
    env: { PATH: '' },
    platform: 'darwin'
  });
  // zsh/bash 排最前（后台 shell 任务取 profiles[0]，默认应为系统 shell）
  assert.deepEqual(list.map((p) => p.id), ['zsh', 'bash']);
  const zsh = list[0];
  assert.equal(zsh.command, '/bin/zsh');
  assert.deepEqual(zsh.args, ['-l']);
  console.log('ok: POSIX profiles (zsh first) via injected platform');
}

{
  // $SHELL 优先于标准路径
  const files = new Set(['/opt/homebrew/bin/zsh', '/bin/zsh']);
  const list = mod.listShellProfiles({
    exists: (p) => files.has(p),
    which: () => null,
    hasWslDistro: () => false,
    env: { PATH: '', SHELL: '/opt/homebrew/bin/zsh' },
    platform: 'darwin'
  });
  assert.equal(list[0].command, '/opt/homebrew/bin/zsh');
  console.log('ok: $SHELL wins for zsh');
}

{
  // POSIX 无 zsh/bash 时列表为空（Windows 五档全部不适用）
  const list = mod.listShellProfiles({
    exists: () => false,
    which: () => null,
    hasWslDistro: () => false,
    env: { PATH: '' },
    platform: 'linux'
  });
  assert.deepEqual(list, []);
  console.log('ok: bare POSIX host yields no Windows profiles');
}

// ---- 手工指定 Git Bash 路径（设置页 Shell 区块，shell-env 三件套 C）----
{
  // 手工值存在 → 优先返回（压过标准位置与 git 兄弟探测）
  const manual = 'D:\\Git\\bin\\bash.exe';
  mod.setManualGitBashPath(manual);
  const files = new Set([norm(manual), norm(path.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'))]);
  const deps = {
    exists: (p) => files.has(norm(p)),
    which: () => null,
    hasWslDistro: () => false,
    env,
    platform: 'win32'
  };
  const hit = mod.detectGitBashPath(deps);
  assert.equal(hit, norm(manual));
  // 手工值会进 listShellProfiles 的 git-bash 配置档
  const list = mod.listShellProfiles(deps);
  const gb = list.find((p) => p.id === 'git-bash');
  assert.ok(gb);
  assert.equal(gb.command, norm(manual));
  console.log('ok: manual Git Bash path wins over auto-detection');
}

{
  // 手工值不存在 → 忽略并回落自动探测
  const auto = norm(path.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'));
  mod.setManualGitBashPath('E:\\uninstalled\\bin\\bash.exe');
  const files = new Set([auto]);
  const deps = {
    exists: (p) => files.has(norm(p)),
    which: () => null,
    hasWslDistro: () => false,
    env,
    platform: 'win32'
  };
  assert.equal(mod.detectGitBashPath(deps), auto);
  console.log('ok: nonexistent manual path falls back to auto-detection');
}

{
  // 清除手工值 → 恢复纯自动；getManualGitBashPath 回环
  mod.setManualGitBashPath('D:\\Git\\bin\\bash.exe');
  assert.equal(mod.getManualGitBashPath(), 'D:\\Git\\bin\\bash.exe');
  mod.setManualGitBashPath('');
  assert.equal(mod.getManualGitBashPath(), null);
  mod.setManualGitBashPath(null);
  assert.equal(mod.getManualGitBashPath(), null);
  console.log('ok: setManualGitBashPath round-trips and clears');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('shell-profiles: all passed');
