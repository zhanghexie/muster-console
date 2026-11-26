/**
 * 通知偏好 config 读写测试（T1.4）：
 * 1) load 归一化：合法字段保留（done/error/dnd），非法值剥除；
 * 2) update→save 落盘：config.json 必须含 notify（回归：save payload 曾漏 notify 字段，
 *    设置页写入会被静默丢弃——还原该修复本用例转红）；
 * 3) 磁盘往返：重启（重新实例化）后偏好存活。
 * 运行: node test/notify-prefs-config.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-prefs-config-'));
const compile = createSharedCompiler(root, tmp);

// electron shim：ConfigManager 构造时 app.getPath('userData') 指向临时 userdata
const userData = path.join(tmp, 'userdata');
fs.mkdirSync(userData, { recursive: true });
const electronDir = path.join(tmp, 'node_modules', 'electron');
fs.mkdirSync(electronDir, { recursive: true });
fs.writeFileSync(
  path.join(electronDir, 'package.json'),
  JSON.stringify({ name: 'electron', type: 'module', main: 'index.mjs' })
);
fs.writeFileSync(
  path.join(electronDir, 'index.mjs'),
  `export const app = { getPath: () => ${JSON.stringify(userData)} };\nexport default { app };\n`
);

function pathToFileURL(p) {
  return 'file:///' + p.replace(/\\/g, '/');
}

const configPath = path.join(userData, 'config.json');
const configMod = await import(pathToFileURL(compile('main/config.ts')));

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ---------- 1) load 归一化 ----------
{
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      feishu: { bound: [{ openId: 'old-user', chatId: 'old-chat', boundAt: 1 }] },
      notify: {
        done: false,
        error: true,
        dnd: { start: '22:00', end: '07:30' },
        feishuBoundOnly: false
      }
    })
  );
  const cm = new configMod.ConfigManager();
  const notify = cm.get().notify;
  assert.deepEqual(notify, {
    done: false,
    dnd: { start: '22:00', end: '07:30' },
    error: true
  });
  assert.equal(cm.get().feishu, undefined);
  ok('load：保留现行偏好并丢弃退役飞书设置');
}

{
  // 非法值：布尔字段传字符串、dnd 时间越界 / 起止相同、多余字段——全部剥除
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      notify: {
        done: 'yes',
        feishuBoundOnly: 1,
        dnd: { start: '25:00', end: '08:00' },
        junk: 'x'
      }
    })
  );
  const cm = new configMod.ConfigManager();
  assert.deepEqual(cm.get().notify, {});
  ok('load：非法值剥除（非布尔 / 时间越界 / 未知字段）');

  fs.writeFileSync(
    configPath,
    JSON.stringify({ notify: { dnd: { start: '22:00', end: '22:00' } } })
  );
  const cm2 = new configMod.ConfigManager();
  assert.equal(cm2.get().notify.dnd, undefined, '起止相同=无效窗口，须剥除');
  ok('load：起止相同的 dnd 剥除');
}

// ---------- 2) update→save 落盘（回归：save payload 漏 notify） ----------
{
  fs.rmSync(configPath, { force: true });
  const cm = new configMod.ConfigManager();
  const prefs = {
    done: false,
    error: false,
    dnd: { start: '23:00', end: '06:00' }
  };
  cm.update({ notify: prefs });
  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(onDisk.notify, prefs, 'config.json 落盘必须含 notify（save payload 回归）');
  ok('update：偏好写入 config.json（落盘含 notify 字段）');
}

// ---------- 3) 磁盘往返 ----------
{
  const cm = new configMod.ConfigManager(); // 模拟重启：重新读盘
  const notify = cm.get().notify;
  assert.equal(notify.done, false);
  assert.equal(notify.error, false);
  assert.deepEqual(notify.dnd, { start: '23:00', end: '06:00' });
  assert.equal(notify.feishuBoundOnly, undefined);

  // 后续 update 不洗掉 notify（normalizeConfig 透传）
  cm.update({ dispatcherAppendPrompt: 'x' });
  assert.deepEqual(cm.get().notify?.dnd, { start: '23:00', end: '06:00' });
  ok('往返：重启后偏好存活，无关 update 不洗掉');
}

console.log(`\nnotify-prefs-config: ${passed} 组断言全绿`);
