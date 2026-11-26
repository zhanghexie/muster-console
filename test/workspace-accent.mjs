/**
 * 工作区强调色：同 id 恒同色、只取色板内颜色、空 id 回落首色、色板足够分散。
 * Run: node test/workspace-accent.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-accent-'));
const compile = createSharedCompiler(root, tmp);
const {
  workspaceAccent,
  WORKSPACE_ACCENTS,
  NEUTRAL_ACCENT,
  hashedWorkspaceAccent,
  resolveWorkspaceAccent,
  registerWorkspaceAccents,
  setWorkspaceAccentPreview,
  subscribeWorkspaceAccents,
  workspaceAccentVersion,
  applyWorkspaceAccentPatch,
  hasAccentPatch,
  parseWorkspaceAccentFields,
  pickDominantAccent,
  normalizeAvatarAccent,
  normalizeWorkspaceAccentDefault, setWorkspaceAccentDefault, workspaceAccentEnabled, hasWorkspaceAccentOverride
} = await import(pathToFileURL(compile('shared/workspaceAccent.ts')).href);

assert.equal(workspaceAccent(null), WORKSPACE_ACCENTS[0], '无工作区回落首色');
assert.equal(workspaceAccent(''), WORKSPACE_ACCENTS[0], '空 id 回落首色');
assert.equal(workspaceAccent('ws-abc'), workspaceAccent('ws-abc'), '同 id 恒同色');

const ids = Array.from({ length: 64 }, (_, i) => `ws-${i}-${(i * 7919).toString(36)}`);
const used = new Set();
for (const id of ids) {
  const c = workspaceAccent(id);
  assert.ok(WORKSPACE_ACCENTS.includes(c), `只取色板内颜色：${c}`);
  used.add(c);
}
assert.ok(used.size >= WORKSPACE_ACCENTS.length - 1, `64 个 id 应覆盖几乎全部色板（实际 ${used.size}）`);
assert.equal(new Set(WORKSPACE_ACCENTS).size, WORKSPACE_ACCENTS.length, '色板无重复');
for (const c of WORKSPACE_ACCENTS) assert.match(c, /^#[0-9a-f]{6}$/, '色板为 6 位 hex');

// —— 来源优先级：关闭 > 手选 > 跟随头像 > 哈希 ——
const id = 'ws-prio';
assert.equal(resolveWorkspaceAccent({ id }), hashedWorkspaceAccent(id), '旧工作区（无字段）= 哈希色');
assert.equal(resolveWorkspaceAccent({ id, accent: '#AABBCC' }), '#aabbcc', '手选色（小写化）');
assert.equal(resolveWorkspaceAccent({ id, accent: 'avatar', avatarAccent: '#112233' }), '#112233', '跟随头像');
assert.equal(resolveWorkspaceAccent({ id, accent: 'avatar' }), hashedWorkspaceAccent(id), '头像无色 → 哈希兜底');
assert.equal(resolveWorkspaceAccent({ id, accent: '#aabbcc', accentOff: true }), NEUTRAL_ACCENT, '关闭 → 中性灰');

// —— 渲染层查表：登记后只持 id 的调用点拿到用户设定色；未登记仍哈希 ——
registerWorkspaceAccents([{ id: 'ws-x', accent: '#123456' }, { id: 'ws-y', accentOff: true }]);
assert.equal(workspaceAccent('ws-x'), '#123456');
assert.equal(workspaceAccent('ws-y'), NEUTRAL_ACCENT);
assert.equal(workspaceAccent('ws-z'), hashedWorkspaceAccent('ws-z'), '未登记 id 回落哈希');
registerWorkspaceAccents([]);
assert.equal(workspaceAccent('ws-x'), hashedWorkspaceAccent('ws-x'), '重新登记会清掉旧表');

// —— 实时预览：优先于已登记值、变更才通知、撤销回到已登记值 ——
registerWorkspaceAccents([{ id: 'ws-p', accent: '#123456' }]);
let notified = 0;
const off = subscribeWorkspaceAccents(() => notified++);
const v0 = workspaceAccentVersion();
setWorkspaceAccentPreview('ws-p', '#abcdef');
assert.equal(workspaceAccent('ws-p'), '#abcdef', '预览优先');
setWorkspaceAccentPreview('ws-p', '#abcdef');
assert.equal(notified, 1, '同色重复预览不通知');
registerWorkspaceAccents([{ id: 'ws-p', accent: '#654321' }]);
assert.equal(workspaceAccent('ws-p'), '#abcdef', '重新登记不冲掉进行中的预览');
setWorkspaceAccentPreview('ws-p', null);
assert.equal(workspaceAccent('ws-p'), '#654321', '撤销预览回到已登记值');
setWorkspaceAccentPreview('ws-p', null);
assert.equal(notified, 2, '无预览时撤销不通知');
assert.equal(workspaceAccentVersion(), v0 + 2, '每次有效变更版本号自增');
off();
registerWorkspaceAccents([]);

// 全局默认只作用于跟随者；独立工作区连开关一并覆盖，清除后重新继承。
const defaults = { accent: '#abcdef', enabled: false };
assert.deepEqual(normalizeWorkspaceAccentDefault({ accent: 'bad', enabled: 'false' }), { accent: 'avatar', enabled: true });
assert.equal(resolveWorkspaceAccent({ id }, defaults), NEUTRAL_ACCENT);
assert.equal(resolveWorkspaceAccent({ id, accent: '#123456' }, defaults), '#123456');
assert.equal(hasWorkspaceAccentOverride({ id, avatarAccent: '#123456' }), false, '头像缓存不是独立主题色');
registerWorkspaceAccents([{ id: 'follower' }, { id: 'custom', accent: '#123456' }]);
setWorkspaceAccentDefault(defaults);
assert.equal(workspaceAccentEnabled('follower'), false);
assert.equal(workspaceAccentEnabled('custom'), true);
assert.equal(workspaceAccent('follower'), NEUTRAL_ACCENT);
setWorkspaceAccentDefault({ accent: '#abcdef', enabled: true });
assert.equal(workspaceAccent('follower'), '#abcdef', '全局变更立即刷新已登记工作区');
assert.equal(workspaceAccent('custom'), '#123456', '全局变更保留局部覆盖');
const restored = applyWorkspaceAccentPatch({ id, accent: '#123456', accentOff: true, avatarAccent: '#010203' }, { accent: null, accentOff: false });
assert.equal(hasWorkspaceAccentOverride(restored), false);
assert.equal(resolveWorkspaceAccent(restored, { accent: '#abcdef', enabled: true }), '#abcdef');
setWorkspaceAccentDefault(undefined);
registerWorkspaceAccents([]);

// —— 补丁：null/'' 清除、非法值忽略、accentOff:false 删字段 ——
assert.equal(hasAccentPatch({ name: 'n' }), false);
assert.equal(hasAccentPatch({ accentOff: false }), true);
const base = { id, accent: '#aabbcc', avatarAccent: '#010203', accentOff: true };
assert.deepEqual(applyWorkspaceAccentPatch(base, { accent: 'avatar', accentOff: false }), {
  id,
  accent: 'avatar',
  avatarAccent: '#010203'
});
assert.deepEqual(applyWorkspaceAccentPatch(base, { accent: 'red', avatarAccent: 'nope' }), base, '非法值不写不删');
assert.deepEqual(applyWorkspaceAccentPatch(base, { accent: null, avatarAccent: '' }), { id, accentOff: true });
assert.notEqual(applyWorkspaceAccentPatch(base, {}), base, '返回新对象，不改原对象');

// —— 配置解析：只收合法字段 ——
assert.deepEqual(parseWorkspaceAccentFields({ accent: 'AVATAR', avatarAccent: 1, accentOff: 'yes' }), {});
assert.deepEqual(parseWorkspaceAccentFields({ accent: '#ABCDEF', avatarAccent: '#010203', accentOff: true }), {
  accent: '#abcdef',
  avatarAccent: '#010203',
  accentOff: true
});

// —— 头像取色：主色相胜出、近灰/透明返回 null、结果落在色板明度区间 ——
function pixels(list) {
  const out = [];
  for (const [rgba, n] of list) for (let i = 0; i < n; i++) out.push(...rgba);
  return out;
}
function hue(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}
const orangeFox = pixels([
  [[240, 120, 30, 255], 60],
  [[250, 250, 250, 255], 30],
  [[20, 20, 20, 255], 20],
  [[40, 90, 220, 255], 10],
  [[0, 0, 0, 0], 100]
]);
const picked = pickDominantAccent(orangeFox);
assert.match(picked, /^#[0-9a-f]{6}$/);
assert.ok(Math.abs(hue(picked) - 26) < 8, `橙色像素占多数 → 橙色相（实际 ${picked}）`);
assert.equal(pickDominantAccent(pixels([[[128, 128, 130, 255], 50]])), null, '近灰头像 → null');
assert.equal(pickDominantAccent(pixels([[[255, 0, 0, 0], 50]])), null, '全透明 → null');
assert.equal(normalizeAvatarAccent(10, 10, 10), null);
assert.equal(normalizeAvatarAccent(255, 0, 0), normalizeAvatarAccent(120, 0, 0), '同色相不同深浅 → 同一强调色');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('workspace-accent: ok');
