/**
 * extension 声明能力白名单纯函数回归：成员、下划线形态、Worker 专属与危险工具拒绝。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-tool-allowlist-'));
const compile = createSharedCompiler(root, tmp);
const { EXTENSION_HOST_TOOLS, isExtensionHostTool, WORKER_TOOL_ALLOWLIST, isWorkerAllowedTool } =
  await import(pathToFileURL(compile('main/capabilities/catalog.ts')).href);

const { workerPresetProjectedCatalog } = await import(pathToFileURL(compile('main/capabilities/catalog/projectedCatalog.ts')));
const workerNames = ['gui-full', 'acp-subset', 'pty-allowlist'].flatMap(preset =>
  workerPresetProjectedCatalog(preset, true).map(tool => tool.name));
assert.deepEqual(new Set(EXTENSION_HOST_TOOLS), new Set([...workerNames,
  'host.sessions.select',
  'host.runtimes.run',
  'host.terminal.write',
  'host.tasks.render'
]));
const { getCatalogInfo } = await import(pathToFileURL(compile('main/capabilities/catalog/api.ts')));
const catalog = getCatalogInfo();
assert.ok(workerNames.every(name => catalog.tools.find(tool => tool.name === name)?.extensionVisible));

// 允许：点名与下划线形态（HTTP body 里 name 会做 _ → . 归一）
for (const name of EXTENSION_HOST_TOOLS) {
  assert.equal(isExtensionHostTool(name), true, name);
  assert.equal(isExtensionHostTool(name.replace(/\./g, '_')), true, name);
}

// 只接受公开名，调度专属工具和内部源名不能经扩展调用。
for (const name of [
  'sessions.rename',
  'sessions.setStatus',
  'sessions.delete',
  'sessions.setPinned',
  'sessions.setArchived',
  'sessions.askScheduler',
  'sessions.reply',
  'sessions.integrate',
  'terminal.capture',
  'terminal.open',
  'services.create',
  'ui.notify',
  'app.getConfig',
  'sessions.restartConversation',
  'sessions.list',
  'chat.injectBrief',
  'chat.injectBriefx',
  'sessions.create.extra',
  'host.sessions.delete',
  'host.terminal.capture',
  'host.browser.evaluate',
  'sessions',
  ''
]) {
  assert.equal(isExtensionHostTool(name), false, name);
}

// 与 Worker 白名单解耦：互不混入
for (const name of WORKER_TOOL_ALLOWLIST) {

  assert.equal(isWorkerAllowedTool(name), true, name);
}
for (const name of EXTENSION_HOST_TOOLS) {
  assert.equal(isExtensionHostTool(name), true);
}

// 动态工具（ext.*）不对两个白名单面开放（docs/features/dynamic-tools.md 安全边界：
// 两白名单均为静态列表，天然不含动态项；ext.* 的调度面可达走常驻注册面纳入，
// Worker 面按原文档口径保持 fail-closed/default-deny，不随 Bug B 修复放宽）
for (const name of ['ext.demo.ping', 'ext.ci.deploy', 'ext_demo_ping']) {
  assert.equal(isWorkerAllowedTool(name), false, `PTY/CLI Worker 白名单不含 ${name}`);
  assert.equal(isExtensionHostTool(name), false, `extension hostTools 不含 ${name}`);
}

console.log('[ok] ext-tool allowlist');

// Both installed extension entries keep the authoring guidance after the workspace README is retired.
for (const name of ['extensions', 'muster-extensions']) {
  const guide = fs.readFileSync(path.join(root, 'resources', 'skills', name, 'SKILL.md'), 'utf8');
  assert.match(guide, /host\.extensions\.run/);
  assert.match(guide, /DomainRuntime/);
  if (name === 'muster-extensions') {
    assert.match(guide, /terminal\.create/);
    assert.match(guide, /terminal\.write/);
  }
  assert.doesNotMatch(guide, /\/v1\/ext-tool|\.muster\/extensions\/README\.md/);
  assert.doesNotMatch(guide, /list.*Git 状态/, 'the authoring guide must not promise removed Git display metadata');
}
