/**
 * B2 permission option 契约（四态 kind / 作用域 always / freeText / 结构化预览）。
 * Run: node test/permission-option.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-option-'));
const compile = createSharedCompiler(root, tmp);
const {
  FREE_TEXT_MAX,
  FILE_PATHS_MAX,
  clampFreeText,
  defaultAutoResolve,
  isAutoResolveEnabled,
  decisionConfirmed,
  normalizePermissionPreview,
  parsePermissionDecision,
  matchAlwaysRule,
  buildAlwaysRule,
  serializeAlwaysRules,
  parseAlwaysRules,
  buildFileChangePreview,
  previewFromToolArgs,
  buildConfirmIpcPayload,
  scopeRank
} = await import(pathToFileURL(compile('shared/permissionOption.ts')).href);
const { isConfirmed, parseConfirmIpcPayload } = await import(
  pathToFileURL(compile('shared/confirmDialog.ts')).href
);

// ---------- 四态 kind ----------
assert.equal(decisionConfirmed({ kind: 'allowOnce' }), true);
assert.equal(decisionConfirmed({ kind: 'allowAlways', scope: 'project' }), true);
assert.equal(decisionConfirmed({ kind: 'deny' }), false);
assert.equal(decisionConfirmed({ kind: 'custom', freeText: '改用 npm test' }), false);

for (const kind of ['allowOnce', 'allowAlways', 'deny', 'custom']) {
  const d = parsePermissionDecision({ kind });
  assert.ok(d, `kind=${kind} 应可解析`);
  assert.equal(d.kind, kind);
}
assert.equal(parsePermissionDecision({ kind: 'plan' }), undefined);
assert.equal(parsePermissionDecision(null), undefined);

// allowAlways 缺省补 project
assert.deepEqual(parsePermissionDecision({ kind: 'allowAlways' }), {
  kind: 'allowAlways',
  scope: 'project'
});
assert.deepEqual(parsePermissionDecision({ kind: 'allowAlways', scope: 'session' }), {
  kind: 'allowAlways',
  scope: 'session'
});

// ---------- freeText 上限 + 回灌 ----------
assert.equal(clampFreeText('ok'), 'ok');
assert.equal(clampFreeText('x'.repeat(FREE_TEXT_MAX)).length, FREE_TEXT_MAX);
assert.equal(clampFreeText('x'.repeat(FREE_TEXT_MAX + 50)).length, FREE_TEXT_MAX);
const ft = parsePermissionDecision({ kind: 'custom', freeText: 'y'.repeat(FREE_TEXT_MAX + 10) });
assert.equal(ft.freeText.length, FREE_TEXT_MAX);
// 回灌：应答载荷保留 freeText
const payload = buildConfirmIpcPayload(false, 'button', { kind: 'custom', freeText: '改用 vitest' });
assert.equal(payload.kind, 'custom');
assert.equal(payload.freeText, '改用 vitest');
assert.equal(payload.confirmed, false);
const back = parseConfirmIpcPayload(payload);
assert.equal(back.kind, 'custom');
assert.equal(back.freeText, '改用 vitest');
assert.equal(isConfirmed(back), false);

// allowOnce/allowAlways 经 IPC 往返仍判为已确认
for (const kind of ['allowOnce', 'allowAlways']) {
  const p = buildConfirmIpcPayload(true, undefined, { kind, scope: 'session' });
  const r = parseConfirmIpcPayload(p);
  assert.equal(isConfirmed(r), true, `${kind} 应确认`);
  assert.equal(r.kind, kind);
}
assert.equal(parseConfirmIpcPayload(buildConfirmIpcPayload(true, undefined, { kind: 'allowAlways', scope: 'session' })).scope, 'session');

// ---------- 结构化预览 ----------
const filePrev = normalizePermissionPreview({
  scope: 'file',
  filePaths: ['a.ts', ' b.ts ', '', 3, ...Array.from({ length: 10 }, (_, i) => `f${i}.ts`)],
  fileChange: 'add'
});
assert.equal(filePrev.scope, 'file');
assert.equal(filePrev.filePaths.length, FILE_PATHS_MAX);
assert.equal(filePrev.filePaths[0], 'a.ts');
assert.equal(filePrev.filePaths[1], 'b.ts');
assert.equal(filePrev.fileChange, 'add');

const cmdPrev = normalizePermissionPreview({ scope: 'command', command: 'ls -la' });
assert.deepEqual(cmdPrev, { scope: 'command', command: 'ls -la' });

const genPrev = normalizePermissionPreview({ scope: 'generic', label: '删除主题' });
assert.equal(genPrev.label, '删除主题');

assert.equal(normalizePermissionPreview({ scope: 'bogus' }), undefined);
// 缺 fileChange 时回落 update
assert.equal(normalizePermissionPreview({ scope: 'file', filePaths: ['x'] }).fileChange, 'update');

const bp = buildFileChangePreview(['p1', 'p2'], 'add');
assert.equal(bp.scope, 'file');
assert.deepEqual(bp.filePaths, ['p1', 'p2']);
assert.equal(bp.fileChange, 'add');

const fromArgs = previewFromToolArgs({ path: 'src/index.ts', content: 'x' });
assert.equal(fromArgs.scope, 'file');
assert.equal(fromArgs.filePaths[0], 'src/index.ts');
assert.equal(fromArgs.fileChange, 'update');
assert.equal(previewFromToolArgs({ create: true, filePath: 'new.md' }).fileChange, 'add');
assert.equal(previewFromToolArgs({ command: 'git status' }).scope, 'command');
assert.equal(previewFromToolArgs({}, { label: '其它' }).scope, 'generic');

// ---------- always 规则：先 scope 后指纹 ----------
const rules = [
  { fingerprint: 'fp-tool', scope: 'project', scopeKey: 'ws-a', effect: 'allow' },
  { fingerprint: 'fp-tool', scope: 'global', scopeKey: 'global', effect: 'allow' },
  { fingerprint: 'fp-tool', scope: 'session', scopeKey: 'sess-1', effect: 'allow' },
  { fingerprint: 'fp-other', scope: 'session', scopeKey: 'sess-1', effect: 'allow' }
];
// 同指纹三条：session 最窄优先
const hit1 = matchAlwaysRule(rules, { fingerprint: 'fp-tool', projectKey: 'ws-a', sessionKey: 'sess-1' });
assert.equal(hit1.scope, 'session');
assert.equal(hit1.scopeKey, 'sess-1');
// 无 session 上下文 → project
const hit2 = matchAlwaysRule(rules, { fingerprint: 'fp-tool', projectKey: 'ws-a' });
assert.equal(hit2.scope, 'project');
// 换项目 → 只剩 global
const hit3 = matchAlwaysRule(rules, { fingerprint: 'fp-tool', projectKey: 'ws-b' });
assert.equal(hit3.scope, 'global');
// 指纹不中 → undefined（scope 相同也不认）
assert.equal(matchAlwaysRule(rules, { fingerprint: 'fp-nope', projectKey: 'ws-a', sessionKey: 'sess-1' }), undefined);
// 先 scope 后指纹：scope 不适用的规则直接出局，不看指纹
assert.equal(
  matchAlwaysRule([{ fingerprint: 'fp-tool', scope: 'session', scopeKey: 'sess-2', effect: 'allow' }], {
    fingerprint: 'fp-tool',
    sessionKey: 'sess-1'
  }),
  undefined
);
assert.equal(scopeRank('session') > scopeRank('project') && scopeRank('project') > scopeRank('global'), true);

// buildAlwaysRule 带 scope 持久化
const built = buildAlwaysRule(
  { kind: 'allowAlways', scope: 'session' },
  { fingerprint: 'fp-x', sessionKey: 'sess-9', now: 42 }
);
assert.deepEqual(built, {
  fingerprint: 'fp-x',
  scope: 'session',
  scopeKey: 'sess-9',
  effect: 'allow',
  createdAt: 42
});
assert.equal(buildAlwaysRule({ kind: 'allowOnce' }, { fingerprint: 'fp-x' }), undefined);
assert.equal(buildAlwaysRule({ kind: 'allowAlways', scope: 'session' }, { fingerprint: 'fp-x' }), undefined);

// 序列化 round-trip 保留 scope
const round = parseAlwaysRules(JSON.parse(serializeAlwaysRules(rules)));
assert.equal(round.length, 4);
assert.equal(round[0].scope, 'project');
assert.equal(round[2].scope, 'session');

// ---------- 倒计时自动处置默认关 ----------
assert.equal(defaultAutoResolve().enabled, false);
assert.equal(isAutoResolveEnabled(undefined), false);
assert.equal(isAutoResolveEnabled({ enabled: false }), false);
assert.equal(isAutoResolveEnabled({ enabled: true }), true);

// ---------- 2026-09-27 复审回归：executor always 规则接线（指纹纪律 + 存取回环） ----------
{
  const {
    setAlwaysRulesUserDataDir,
    AlwaysRuleStore,
    dangerousGateFingerprint,
    matchesAlwaysRule,
    recordAlwaysRule
  } = await import(pathToFileURL(compile('main/capabilities/alwaysRules.ts')).href);

  // 指纹纪律：command/file 可锚定；generic/无参数身份不出指纹（防同工具任意参数放大）
  assert.ok(
    dangerousGateFingerprint('a.b', { command: 'npm  Test' })?.endsWith('|cmd:npm test'),
    'command 指纹 = 工具名 + 归一化命令'
  );
  assert.equal(
    dangerousGateFingerprint('a.b', { path: 'B.ts', filePath: 'a.ts' }),
    dangerousGateFingerprint('a.b', { filePath: 'a.ts', path: 'B.ts' }),
    'file 指纹与键序/顺序无关（排序去小写）'
  );
  assert.equal(dangerousGateFingerprint('a.b', { note: 'x' }), null, '无参数身份不出指纹');

  // 二轮复审回归：指纹不经 FILE_PATHS_MAX 截断——「前 6 路径相同、尾部任意」不得共享指纹
  {
    const many = Array.from({ length: 8 }, (_, i) => ({ type: 'add', filePath: `f${i}.ts`, content: '' }));
    const fpMany = dangerousGateFingerprint('x.y', { files: many });
    const fpTailChanged = dangerousGateFingerprint('x.y', {
      files: [...many.slice(0, 6), { type: 'add', filePath: 'EVIL0.ts', content: '' }, { type: 'add', filePath: 'EVIL1.ts', content: '' }]
    });
    assert.ok(fpMany && fpTailChanged, '两形态都出指纹');
    assert.notEqual(fpMany, fpTailChanged, '尾部路径不同 → 指纹不同（截断碰撞被堵）');
    // 结构化 patch 的 movePath 也进指纹
    const fpMove = dangerousGateFingerprint('x.y', { files: [{ type: 'move', filePath: 'a.ts', movePath: 'b.ts' }] });
    assert.ok(fpMove?.includes('a.ts') && fpMove?.includes('b.ts'), 'move 双路径都入指纹');
  }

  // 存取回环：注入临时 userData → record → match（同指纹命中 / 异指纹不命中 / 跨 project 不命中）
  setAlwaysRulesUserDataDir(tmp);
  const fp = dangerousGateFingerprint('a.b', { scope: 'command', command: 'npm test' });
  assert.equal(matchesAlwaysRule(fp, 'ws-1'), false, '落库前不命中');
  recordAlwaysRule({ kind: 'allowAlways', scope: 'project' }, fp, 'ws-1');
  assert.equal(matchesAlwaysRule(fp, 'ws-1'), true, '同指纹同工作区命中');
  assert.equal(matchesAlwaysRule(fp, 'ws-2'), false, 'project 规则不跨工作区');
  assert.equal(
    matchesAlwaysRule(dangerousGateFingerprint('a.b', { scope: 'command', command: 'npm test --watch' }), 'ws-1'),
    false,
    '不同命令不同指纹，不放大'
  );
  assert.equal(matchesAlwaysRule(null, 'ws-1'), false, '无指纹恒不命中');

  // 全局规则通吃；同指纹+scope 覆盖旧的
  recordAlwaysRule({ kind: 'allowAlways', scope: 'global' }, fp, 'ws-1');
  assert.equal(matchesAlwaysRule(fp, 'ws-9'), true, 'global 规则跨工作区命中');
  const s = new AlwaysRuleStore(path.join(tmp, 'permission-always-rules.json'));
  assert.equal(s.size, 2, '同指纹 project+global 各一条');

  console.log('ok: executor always 规则（指纹纪律 + 存取回环）');
}

console.log('permission-option: ok');
