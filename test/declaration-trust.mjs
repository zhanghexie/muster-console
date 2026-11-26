/**
 * 声明 digest 信任链（S2.1 / T1+T2）：
 * 1) 纯函数：同内容同 digest、改字节 digest 变、canonical key 排序、七态、
 *    reviewMonotonicity 单调表、注入门仅 trusted_persistent；
 * 2) DeclarationTrustStore：userData/declaration-trust/<workspaceId>.json、
 *    key=(workspaceIdentity,digest)、grant/gate/stale、review 单调写入；
 * 3) 一期接线：injection-registry 注入源 + HOST/HOST-EXT 片段——
 *    未信任不注入、信任后注入、改内容回 stale_digest。
 * 运行: node test/declaration-trust.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'declaration-trust-'));
const compile = createSharedCompiler(root, tmp);

const pure = await import(pathToFileURL(compile('shared/declarationTrust.ts')).href);
const {
  sha256Hex, canonicalDeclarationJson, declarationDigest, DECLARATION_TRUST_STATES,
  isDeclarationTrustState, reviewMonotonicity, evaluateDeclarationTrust,
  shouldInjectDeclaration, declarationInjectionVerdict, declarationTrustKey,
  subjectDigest, evaluateSubjectTrust
} = pure;

const {
  setDeclarationTrustUserDataDir, declarationTrustFilePath, readDeclarationTrustBook,
  putDeclarationTrustRecord, evaluateDeclarationGate, filterInjectableDeclarations,
  registerPendingDeclarations, applyDeclarationReview
} = await import(pathToFileURL(compile('main/agent/declarationTrustStore.ts')).href);

const {
  injectionRegistrySubjects, hostFragmentSubjects, phaseOneDeclarationSubjects,
  evaluatePhaseOneGate, filterInjectablePhaseOne, registerPendingPhaseOne
} = await import(pathToFileURL(compile('main/agent/declarationTrustSources.ts')).href);

const registry = await import(pathToFileURL(compile('main/agent/injection-registry.ts')).href);

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
};

// ── 1) 纯函数 ─────────────────────────────────────────────────────────────

check('sha256 已知向量（FIPS abc/空串）', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

check('同内容同 digest（key 排序）+ 改字节 digest 变', () => {
  assert.equal(declarationDigest('hello 声明'), declarationDigest('hello 声明'));
  assert.equal(declarationDigest({ a: 1, b: 'x' }), declarationDigest({ b: 'x', a: 1 }));
  assert.notEqual(declarationDigest('hello'), declarationDigest('hellp'));
  assert.notEqual(declarationDigest({ a: 1 }), declarationDigest({ a: 2 }));
  assert.equal(canonicalDeclarationJson({ b: 1, a: { d: 2, c: 3 } }), canonicalDeclarationJson({ a: { c: 3, d: 2 }, b: 1 }));
  assert.equal(canonicalDeclarationJson({ a: [1, 2], b: undefined }), '{"a":[1,2]}');
  assert.notEqual(canonicalDeclarationJson({ a: [1, 2] }), canonicalDeclarationJson({ a: [2, 1] }));
});

check('七态枚举合法 + isDeclarationTrustState', () => {
  const expected = ['pending_trust', 'trusted_persistent', 'blocked_untrusted', 'blocked_policy', 'revoked', 'stale_digest'];
  assert.deepEqual([...DECLARATION_TRUST_STATES], expected);
  for (const s of expected) assert.equal(isDeclarationTrustState(s), true);
  assert.equal(isDeclarationTrustState('trusted_once'), false);
  assert.equal(isDeclarationTrustState(null), false);
});

check('reviewMonotonicity 单调表驱动（gen → interactionId → flowId）', () => {
  const ref = (gen, interactionId, flow) => ({ reviewFlowId: flow, generation: gen, interactionId });
  const cases = [
    [null, ref(1, 'a', 'f1'), true], [undefined, ref(0, 'z', 'f9'), true],
    [ref(1, 'a', 'f1'), ref(1, 'a', 'f1'), false],
    [ref(1, 'a', 'f1'), ref(2, 'a', 'f1'), true], [ref(2, 'a', 'f1'), ref(1, 'b', 'f9'), false],
    [ref(1, 'a', 'f1'), ref(1, 'b', 'f1'), true], [ref(1, 'b', 'f1'), ref(1, 'a', 'f9'), false],
    [ref(1, 'a', 'f1'), ref(1, 'a', 'f2'), true], [ref(1, 'a', 'f2'), ref(1, 'a', 'f1'), false]
  ];
  for (const [cur, inc, expect] of cases) {
    assert.equal(reviewMonotonicity(cur, inc), expect, `monotonicity ${JSON.stringify(cur)} → ${JSON.stringify(inc)}`);
  }
});

check('注入门：仅 trusted_persistent 放行', () => {
  assert.equal(shouldInjectDeclaration('trusted_persistent'), true);
  for (const s of ['pending_trust', 'blocked_untrusted', 'blocked_policy', 'revoked', 'stale_digest']) {
    assert.equal(shouldInjectDeclaration(s), false, `${s} 不得注入`);
  }
});

check('evaluateDeclarationTrust：命中 trusted / 兄弟 stale / 首见 pending', () => {
  const rec = (state) => ({ grantedAt: 1, event: 'e', displayCommand: 'cmd', sourcePath: 'src:A', state });
  const records = [{ digest: 'd-old', record: rec('trusted_persistent') }, { digest: 'd-other', record: rec('blocked_untrusted') }];
  assert.equal(evaluateDeclarationTrust({ currentDigest: 'd-old', records, sourcePath: 'src:A', displayCommand: 'cmd' }), 'trusted_persistent');
  assert.equal(evaluateDeclarationTrust({ currentDigest: 'd-new', records, sourcePath: 'src:A', displayCommand: 'cmd' }), 'stale_digest');
  assert.equal(evaluateDeclarationTrust({ currentDigest: 'd-x', records: [], sourcePath: 'src:B', displayCommand: 'other' }), 'pending_trust');
  const v = declarationInjectionVerdict({ currentDigest: 'd-new', records, sourcePath: 'src:A', displayCommand: 'cmd' });
  assert.deepEqual([v.state, v.inject, v.digest], ['stale_digest', false, 'd-new']);
});

check('declarationTrustKey 复合键 + subjectDigest/evaluateSubjectTrust', () => {
  assert.equal(declarationTrustKey('ws', 'dg'), 'ws\u0000dg');
  assert.notEqual(declarationTrustKey('ws-a', 'x'), declarationTrustKey('ws-b', 'x'));
  const subject = { id: 's1', sourcePath: 'src', displayCommand: 'cmd', content: { a: 1 } };
  assert.equal(subjectDigest(subject), declarationDigest({ a: 1 }));
  const v = evaluateSubjectTrust(subject, []);
  assert.deepEqual([v.state, v.inject], ['pending_trust', false]);
});

// ── 2) DeclarationTrustStore ──────────────────────────────────────────────

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'declaration-trust-ud-'));
setDeclarationTrustUserDataDir(userData);

check('store 路径：userData/declaration-trust/<workspaceId>.json', () => {
  assert.equal(declarationTrustFilePath('ws-1'), path.join(userData, 'declaration-trust', 'ws-1.json'));
  assert.notEqual(declarationTrustFilePath('team/a'), declarationTrustFilePath('team\\a'), '工作区别名必须使用稳定 hash，不能折叠到同一账本');
});

check('未信任不注入 → 信任后注入 → 改内容回 stale', () => {
  const ws = 'ws-gate';
  const identity = 'E:/proj';
  const subjectV1 = { id: 'worker.host-md.protocol', sourcePath: 'src/main/agent/injection-registry.ts', displayCommand: 'injection:worker.host-md.protocol', content: { note: 'HOST 协议 v1' } };
  const subjectV2 = { ...subjectV1, content: { note: 'HOST 协议 v2!' } };

  let gate = evaluateDeclarationGate(ws, identity, [subjectV1]);
  assert.deepEqual([gate[0].state, gate[0].inject], ['pending_trust', false]);

  assert.equal(applyDeclarationReview({ workspaceId: ws, workspaceIdentity: identity, subject: subjectV1, state: 'trusted_persistent', event: 'grant_persistent' }), true);
  gate = evaluateDeclarationGate(ws, identity, [subjectV1]);
  assert.deepEqual([gate[0].state, gate[0].inject], ['trusted_persistent', true]);

  gate = evaluateDeclarationGate(ws, identity, [subjectV2]);
  assert.notEqual(gate[0].digest, subjectDigest(subjectV1));
  assert.deepEqual([gate[0].state, gate[0].inject], ['stale_digest', false]);

  gate = evaluateDeclarationGate(ws, identity, [subjectV1]);
  assert.equal(gate[0].digest, subjectDigest(subjectV1));
  assert.equal(gate[0].inject, true);
  assert.deepEqual(filterInjectableDeclarations(ws, identity, [subjectV1, subjectV2]), [subjectV1]);
});

check('key=(workspaceIdentity,digest)：同 digest 不同 identity 独立账目', () => {
  const ws = 'ws-key';
  const subject = { id: 'scheduler.system.stable-body', sourcePath: 'src/main/agent/injection-registry.ts', displayCommand: 'injection:scheduler.system.stable-body', content: 'shared-body' };
  applyDeclarationReview({ workspaceId: ws, workspaceIdentity: 'E:/a', subject, state: 'trusted_persistent', event: 'grant_persistent' });
  assert.equal(evaluateDeclarationGate(ws, 'E:/a', [subject])[0].inject, true);
  assert.deepEqual([evaluateDeclarationGate(ws, 'E:/b', [subject])[0].state, evaluateDeclarationGate(ws, 'E:/b', [subject])[0].inject], ['pending_trust', false]);
});

check('putRecord 尊重 reviewMonotonicity（非严格更大拒写）', () => {
  const ws = 'ws-review';
  const identity = 'E:/rev';
  const digest = declarationDigest('rev-content');
  const base = { grantedAt: Date.now(), displayCommand: 'cmd', sourcePath: 'src:rev' };
  assert.equal(putDeclarationTrustRecord(ws, identity, digest, { ...base, event: 'grant_persistent', state: 'trusted_persistent', review: { reviewFlowId: 'f1', generation: 2, interactionId: 'i1' } }), true);
  assert.equal(putDeclarationTrustRecord(ws, identity, digest, { ...base, event: 'revoked', state: 'revoked', review: { reviewFlowId: 'f9', generation: 1, interactionId: 'i9' } }), false, '更小 generation 拒写');
  assert.equal(putDeclarationTrustRecord(ws, identity, digest, { ...base, event: 'revoked', state: 'revoked', review: { reviewFlowId: 'f0', generation: 2, interactionId: 'i1' } }), false, '同 gen+interaction + 更小 flowId 拒写');
  assert.equal(readDeclarationTrustBook(ws).entries[declarationTrustKey(identity, digest)].state, 'trusted_persistent');
  assert.equal(putDeclarationTrustRecord(ws, identity, digest, { ...base, event: 'revoked', state: 'revoked', review: { reviewFlowId: 'f1', generation: 3, interactionId: 'i0' } }), true, '更大 generation 覆盖');
  assert.equal(readDeclarationTrustBook(ws).entries[declarationTrustKey(identity, digest)].state, 'revoked');
});

check('盘上账本可解析（原子写 JSON 真源）', () => {
  const ws = 'ws-disk';
  applyDeclarationReview({ workspaceId: ws, workspaceIdentity: 'E:/disk', subject: { id: 's', sourcePath: 'p', displayCommand: 'c', content: 'x' }, state: 'trusted_persistent', event: 'grant_persistent' });
  const p = declarationTrustFilePath(ws);
  assert.ok(fs.existsSync(p));
  const book = readDeclarationTrustBook(ws);
  assert.equal(book.schemaVersion, 1);
  assert.equal(book.entries[declarationTrustKey('E:/disk', declarationDigest('x'))].state, 'trusted_persistent');
  assert.equal(book.entries[declarationTrustKey('E:/disk', declarationDigest('x'))].displayCommand, 'c');
});

check('registerPending：首见落 pending；内容变不落账保 stale', () => {
  const ws = 'ws-pending';
  const identity = 'E:/pend';
  const v1 = { id: 's', sourcePath: 'src:s', displayCommand: 'cmd', content: 'body-v1' };
  const v2 = { ...v1, content: 'body-v2' };
  assert.equal(registerPendingDeclarations(ws, identity, [v1]), 1);
  assert.equal(evaluateDeclarationGate(ws, identity, [v1])[0].state, 'pending_trust');
  assert.equal(registerPendingDeclarations(ws, identity, [v1]), 0);
  applyDeclarationReview({ workspaceId: ws, workspaceIdentity: identity, subject: v1, state: 'trusted_persistent', event: 'grant_persistent' });
  assert.equal(registerPendingDeclarations(ws, identity, [v2]), 0);
  assert.deepEqual([evaluateDeclarationGate(ws, identity, [v2])[0].state, evaluateDeclarationGate(ws, identity, [v2])[0].inject], ['stale_digest', false]);
});

// ── 3) 一期接线：injection-registry 注入源 + HOST/HOST-EXT ────────────────

check('registry 查找口 + 一期主体构造', () => {
  assert.ok(registry.getInjectionSource('worker.turn-prefix.cli-host'));
  assert.equal(registry.getInjectionSource('no-such-id'), undefined);
  const regSubjects = injectionRegistrySubjects();
  assert.ok(regSubjects.length >= 10);
  assert.ok(regSubjects.every((s) => s.sourcePath === 'src/main/agent/injection-registry.ts'));
  assert.ok(regSubjects.every((s) => s.displayCommand.startsWith('injection:')));
  const hostSubjects = hostFragmentSubjects();
  assert.equal(hostSubjects.length, 1);
  assert.ok(hostSubjects.some((s) => s.displayCommand === 'host-fragment:CLI intro'));
  assert.equal(phaseOneDeclarationSubjects().length, regSubjects.length + 1);
});

check('一期注入门：未信任不注入、信任后注入、改内容 stale', () => {
  const ws = 'ws-phase1';
  const identity = 'E:/phase1';

  let gate = evaluatePhaseOneGate(ws, identity);
  assert.ok(gate.length > 0);
  assert.ok(gate.every((g) => g.inject === false));
  assert.deepEqual(filterInjectablePhaseOne(ws, identity), []);

  assert.ok(registerPendingPhaseOne(ws, identity) > 0);
  gate = evaluatePhaseOneGate(ws, identity);
  assert.ok(gate.every((g) => g.state === 'pending_trust' && g.inject === false));

  const host = hostFragmentSubjects().find((s) => s.displayCommand === 'host-fragment:CLI intro');
  assert.equal(applyDeclarationReview({ workspaceId: ws, workspaceIdentity: identity, subject: host, state: 'trusted_persistent', event: 'grant_persistent' }), true);
  gate = evaluatePhaseOneGate(ws, identity);
  const hostGate = gate.find((g) => g.subject.id === host.id);
  assert.deepEqual([hostGate.state, hostGate.inject], ['trusted_persistent', true]);
  assert.ok(gate.filter((g) => g.subject.id !== host.id).every((g) => g.inject === false));
  const injectable = filterInjectablePhaseOne(ws, identity);
  assert.deepEqual(injectable.map((s) => s.id), [host.id]);

  const hostChanged = { ...host, content: `${String(host.content)}\n# v2` };
  const changedGate = evaluateDeclarationGate(ws, identity, [hostChanged]);
  assert.notEqual(changedGate[0].digest, subjectDigest(host));
  assert.deepEqual([changedGate[0].state, changedGate[0].inject], ['stale_digest', false]);

  assert.equal(applyDeclarationReview({ workspaceId: ws, workspaceIdentity: identity, subject: hostChanged, state: 'trusted_persistent', event: 'grant_persistent' }), true);
  assert.equal(evaluateDeclarationGate(ws, identity, [hostChanged])[0].inject, true, '人审重新信任新 digest → 恢复注入');
});

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\nok: declaration-trust 全绿');

// ── 2026-09-27 复审回归（二轮）：digest 覆盖面 / 裁剪 / identity 归一 ──
{
  const bare = hostFragmentSubjects().find((s) => s.id === 'worker.cli-host-intro');
  const ruled = hostFragmentSubjects([{ id: 'r1', enabled: true, text: '每日站会前提醒我整理昨日进展' }])
    .find((s) => s.id === 'worker.cli-host-intro');
  assert.ok(bare && ruled, 'CLI intro subject exists');
  assert.match(String(ruled.content), /每日站会前提醒我整理昨日进展/);
  assert.notEqual(subjectDigest(bare), subjectDigest(ruled), 'configured rules change the digest');

  // 同主体被取代的旧 digest 裁到最新 3 条（批量 IO 路径顺带触发裁剪）
  const ws2 = 'ws-prune';
  const id2 = 'identity-prune';
  const subj = (n) => ({
    id: 'x',
    sourcePath: 'same.ts',
    displayCommand: 'same:cmd',
    content: `v${n}`
  });
  for (let n = 1; n <= 5; n++) {
    const s = subj(n);
    putDeclarationTrustRecord(ws2, id2, subjectDigest(s), {
      grantedAt: n * 1000,
      event: `grant_${n}`,
      displayCommand: s.displayCommand,
      sourcePath: s.sourcePath,
      state: 'trusted_persistent'
    });
  }
  const added = registerPendingDeclarations(ws2, id2, [subj(6)], 6_000);
  assert.equal(added, 0, '同主体已有其它 digest（内容变）→ 不落 pending，保持 stale 语义');
  const book = readDeclarationTrustBook(ws2);
  const keys = Object.keys(book.entries).filter((k) => k.startsWith(`${id2}\u0000`));
  assert.equal(keys.length, 3, `同主体被取代的旧 digest 裁到最新 3 条（实际 ${keys.length}）`);
  console.log('ok: 复审回归（digest 覆盖规约节 / 裁剪 keep-3）');
}
{
  // identity 归一：ensureForApp 的 workspaceIdentity 与账本文件名同用 pathKey（源码锚）
  const ensureSrc = fs.readFileSync(
    path.join(root, 'src', 'main', 'metaAgent', 'ensureForApp.ts'),
    'utf8'
  );
  assert.match(
    ensureSrc,
    /registerPendingPhaseOne\(pathKey\(root\), pathKey\(root\), ctx\.config\.get\(\)\.agentRules\)/,
    'identity 与 workspaceId 同用 pathKey 归一（大小写/分隔符混用不产生重复记录）'
  );
  console.log('ok: 复审回归（identity 归一锚）');
}
