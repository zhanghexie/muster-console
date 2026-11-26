/**
 * runtime 可用性预检：纯逻辑层（shared/runtimePreflight.ts）。
 * 运行: node test/runtime-preflight.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-preflight-'));
const compile = createSharedCompiler(root, tmp);
const {
  findOnPath,
  extractCliToken,
  classifyPtyPreflight,
  describePreflightFailure,
  preflightBadgeOf,
  cliInstallHint,
  RuntimePreflightError
} = await import(pathToFileURL(compile('shared/runtimePreflight.ts')).href);

// ---------- findOnPath ----------

// 命中：win32 无扩展名按 PATHEXT 补齐
const fakeBin = path.join(tmp, 'tools');
fs.mkdirSync(fakeBin, { recursive: true });
const geminiCmd = path.join(fakeBin, 'gemini.cmd');
fs.writeFileSync(geminiCmd, '');
const found = findOnPath(['gemini'], {
  platform: 'win32',
  pathEnv: `C:\\other;${fakeBin}`,
  pathExt: '.COM;.EXE;.BAT;.CMD',
  exists: (p) => fs.existsSync(p),
  join: path.join
});
assert.ok(
  found != null && found.toLowerCase() === geminiCmd.toLowerCase(),
  'win32 PATHEXT 命中 .cmd'
);

// P1-4：PATH 目录名含点（C:Usersjohn.smith...、版本号目录）时，裸名仍须按
// PATHEXT 补齐——旧实现对拼好的全路径判 includes('.')，漏试 claude.cmd 误报未安装
const dottedBin = path.join(tmp, 'v1.2.3', 'bin');
fs.mkdirSync(dottedBin, { recursive: true });
const claudeCmd = path.join(dottedBin, 'claude.cmd');
fs.writeFileSync(claudeCmd, '');
const foundDotted = findOnPath(['claude'], {
  platform: 'win32',
  pathEnv: `C:\\other;${dottedBin}`,
  pathExt: '.COM;.EXE;.BAT;.CMD',
  exists: (p2) => fs.existsSync(p2),
  join: path.join
});
assert.ok(
  foundDotted != null && foundDotted.toLowerCase() === claudeCmd.toLowerCase(),
  'P1-4：目录名含点不阻断 PATHEXT 探测'
);

// 命中：posix 直接拼（注入 exists，不依赖真实文件系统分隔符）
const posixExpected = ['/usr/bin', String(fakeBin)].length; // 哨兵，防误改
assert.ok(posixExpected > 0);
assert.equal(
  findOnPath(['opencode'], {
    platform: 'linux',
    pathEnv: '/usr/bin:/opt/tools',
    exists: (p) => p === '/opt/tools/opencode',
    join: (...p) => p.join('/')
  }),
  '/opt/tools/opencode',
  'posix PATH 命中'
);

// 未命中 → null
assert.equal(
  findOnPath(['definitely-missing-cli'], {
    platform: 'linux',
    pathEnv: '/usr/bin',
    exists: () => false,
    join: path.join
  }),
  null,
  '未命中返回 null'
);

// ---------- extractCliToken ----------

assert.equal(
  extractCliToken({
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'chcp 65001>nul & gemini --resume x']
  }),
  'gemini',
  'win cmd.exe 包装剥出真实 CLI'
);
assert.equal(
  extractCliToken({ command: 'codex', args: ['resume', 'abc'] }),
  'codex',
  'posix 直接取 command'
);
assert.equal(
  extractCliToken({
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'chcp 65001>nul & "C:\\Program Files\\x\\cli.exe" --run']
  }),
  'C:\\Program Files\\x\\cli.exe',
  '带引号的绝对路径去引号'
);

// ---------- classifyPtyPreflight ----------

assert.deepEqual(
  classifyPtyPreflight({ enabled: false, scriptExists: true, cliFound: true }).status,
  'disabled'
);
assert.equal(
  classifyPtyPreflight({ enabled: true, scriptExists: false }).status,
  'script_missing'
);
assert.deepEqual(
  classifyPtyPreflight({
    enabled: true,
    scriptExists: true,
    moduleError: 'SyntaxError'
  }).status,
  'unknown'
);
const missing = classifyPtyPreflight({
  enabled: true,
  scriptExists: true,
  cliFound: false,
  installHint: { installCmd: 'npm install -g @google/gemini-cli' }
});
assert.equal(missing.status, 'not_installed');
assert.equal(missing.problems[0].code, 'cli_missing');
assert.equal(missing.problems[0].fix, 'npm install -g @google/gemini-cli');
assert.equal(
  classifyPtyPreflight({ enabled: true, scriptExists: true, cliFound: true }).status,
  'available'
);
assert.equal(
  classifyPtyPreflight({ enabled: true, scriptExists: true }).status,
  'unknown',
  'cliFound 未定义=未知'
);

// ---------- describePreflightFailure ----------

const failMsg = describePreflightFailure({
  id: 'gemini',
  label: 'Gemini',
  surface: 'pty',
  status: 'not_installed',
  ok: false,
  problems: [
    {
      code: 'cli_missing',
      message: '依赖的 CLI 未安装或不在 PATH 中',
      fix: 'npm install -g @google/gemini-cli'
    }
  ],
  checkedAt: 0
});
assert.match(failMsg, /Gemini.*不可用/);
assert.match(failMsg, /npm install -g @google\/gemini-cli/, '报错带安装命令');
assert.match(failMsg, /force:true/, '报错保留强创逃生门提示');

// RuntimePreflightError：instanceof 合同（创建闸门据此区分拒绝 vs 预检自身异常）
const err = new RuntimePreflightError({
  id: 'codex',
  label: 'Codex',
  surface: 'pty',
  status: 'not_installed',
  ok: false,
  problems: [{ code: 'cli_missing', message: 'x', fix: 'npm install -g @openai/codex' }],
  checkedAt: 0
});
assert.ok(err instanceof Error);
assert.ok(err instanceof RuntimePreflightError);
assert.equal(err.preflight.id, 'codex');
assert.match(err.message, /Codex/);

// ---------- preflightBadgeOf ----------

assert.deepEqual(preflightBadgeOf(undefined), { cls: 'off', label: '未知' });
assert.equal(preflightBadgeOf({ status: 'available' }).cls, 'on');
assert.equal(preflightBadgeOf({ status: 'not_installed' }).cls, 'warn');
assert.equal(preflightBadgeOf({ status: 'not_configured' }).cls, 'warn');
assert.equal(preflightBadgeOf({ status: 'script_missing' }).cls, 'warn');
assert.equal(preflightBadgeOf({ status: 'disabled' }).cls, 'off');
assert.equal(preflightBadgeOf({ status: 'garbage' }).cls, 'off', '非法状态按未知');

// ---------- cliInstallHint ----------

assert.equal(cliInstallHint('gemini').installCmd, 'npm install -g @google/gemini-cli');
assert.equal(cliInstallHint('codex-gui').installCmd, 'npm install -g @openai/codex');
assert.deepEqual(cliInstallHint('acp').cli, ['opencode', 'gemini']);
assert.deepEqual(cliInstallHint('unknown-rt').installCmd, '', '未知 runtime 无安装提示');

console.log('runtime-preflight: ok');
