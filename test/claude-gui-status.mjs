/**
 * Claude（GUI）鉴权/配置目录纯函数（T2.4）：
 * - 中转 token → auth=relay 并读 ANTHROPIC_MODEL
 * - 仅凭据文件 → login
 * - 都没有 → none
 * - 隔离目录强制 userData/agents/claude-gui，忽略 env
 * 运行: node test/claude-gui-status.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compile = createSharedCompiler(root, path.join(root, '.tmp', 'claude-gui-status'));
const { pathToFileURL } = await import('node:url');
const mod = await import(pathToFileURL(compile('shared/claudeGui.ts')).href);

const {
  inferClaudeGuiAuth,
  resolveClaudeConfigDir,
  applyClaudeConfigDir,
  isolatedClaudeConfigDir
} = mod;

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
};

check('中转：ANTHROPIC_AUTH_TOKEN → relay + 模型档', () => {
  const r = inferClaudeGuiAuth(
    { env: { ANTHROPIC_AUTH_TOKEN: 'sk-x', ANTHROPIC_MODEL: 'deepseek-v4-flash[1m]' } },
    false
  );
  assert.equal(r.auth, 'relay');
  assert.equal(r.model, 'deepseek-v4-flash[1m]');
});

check('订阅：无 token 但有凭据文件 → login', () => {
  const r = inferClaudeGuiAuth({}, true);
  assert.equal(r.auth, 'login');
  assert.equal(r.model, null);
});

check('未配置：无 token 无凭据 → none', () => {
  const r = inferClaudeGuiAuth(undefined, false);
  assert.equal(r.auth, 'none');
});

check('中转优先于凭据文件', () => {
  const r = inferClaudeGuiAuth({ env: { ANTHROPIC_API_KEY: 'sk' } }, true);
  assert.equal(r.auth, 'relay');
});

check('隔离目录忽略 CLAUDE_CONFIG_DIR env', () => {
  const dir = resolveClaudeConfigDir({
    isolate: true,
    userDataDir: 'U:\\data',
    homedir: 'C:\\Users\\me',
    envConfigDir: 'C:\\other',
    join: path.join
  });
  assert.equal(dir, isolatedClaudeConfigDir('U:\\data', path.join));
  assert.match(dir, /agents[\\/]claude-gui$/);
});

check('共享：尊重 env，否则 ~/.claude', () => {
  const envDir = resolveClaudeConfigDir({
    isolate: false,
    userDataDir: 'U:\\data',
    homedir: 'C:\\Users\\me',
    envConfigDir: 'D:\\custom',
    join: path.join
  });
  assert.equal(envDir, 'D:\\custom');
  const home = resolveClaudeConfigDir({
    isolate: false,
    userDataDir: 'U:\\data',
    homedir: 'C:\\Users\\me',
    join: path.join
  });
  assert.equal(home, path.join('C:\\Users\\me', '.claude'));
});

check('applyClaudeConfigDir 写入 CLAUDE_CONFIG_DIR', () => {
  const out = applyClaudeConfigDir({ FOO: '1' }, '/tmp/x');
  assert.equal(out.FOO, '1');
  assert.equal(out.CLAUDE_CONFIG_DIR, '/tmp/x');
});

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nclaude-gui-status ok');
