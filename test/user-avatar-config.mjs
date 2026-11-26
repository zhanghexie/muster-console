/**
 * 用户消息头像 AppConfig 读写：
 * 1) 缺省 🙂；
 * 2) emoji update→save 落盘含 userAvatar；
 * 3) image 写 userData/avatars/user.png，config.json 只留 kind；
 * 4) 重启 hydrate data URL；改回 emoji 删文件。
 * 运行: node test/user-avatar-config.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'user-avatar-config-'));
const compile = createSharedCompiler(root, tmp);

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

const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const configPath = path.join(userData, 'config.json');
const avatarFile = path.join(userData, 'avatars', 'user.png');
const configMod = await import(pathToFileURL(compile('main/config.ts')));

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

{
  fs.rmSync(configPath, { force: true });
  const cm = new configMod.ConfigManager();
  assert.equal(cm.get().userAvatar.kind, 'emoji');
  assert.equal(cm.get().userAvatar.value, '🙂');
  ok('缺省：🙂');
}

{
  const cm = new configMod.ConfigManager();
  cm.update({ userAvatar: { kind: 'emoji', value: '🦊' } });
  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(onDisk.userAvatar, { kind: 'emoji', value: '🦊' });
  ok('update：emoji 写入 config.json');
}

{
  const cm = new configMod.ConfigManager();
  cm.update({ userAvatar: { kind: 'image', value: PNG_1X1 } });
  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(onDisk.userAvatar, { kind: 'image' });
  assert.equal(fs.existsSync(avatarFile), true, '像素落 userData/avatars/user.png');
  assert.ok(cm.get().userAvatar.value.startsWith('data:image/'));
  const leftovers = fs.readdirSync(path.dirname(avatarFile)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '原子写不留 .tmp 残留');
  ok('update：image 落文件（原子写），json 不内嵌');
}

{
  const cm = new configMod.ConfigManager();
  assert.equal(cm.get().userAvatar.kind, 'image');
  assert.ok(cm.get().userAvatar.value.startsWith('data:image/'), '重启 hydrate');
  cm.update({ dispatcherAppendPrompt: 'x' });
  assert.equal(cm.get().userAvatar.kind, 'image');
  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(onDisk.userAvatar, { kind: 'image' });
  ok('往返：重启后 image 存活，无关 update 不洗掉');
}

{
  const cm = new configMod.ConfigManager();
  cm.update({ userAvatar: { kind: 'emoji', value: '😺' } });
  assert.equal(fs.existsSync(avatarFile), false, '改回 emoji 删文件');
  assert.deepEqual(cm.get().userAvatar, { kind: 'emoji', value: '😺' });
  ok('改回 emoji 清文件');
}

{
  const cm = new configMod.ConfigManager();
  cm.update({ userAvatar: { kind: 'emoji', value: '🙂', displayName: '小明' } });
  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(onDisk.userAvatar.displayName, '小明');
  const again = new configMod.ConfigManager();
  assert.equal(again.get().userAvatar.displayName, '小明');
  ok('显示名落盘并重启存活');
}

{
  const { SUBAGENT_CHARACTERS } = await import(pathToFileURL(compile('shared/subagentCharacters.ts')));
  const cm = new configMod.ConfigManager();
  cm.update({ userAvatar: { kind: 'image', value: PNG_1X1 } });
  for (const c of SUBAGENT_CHARACTERS) {
    const selected = { kind: 'builtin', value: c.id, displayName: '我的名字' };
    cm.update({ userAvatar: selected });
    assert.deepEqual(cm.get().userAvatar, selected);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).userAvatar, selected, '只保存内置 ID');
    assert.deepEqual(new configMod.ConfigManager().get().userAvatar, selected, '重启后保留内置符号及显示名');
    assert.equal(fs.existsSync(avatarFile), false, '内置图不落上传文件');
    cm.update({ userAvatar: { kind: 'emoji', value: c.id, displayName: '我的名字' } });
    assert.deepEqual(cm.get().userAvatar, selected, '恢复旧主进程错误标成 emoji 的内置 ID');
  }
  cm.update({ userAvatar: { kind: 'builtin', value: 'https://example.invalid/face.webp', displayName: '名字' } });
  assert.deepEqual(cm.get().userAvatar, { kind: 'emoji', value: '🙂', displayName: '名字' }, '拒绝任意 URL/未知内置 ID');
  cm.update({ userAvatar: { kind: 'builtin', value: 'pixel' } });
  cm.update({ userAvatar: { kind: 'image', value: PNG_1X1 } });
  assert.equal(new configMod.ConfigManager().get().userAvatar.kind, 'image');
  cm.update({ userAvatar: { kind: 'emoji', value: '🦊' } });
  assert.deepEqual(new configMod.ConfigManager().get().userAvatar, { kind: 'emoji', value: '🦊' });
  ok('24 个内置 ID 落盘/重启、显示名、上传切换与白名单校验');
}

{
  fs.writeFileSync(configPath, JSON.stringify({ userAvatar: { kind: 'emoji', value: 'scout', displayName: '我' } }));
  assert.deepEqual(new configMod.ConfigManager().get().userAvatar, { kind: 'builtin', value: 'scout', displayName: '我' });
  ok('用户现场遗留 emoji:scout 配置启动时恢复符号');
}

console.log(`\nuser-avatar-config: ${passed} 组断言全绿`);
