/**
 * Pi GUI 会话 shell 环境解析单测（bug 三件套 A/B 回归守卫）。
 * 运行: node test/pi-shell-env.mjs
 *
 * 守卫内容：
 * - resolvePiShellEnv 优先级：piSettings.shellPath 显式 > 隔离目录 settings.json > 宿主探测；
 * - 全部落空时 bashAvailable=false + powershell 引导段（无 bash 兑底不裸抛）；
 * - 非 Windows 平台不做任何干预。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shell-env-'));
const compile = createSharedCompiler(root, tmp);
const outFile = compile('main/agentSession/drivers/pi/shellEnv.ts');
const mod = await import(pathToFileURL(outFile).href);

const agentDir = path.join(tmp, 'agent');
fs.mkdirSync(agentDir, { recursive: true });

{
  // 显式 piSettings.shellPath 最高优先：settings 原样透传
  const env = mod.resolvePiShellEnv({
    piSettings: { shellPath: 'C:\\my\\bash.exe', compaction: { enabled: true } },
    agentDir,
    platform: 'win32',
    detect: () => assert.fail('显式 shellPath 时不应触发探测'),
    readFile: () => assert.fail('显式 shellPath 时不应读隔离目录')
  });
  assert.equal(env.bashAvailable, true);
  assert.equal(env.settings.shellPath, 'C:\\my\\bash.exe');
  assert.equal(env.settings.compaction.enabled, true);
  assert.equal(env.promptNote, undefined);
  console.log('ok: explicit piSettings.shellPath wins');
}

{
  // 隔离目录 settings.json（syncPiShellPath 写入的手工/同步值）次之（exists 注入：路径存在才采信）
  fs.writeFileSync(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({ shellPath: 'D:\\Git\\bin\\bash.exe' })
  );
  const env = mod.resolvePiShellEnv({
    piSettings: {},
    agentDir,
    platform: 'win32',
    detect: () => assert.fail('文件已有 shellPath 时不应触发探测'),
    readFile: (p) => fs.readFileSync(p, 'utf-8'),
    exists: (p) => p === 'D:\\Git\\bin\\bash.exe'
  });
  assert.equal(env.bashAvailable, true);
  assert.equal(env.settings.shellPath, 'D:\\Git\\bin\\bash.exe');
  console.log('ok: isolated settings.json shellPath injected');
}

{
  // 文件档死值（Git 挪盘/卸载，exists=false）→ 不压过最新探测，回落 detect（解冻结，评审返工②）
  fs.writeFileSync(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({ shellPath: 'E:\\gone\\bin\\bash.exe' })
  );
  const env = mod.resolvePiShellEnv({
    agentDir,
    platform: 'win32',
    detect: () => 'D:\\Git\\bin\\bash.exe',
    readFile: (p) => fs.readFileSync(p, 'utf-8'),
    exists: (p) => p === 'D:\\Git\\bin\\bash.exe'
  });
  assert.equal(env.bashAvailable, true);
  assert.equal(env.settings.shellPath, 'D:\\Git\\bin\\bash.exe');
  console.log('ok: dead file shellPath falls back to detect');
}

{
  // 文件档死值 + 探测也落空 → bashAvailable=false + powershell 引导段
  const env = mod.resolvePiShellEnv({
    agentDir,
    platform: 'win32',
    detect: () => null,
    readFile: (p) => fs.readFileSync(p, 'utf-8'),
    exists: () => false
  });
  assert.equal(env.bashAvailable, false);
  assert.ok(env.settings.shellPath === undefined);
  assert.ok(typeof env.promptNote === 'string' && env.promptNote.includes('powershell'));
  console.log('ok: dead file shellPath + no detect yields fallback note');
}

{
  // 文件无 shellPath → 宿主探测结果注入（自定义安装盘场景）
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: true } }));
  const env = mod.resolvePiShellEnv({
    piSettings: undefined,
    agentDir,
    platform: 'win32',
    detect: () => 'E:\\Git\\usr\\bin\\bash.exe',
    readFile: (p) => fs.readFileSync(p, 'utf-8')
  });
  assert.equal(env.bashAvailable, true);
  assert.equal(env.settings.shellPath, 'E:\\Git\\usr\\bin\\bash.exe');
  // 文件里只有 shellPath 会被注入（retry/compaction 等仍走 piSettings 透传，不在本函数职责内）
  assert.equal(env.settings.retry, undefined);
  console.log('ok: detected bash injected into settings');
}

{
  // 全部落空：bashAvailable=false + powershell 引导段（无 bash 兑底）
  fs.rmSync(path.join(agentDir, 'settings.json'), { force: true });
  const env = mod.resolvePiShellEnv({
    agentDir,
    platform: 'win32',
    detect: () => null,
    readFile: () => {
      throw new Error('no file');
    }
  });
  assert.equal(env.bashAvailable, false);
  assert.ok(env.settings.shellPath === undefined);
  assert.ok(typeof env.promptNote === 'string' && env.promptNote.includes('powershell'));
  assert.ok(mod.NO_BASH_PROMPT_NOTE.includes('powershell'));
  console.log('ok: no-bash fallback yields powershell prompt note');
}

{
  // 非 Windows：恒可用，不读文件不探测
  const env = mod.resolvePiShellEnv({
    agentDir,
    platform: 'darwin',
    detect: () => assert.fail('POSIX 不应探测 Git Bash'),
    readFile: () => assert.fail('POSIX 不应读 shellPath')
  });
  assert.equal(env.bashAvailable, true);
  assert.equal(env.promptNote, undefined);
  console.log('ok: POSIX platforms untouched');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('pi-shell-env: all passed');
