import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-domain-samples-'));
const compile = createSharedCompiler(repo, path.join(repo, '.tmp', 'extensions-samples-compile'));
const { ExtensionSourceLayout } = await import(pathToFileURL(compile('main/extensions/extensionSourceLayout.ts')).href);
const { ExtensionPackageCatalog } = await import(pathToFileURL(compile('main/extensions/extensionPackageCatalog.ts')).href);
const sampleRoot = path.join(repo, 'resources', 'extensions');
const dailyPanel = fs.readFileSync(path.join(sampleRoot, 'daily-report', 'ui', 'panel.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(sampleRoot, 'daily-report', 'extension.json'), 'utf8'));
assert.equal(manifest.icon, 'builtin-extension:daily-report');
assert.match(dailyPanel, /id="calBox"/, '日报样例应保留旧版日历');
assert.match(dailyPanel, /id="todoText"/, '日报样例应提供可操作的待办表单');
assert.match(dailyPanel, /function statusOn\(/, '日报样例应按日期计算待办状态');
assert.match(dailyPanel, /function generateReport\(/, '日报样例应保留日报生成入口');
assert.match(dailyPanel, /ma\.on\('state\.changed'/, '日报样例应订阅 DomainRuntime 状态回流');
assert.match(dailyPanel, /M6 4V2\.5h4M4 4l\.8 9\.5/, '日报删除图标应保留合法 SVG 路径');
// 沙箱存储契约：面板 iframe 无 allow-same-origin（opaque origin），访问 localStorage 会抛
// SecurityError 并让整个模块求值失败（所有按钮绑定失效）。样例面板持久化一律走 ma.storage。
for (const id of ['daily-report']) {
  const uiDir = path.join(sampleRoot, id, 'ui');
  for (const file of fs.readdirSync(uiDir).filter(name => name.endsWith('.mjs') || name.endsWith('.html'))) {
    const source = fs.readFileSync(path.join(uiDir, file), 'utf8');
    assert.doesNotMatch(source, /\blocalStorage\s*\.\s*(getItem|setItem|removeItem|key|\w)/, `${id}/${file} 是沙箱 iframe（opaque origin），访问 localStorage 会抛 SecurityError；持久化走 ma.storage`);
  }
}
const globalRoot = path.join(tmp, 'extensions');
fs.cpSync(path.join(sampleRoot, 'daily-report'), path.join(globalRoot, 'daily-report'), { recursive: true });
const layout = new ExtensionSourceLayout({ userData: tmp, globalRoot });
const catalog = new ExtensionPackageCatalog({ layout, file: path.join(tmp, 'registry.json') });
const scan = await catalog.syncGlobal();
assert.equal(scan.errors.length, 0);
assert.deepEqual(scan.packages.map(item => item.descriptor.extensionId).sort(), ['daily-report']);

const samples = {
  'daily-report': { query: 'todos.open', command: 'todo.create', args: { text: '验证样例' } }
};
for (const [id, contract] of Object.entries(samples)) {
  const packageInfo = catalog.get('global', id);
  assert.ok(packageInfo);
  const module = await import(`${pathToFileURL(path.join(sampleRoot, id, 'domain.mjs')).href}?sample=${id}`);
  const files = new Map();
  const broker = async (method, args) => {
    if (method === 'data.read') {
      const content = files.get(String(args[0] ?? ''));
      return content === undefined ? null : { content };
    }
    if (method === 'data.write') { files.set(String(args[0] ?? ''), String(args[1] ?? '')); return { ok: true }; }
    if (method === 'data.list') return [];
    if (method === 'journal.list') return { dates: [] };
    throw new Error(`unexpected sample broker call: ${method}`);
  };
  const runtime = await module.createDomainRuntime({ broker });
  const context = { identity: {}, manifest: {}, actor: 'human', requestId: 'sample', signal: new AbortController().signal };
  const before = await runtime.getSnapshot(context);
  const query = await runtime.query(contract.query, {}, context);
  assert.ok(query);
  if (contract.expectError) {
    await assert.rejects(() => runtime.execute(contract.command, contract.args, context), error => String(error).includes(contract.expectError));
  } else {
    const result = await runtime.execute(contract.command, contract.args, context);
    assert.equal(result.ok, true);
    const after = await runtime.getSnapshot(context);
    assert.equal(after.version, before.version + 1);
  }
  await runtime.close?.();
}
console.log('extensions-samples: ok');


