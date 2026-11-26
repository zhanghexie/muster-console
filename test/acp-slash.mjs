/**
 * ACP AvailableCommands → 斜杠菜单纯函数。
 * 运行: node test/acp-slash.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-slash-'));
const compile = createSharedCompiler(root, tmp);
const { acpCommandsToSlashItems, filterAcpSlashItems } = await import(
  pathToFileURL(compile('shared/acpSlash.ts')).href
);
const { applyLocaleSetting } = await import(pathToFileURL(compile('shared/i18n/index.ts')).href);

const items = acpCommandsToSlashItems([
  { name: '/compact', description: '压缩上下文' },
  { name: 'compact', description: '重复应去重' },
  { name: 'init', description: '初始化' },
  { name: 'issue', description: '建议题', inputHint: '<title> [--assignee @me]' }
]);
assert.equal(items.length, 3);
assert.equal(items[0].label, '/compact');
assert.equal(items[0].id, 'acp:compact');
assert.ok(items[0].insert.startsWith('/compact'));

// F-03（reliability/acp-gui-driver）：inputHint 必须真正进菜单出口——description 拼参数
// 提示；还原成死三元（insert 两分支相同、hint 丢弃）时下面两条断言转红
assert.equal(
  items[2].description,
  '建议题（参数：<title> [--assignee @me]）',
  'inputHint 应拼进 description 作参数提示'
);
assert.equal(items[2].insert, '/issue ', 'insert 带尾随空格（补参数位）');
// 无 hint 时 description 保持原样
assert.equal(items[1].description, '初始化');
// 无 description 时回落命令名，有 hint 仍拼参数
const fallback = acpCommandsToSlashItems([{ name: 'noDesc', inputHint: '<arg>' }]);
assert.equal(fallback[0].description, 'noDesc（参数：<arg>）');

const hit = filterAcpSlashItems(items, 'comp');
assert.equal(hit.length, 1);
assert.equal(hit[0].label, '/compact');
// 参数提示文本可被 filter 命中（hint 消费后参与搜索）
assert.equal(filterAcpSlashItems(items, 'assignee').length, 1);
try {
  applyLocaleSetting('en');
  const translated = acpCommandsToSlashItems([{ name: 'issue', description: '外部原始描述', inputHint: '<title>' }]);
  assert.equal(translated[0].description, '外部原始描述 (Arguments: <title>)');
  assert.equal(translated[0].insert, '/issue ');
} finally { applyLocaleSetting('zh-CN'); }

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] acp-slash');
