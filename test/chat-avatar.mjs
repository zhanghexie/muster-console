/**
 * 会话消息头像纯函数：发送者归类、连续省略、用户配置归一、face 解析。
 * 运行: node test/chat-avatar.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import os from 'node:os';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-avatar-'));
const compile = createSharedCompiler(root, tmp);
const m = await import(pathToFileURL(compile('shared/userAvatar.ts')).href);
const { applyLocaleSetting } = await import(pathToFileURL(compile('shared/i18n/index.ts')).href);

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

{
  assert.equal(m.chatAvatarSender({ role: 'user' }, 'dispatch'), 'user');
  assert.equal(m.chatAvatarSender({ role: 'user', host: true }, 'dispatch'), 'host');
  assert.equal(m.chatAvatarSender({ role: 'assistant' }, 'dispatch'), 'scheduler');
  assert.equal(m.chatAvatarSender({ role: 'assistant' }, 'gui-session'), 'assistant');
  assert.equal(
    m.chatAvatarSender({ role: 'user', source: 'scheduler' }, 'gui-session'),
    'scheduler'
  );
  assert.equal(
    m.chatAvatarSender({ role: 'user', host: true, source: 'scheduler' }, 'gui-session'),
    'host',
    'host 通栏优先于 scheduler source'
  );
  ok('发送者：user / host / 调度 / Worker / 调度注入');
}

{
  const u = { role: 'user' };
  const a = { role: 'assistant' };
  assert.equal(m.shouldOmitRepeatedAvatar(undefined, u, 'gui-session'), false);
  assert.equal(m.shouldOmitRepeatedAvatar(u, u, 'gui-session'), true);
  assert.equal(m.shouldOmitRepeatedAvatar(u, u, 'gui-session', true), false);
  assert.equal(m.shouldOmitRepeatedAvatar(u, a, 'gui-session'), false);
  assert.equal(m.shouldOmitRepeatedAvatar(a, a, 'dispatch'), true);
  const sched = { role: 'user', source: 'scheduler' };
  assert.equal(m.shouldOmitRepeatedAvatar(u, sched, 'gui-session'), false);
  assert.equal(m.shouldOmitRepeatedAvatar(sched, sched, 'gui-session'), true);
  assert.equal(m.hasChatMessageAvatar(a), false);
  assert.equal(m.hasChatMessageAvatar(u), true);
  assert.equal(m.hasChatMessageAvatar(sched), true);
  assert.equal(m.hasChatMessageAvatar({ role: 'assistant', host: true }), true);
  assert.equal(m.shouldOmitRepeatedAvatar(a, sched, 'dispatch'), false, 'AI 回复不能省略后续调度注入头像');
  assert.equal(m.shouldOmitRepeatedAvatar(sched, a, 'dispatch'), false, '右侧注入与无头像回复不能归为连续消息');
  ok('连续同发送者省略；时间分隔/换角色打断');
}

{
  const d = m.normalizeUserAvatar(undefined);
  assert.equal(d.kind, 'emoji');
  assert.equal(d.value, m.DEFAULT_USER_AVATAR_EMOJI);
  assert.deepEqual(m.normalizeUserAvatar('😺'), { kind: 'emoji', value: '😺' });
  assert.equal(m.serializeUserAvatar({ kind: 'image', value: 'data:image/png;base64,xx' }).kind, 'image');
  assert.equal(m.serializeUserAvatar({ kind: 'image', value: 'data:image/png;base64,xx' }).value, undefined);
  ok('用户头像归一 / 落盘 image 不带 data URL');
}

{
  const host = m.resolveAvatarFace({
    sender: 'host',
    userAvatar: { kind: 'emoji', value: '🙂' }
  });
  assert.equal(host.shape, 'squircle');
  assert.equal(host.value, '宿主');

  const user = m.resolveAvatarFace({
    sender: 'user',
    userAvatar: { kind: 'emoji', value: '🦊' }
  });
  assert.equal(user.value, '🦊');

  const sched = m.resolveAvatarFace({
    sender: 'scheduler',
    userAvatar: { kind: 'emoji', value: '🙂' },
    context: { surfaceKind: 'dispatch', workspaceAvatar: '🚀', workspaceName: '区' }
  });
  assert.equal(sched.type, 'text');
  assert.equal(sched.value, '🚀');

  const worker = m.resolveAvatarFace({
    sender: 'assistant',
    userAvatar: { kind: 'emoji', value: '🙂' },
    context: { surfaceKind: 'gui-session', runtimeId: 'cursor', sessionName: '改布局' }
  });
  assert.equal(worker.value, 'C');

  const named = m.resolveAvatarFace({
    sender: 'assistant',
    userAvatar: { kind: 'emoji', value: '🙂' },
    context: { surfaceKind: 'gui-session', sessionName: '改布局' }
  });
  assert.equal(named.value, '改');
  ok('face：宿主方印 / 用户 emoji / 调度工作区 / Worker runtime 或首字');
}

{
  const av = { kind: 'emoji', value: '🙂', displayName: '小明' };
  assert.equal(m.resolveAvatarTooltip({ sender: 'host', userAvatar: av }), '宿主');
  assert.equal(m.resolveAvatarTooltip({ sender: 'scheduler', userAvatar: av }), '调度 Agent');
  assert.equal(m.resolveAvatarTooltip({ sender: 'user', userAvatar: av }), '小明');
  assert.equal(
    m.resolveAvatarTooltip({ sender: 'user', userAvatar: { kind: 'emoji', value: '🙂' } }),
    '我'
  );
  assert.equal(
    m.resolveAvatarTooltip({
      sender: 'assistant',
      userAvatar: av,
      context: { surfaceKind: 'gui-session', sessionName: '改布局', runtimeLabel: 'Cursor' }
    }),
    '改布局'
  );
  ok('悬浮名：宿主 / 调度 Agent / 用户显示名 / Worker 会话名');
}

// ---------------------------------------------------------------------------
// 回归（P3 chat-message-avatar F-01）：头像图片落盘失败不再静默回落默认 emoji。
// persistUserAvatarPatch 抛错 → config.update 整单失败 → 设置页提示并保留原头像。
// 还原即红：改回「return keepName({kind:'emoji',...})」后 throws 断言失败。
{
  const f = await import(pathToFileURL(compile('main/userAvatarFile.ts')).href);
  const dir = fs.mkdtempSync(path.join(tmp, 'persist-'));
  const tinyPng = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`;
  const kept = f.persistUserAvatarPatch(dir, { kind: 'image', value: tinyPng, displayName: '我' });
  assert.equal(kept.kind, 'image');
  assert.equal(kept.displayName, '我');
  assert.ok(fs.existsSync(path.join(dir, 'avatars', 'user.png')), '小图正常落盘');

  // 处理后仍超 256KB：必须抛错（旧实现静默返回默认 emoji，用户上传无任何反馈）
  // base64 解码后 ≈ 4/3 长度：400*1024 字符 → 约 307KB > 256KB
  const big = `data:image/png;base64,${'A'.repeat(400 * 1024)}`;
  assert.throws(
    () => f.persistUserAvatarPatch(dir, { kind: 'image', value: big }),
    /256KB/,
    '超限图片落盘失败要抛错而非静默回落 emoji'
  );
  try {
    applyLocaleSetting('en');
    assert.throws(() => f.persistUserAvatarPatch(dir, { kind: 'image', value: big }), /Image still exceeds 256KB or is invalid/);
  } finally { applyLocaleSetting('zh-CN'); }
  // 非图片分支不受影响：删除文件并回落归一值
  const emoji = f.persistUserAvatarPatch(dir, { kind: 'emoji', value: '🐶' });
  assert.equal(emoji.kind, 'emoji');
  assert.ok(!fs.existsSync(path.join(dir, 'avatars', 'user.png')));
  ok('persistUserAvatarPatch：落盘成功保留 / 超限抛错 / emoji 分支不受影响');
}

console.log(`\nchat-avatar: ${passed} 组断言全绿`);
