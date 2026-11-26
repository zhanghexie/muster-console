/**
 * 宿主工具 MCP shim 启动单源回归（2026-10-01 接入审查 P0-1）：
 * - hostMcpShimSpawn 的 ELECTRON_RUN_AS_NODE 判定必须「非 node 即置位」——打包产物名
 *   MusterConsole.exe 不以 electron 开头，按 basename 前缀判定的旧实现会让安装版 shim 以
 *   GUI 模式启动（dev 的 electron.exe 掩盖了它）；
 * - 源码契约：codex/acp driver 一律经 hostMcpShimSpawn 组装，不得再出现
 *   startsWith('electron') 判定（还原修复即红）。
 * 运行: node test/host-mcp-launch.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, '.tmp', 'host-mcp-launch');
fs.rmSync(tmp, { recursive: true, force: true });
const compile = createSharedCompiler(root, tmp);
const launchOut = compile('main/inboundMcp/launch.ts');
const { hostMcpShimSpawn, inboundMcpLaunch } = await import(pathToFileURL(launchOut).href);

// ── 判定矩阵：非 node 即置位 ──
const withFlag = (execPath) => hostMcpShimSpawn('C:/x/stdioEntry.mjs', { execPath });
assert.equal(
  withFlag('C:\\Apps\\Muster Console\\MusterConsole.exe').env.ELECTRON_RUN_AS_NODE,
  '1',
  '打包 exe 名（非 electron 前缀）必须置位——P0-1 主场景'
);
assert.equal(withFlag('C:\\Apps\\MusterConsole.exe').env.ELECTRON_RUN_AS_NODE, '1', '短 exe 名同样置位');
assert.equal(withFlag('C:\\dev\\electron.exe').env.ELECTRON_RUN_AS_NODE, '1', 'dev electron 置位');
assert.equal('ELECTRON_RUN_AS_NODE' in withFlag(process.execPath), false, '测试进程是 node：不置位');
assert.equal('ELECTRON_RUN_AS_NODE' in withFlag('node'), false, '系统 node 不置位');
assert.equal('ELECTRON_RUN_AS_NODE' in withFlag('node.exe'), false, 'Windows node.exe 不置位');
assert.equal(withFlag('C:\\x\\MusterConsole.exe').command, 'C:\\x\\MusterConsole.exe', 'command=execPath');
assert.deepEqual(withFlag('C:\\x\\MusterConsole.exe').args, ['C:/x/stdioEntry.mjs'], 'args=[script]');
console.log('ok   hostMcpShimSpawn：非 node 即置位（打包 exe 名覆盖）');

// ── 源码契约：单源组装、旧判定不得回归 ──
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
for (const rel of [
  'src/main/agentSession/drivers/codex/hostToolsMcp.ts',
  'src/main/agentSession/drivers/acp/driver.ts'
]) {
  const src = read(rel);
  assert.ok(src.includes('hostMcpShimSpawn'), `${rel} 必须经 hostMcpShimSpawn 组装宿主 MCP`);
  assert.ok(
    !src.includes("startsWith('electron')") && !src.includes('startsWith("electron")'),
    `${rel} 不得再出现 basename electron 前缀判定（P0-1 根因）`
  );
}
const launchSrc = read('src/main/inboundMcp/launch.ts');
assert.ok(launchSrc.includes('hostMcpShimSpawn'), 'launch.ts 提供单源');
// 候选路径不得再构造 .ts 入口（注释里的说明文字不算）
const tsCandidate = /['"][^'"]*stdioEntry\.ts['"]/;
assert.ok(!tsCandidate.test(read('src/main/agentSession/drivers/acp/driver.ts')), 'acp 候选不含 .ts');
assert.ok(!tsCandidate.test(read('src/main/agentSession/drivers/codex/hostToolsMcp.ts')), 'codex 候选不含 .ts');
console.log('ok   源码契约：codex/acp 单源组装、无 electron 前缀判定、无 .ts 候选');

// inboundMcpLaunch 原语义不回归（pty CLI 入站 MCP 用同源判定）
assert.equal(inboundMcpLaunch({ execPath: '/app/MusterConsole.exe', script: 's.mjs' }).env?.ELECTRON_RUN_AS_NODE, '1');
assert.equal(inboundMcpLaunch({ execPath: 'node', script: 's.mjs' }).env, undefined, 'node 无 env');
console.log('host-mcp-launch: 全部通过');
