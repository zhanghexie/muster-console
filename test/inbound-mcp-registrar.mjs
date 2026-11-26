/**
 * T5.4：registrar 合并写入，不覆盖其它 mcpServers。
 * 运行: node test/inbound-mcp-registrar.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInboundCompiler } from './helpers/inbound-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-mcp-reg-'));
const compile = createInboundCompiler(root, tmp);
const { writeInboundMcpEngineConfigs, previewInboundMcpInstall, defaultInboundMcpEngineFiles } =
  await import(pathToFileURL(compile('main/inboundMcp/registrar.ts')).href);

const home = path.join(tmp, 'home');
fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
fs.writeFileSync(
  path.join(home, '.claude.json'),
  JSON.stringify({ numStartups: 3, mcpServers: { keep: { command: 'npx' } } }),
  'utf8'
);

const files = defaultInboundMcpEngineFiles(home);
const launch = { command: 'C:\\muster.exe', args: [path.join(tmp, 'stdioEntry.mjs')] };
const preview = previewInboundMcpInstall(launch, files);
assert.equal(preview.files.find((f) => f.id === 'claude').action, 'update');
assert.equal(preview.files.find((f) => f.id === 'cursor').action, 'create');

writeInboundMcpEngineConfigs(launch, files);
const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
assert.equal(claude.numStartups, 3);
assert.equal(claude.mcpServers.keep.command, 'npx');
assert.equal(claude.mcpServers.muster.command, launch.command);
assert.deepEqual(claude.mcpServers.muster.args, launch.args);

const cursor = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
assert.equal(cursor.mcpServers.muster.command, launch.command);

// 回归：已存在但 JSON 解析失败的引擎配置必须中止安装，而不是整文件覆盖成只剩 mcpServers
const geminiPath = path.join(home, '.gemini', 'settings.json');
fs.mkdirSync(path.dirname(geminiPath), { recursive: true });
const corruptedOriginal = '{ "theme": "dark", // 手工注释导致解析失败\n';
fs.writeFileSync(geminiPath, corruptedOriginal, 'utf8');
assert.throws(
  () => writeInboundMcpEngineConfigs(launch, files),
  /无法解析|中止/
);
assert.equal(
  fs.readFileSync(geminiPath, 'utf8'),
  corruptedOriginal,
  '损坏文件必须原样保留'
);

// 回归：损坏文件不在首位时不得半写——排在前面的引擎一个都不能被改动
// （曾按「解析一个写一个」推进，损坏项在后面时前面的已落盘）
const claudeBefore = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
const claudeFiles = files.map((f) =>
  f.id === 'gemini' ? { ...f, path: path.join(home, '.broken', 'settings.json') } : f
);
fs.mkdirSync(path.dirname(claudeFiles.find((f) => f.id === 'gemini').path), { recursive: true });
fs.writeFileSync(claudeFiles.find((f) => f.id === 'gemini').path, corruptedOriginal, 'utf8');
assert.throws(() => writeInboundMcpEngineConfigs(launch, claudeFiles), /无法解析|中止/);
assert.equal(
  fs.readFileSync(path.join(home, '.claude.json'), 'utf8'),
  claudeBefore,
  '损坏文件在后时，前面的引擎配置不得已被改写'
);

// B3 regression: the registrar only ever writes the muster entry. User-authored
// third-party engine config (other top-level keys, other mcpServers entries, even a
// stale self entry) must survive installs untouched, across all three engines.
const home2 = path.join(tmp, 'home2');
fs.mkdirSync(path.join(home2, '.cursor'), { recursive: true });
fs.mkdirSync(path.join(home2, '.gemini'), { recursive: true });

const thirdPartyStdio = {
  command: 'npx',
  args: ['-y', 'some-third-party-mcp'],
  env: { API_KEY: 'secret' }
};
const thirdPartyHttp = {
  type: 'http',
  url: 'https://mcp.example.com/sse',
  headers: { Authorization: 'Bearer token' }
};
const seeded = {
  claude: {
    numStartups: 7,
    projects: { '/work': { allowedTools: ['Bash'] } },
    mcpServers: {
      thirdparty: thirdPartyStdio,
      // Stale self entry: registrar owns this key and must replace it wholesale.
      muster: { command: 'stale-self', args: ['old.mjs'], cwd: '/gone' }
    }
  },
  cursor: { schemaVersion: 1, mcpServers: { remote: thirdPartyHttp } },
  gemini: { theme: 'dark', mcpServers: { remote: thirdPartyHttp, local: thirdPartyStdio } }
};
fs.writeFileSync(path.join(home2, '.claude.json'), JSON.stringify(seeded.claude, null, 2), 'utf8');
fs.writeFileSync(path.join(home2, '.cursor', 'mcp.json'), JSON.stringify(seeded.cursor, null, 2), 'utf8');
fs.writeFileSync(path.join(home2, '.gemini', 'settings.json'), JSON.stringify(seeded.gemini, null, 2), 'utf8');

const files2 = defaultInboundMcpEngineFiles(home2);
const launch2 = {
  command: 'C:\\muster.exe',
  args: [path.join(tmp, 'stdioEntry.mjs')],
  env: { ELECTRON_RUN_AS_NODE: '1' }
};

// TOFU review scope: exposes only the self entry launch identity and target
// files — never third-party entries.
const preview2 = previewInboundMcpInstall(launch2, files2);
assert.equal(preview2.command, launch2.command);
assert.deepEqual(preview2.args, launch2.args);
assert.ok(preview2.files.every((f) => f.action === 'update'));
assert.deepEqual(
  Object.keys(preview2).sort(),
  ['args', 'command', 'files', 'fingerprint'],
  'TOFU review must expose only the self entry and target files'
);

// Install twice: the upsert must be idempotent, never accumulate entries and
// never add masking keys (enabled:false / disabled) to anything.
writeInboundMcpEngineConfigs(launch2, files2);
writeInboundMcpEngineConfigs(launch2, files2);

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const expectThirdPartyUntouched = (after, before, engine) => {
  const beforeServers = before.mcpServers ?? {};
  const afterServers = after.mcpServers ?? {};
  assert.deepEqual(
    Object.keys(afterServers).sort(),
    [...new Set([...Object.keys(beforeServers), 'muster'])].sort(),
    `${engine}: mcpServers key set must change by exactly {muster}`
  );
  for (const [name, entry] of Object.entries(beforeServers)) {
    if (name === 'muster') continue;
    assert.deepEqual(
      afterServers[name],
      entry,
      `${engine}: third-party entry "${name}" must stay untouched (no rewrite, no disable flags)`
    );
  }
  for (const [key, value] of Object.entries(before)) {
    if (key === 'mcpServers') continue;
    assert.deepEqual(after[key], value, `${engine}: top-level key "${key}" must stay untouched`);
  }
};
expectThirdPartyUntouched(readJson(path.join(home2, '.claude.json')), seeded.claude, 'claude');
expectThirdPartyUntouched(readJson(path.join(home2, '.cursor', 'mcp.json')), seeded.cursor, 'cursor');
expectThirdPartyUntouched(readJson(path.join(home2, '.gemini', 'settings.json')), seeded.gemini, 'gemini');

// The self entry is fully owned by the registrar: exactly the launch identity,
// stale extra fields dropped, and never disabled.
const claude2 = readJson(path.join(home2, '.claude.json'));
assert.deepEqual(claude2.mcpServers.muster, {
  command: launch2.command,
  args: launch2.args,
  env: launch2.env
});
const cursor2 = readJson(path.join(home2, '.cursor', 'mcp.json'));
assert.equal(cursor2.mcpServers.muster.enabled, undefined, 'registrar must not mask entries with enabled flags');
assert.equal(cursor2.mcpServers.muster.disabled, undefined);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('inbound-mcp-registrar: ok');
