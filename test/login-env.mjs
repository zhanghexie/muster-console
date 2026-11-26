/**
 * 登录 shell 环境快照（macOS/Linux GUI PATH 修复）纯函数自测。
 * 运行: node test/login-env.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'login-env-'));
const compile = createSharedCompiler(root, tmp);
const moduleUrl = pathToFileURL(compile('main/shell/loginEnv.ts')).href;
const mod = await import(moduleUrl);

// POSIX 下 path.delimiter 是 ':'，Windows 测试机是 ';'——用当前平台的分隔符构造
const D = path.delimiter;

// ---- mergePathEntries：登录 PATH 独有目录前置、去重保序 ----
{
  const cur = ['/usr/bin', '/bin'].join(D);
  const login = ['/opt/homebrew/bin', '/usr/bin', `${os.homedir()}/.npm-global/bin`].join(D);
  const merged = mod.mergePathEntries(cur, login).split(D);
  assert.deepEqual(merged, ['/opt/homebrew/bin', `${os.homedir()}/.npm-global/bin`, '/usr/bin', '/bin']);
  console.log('ok: mergePathEntries prepends unique login dirs');
}

{
  assert.equal(mod.mergePathEntries('', `/a${D}/b`), `/a${D}/b`, '空当前 PATH 直通');
  assert.equal(mod.mergePathEntries(`/a`, ''), `/a`, '空登录 PATH 不变');
  console.log('ok: mergePathEntries empty inputs');
}

// ---- extractPathFromOutput：噪音行剔除、fish 空格列表归一 ----
{
  const out = [`Last login: …`, `/opt/homebrew/bin${D}/usr/bin${D}/bin`].join('\n');
  assert.equal(mod.extractPathFromOutput(out), `/opt/homebrew/bin${D}/usr/bin${D}/bin`);
  // fish：PATH 是空格分隔的列表
  assert.equal(
    mod.extractPathFromOutput(`/opt/homebrew/bin /usr/local/bin /usr/bin`),
    [`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`].join(D)
  );
  // 单词行（既无分隔符也不像列表）拒绝；多词行按 fish 列表归一是刻意行为
  assert.equal(mod.extractPathFromOutput('nope'), null);
  assert.equal(mod.extractPathFromOutput(''), null);
  console.log('ok: extractPathFromOutput noise/last-line/fish');
}

// A missing login shell still allows inherited commands. Windows does not probe it.
for (const platform of ['darwin', 'linux', 'win32']) {
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const [url, platform] = process.argv.slice(1);
    const before = process.env.PATH;
    Object.defineProperty(process, 'platform', { value: platform });
    const { captureDemoLoginShellPath, prepareWorkbenchLoginShellPath } = await import(url);
    const warnings = [];
    console.warn = message => warnings.push(message);
    captureDemoLoginShellPath();
    await prepareWorkbenchLoginShellPath();
    assert.equal(process.env.PATH, before);
    if (platform === 'win32') assert.equal(warnings.length, 0);
    else { assert.equal(warnings.length, 1); assert.match(warnings[0], /PATH/); }
  `, moduleUrl, platform], { env: { ...process.env, SHELL: path.join(tmp, 'missing-login-shell') } });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('login-env: all passed');
