/**
 * 通知合成 sessionId：点系统 toast 不得 sessions.select。
 * F-03：前缀白名单须覆盖 NotifyStore.push 全部实际合成形态（2026-10-25 全量盘点，
 * 见 src/shared/notifySession.ts 头注「合成形态全表」）；真实会话 id（randomUUID）
 * 不受影响；ipc.ts 的 sessions.get 存在性检查是点击兜底，这里锁前缀合同本身。
 * 运行: node test/notify-session.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'src', 'shared', 'notifySession.ts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-session-'));
const out = path.join(tmp, 'notifySession.mjs');
const { outputText } = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: entry
});
fs.writeFileSync(out, outputText, 'utf8');
const { isSyntheticNotifySessionId, shouldSelectNotifySession } = await import(pathToFileURL(out));

/** 全部合成形态（与 notifySession.ts 头注一一对应；新增合成 id 时两处同步加） */
const SYNTHETIC_IDS = [
  'notify:ws-1',
  'notify:composer:ws-1',
  'ext:build-package',
  'task:abc',
  'orchestrator:ws-1',
  'updater:app',
  'shell:env',
  'extension:startup',
  'app-instance:pid-1',
  'renderer-error:panel',
  'delegate-queue:queue-1',
  'app',
  'memory'
];

for (const sid of SYNTHETIC_IDS) {
  assert.equal(
    shouldSelectNotifySession(sid),
    false,
    `合成 id「${sid}」不得选中会话（F-03：前缀合同完备）`
  );
  assert.equal(isSyntheticNotifySessionId(sid), true, `合成 id「${sid}」应识别为合成`);
}

// 旧基线用例保留（逐字面校验几个代表形态）
assert.equal(shouldSelectNotifySession('ext:build-package'), false, '扩展通知不选会话');
assert.equal(shouldSelectNotifySession('notify:ws-1'), false);
assert.equal(shouldSelectNotifySession('task:abc'), false);
assert.equal(shouldSelectNotifySession('orchestrator:ws-1'), false);
assert.equal(shouldSelectNotifySession(''), false);
assert.equal(shouldSelectNotifySession(undefined), false);
assert.equal(shouldSelectNotifySession('  '), false);

// 带前后空白的合成形态同样拦下
assert.equal(isSyntheticNotifySessionId('  app  '), true, '裸词合成 id 含空白仍识别');
assert.equal(isSyntheticNotifySessionId(' shell:env '), true, '带空白的合成 id 仍识别');

const real = '2c1f0a0e-1111-4222-8333-444444444444';
assert.equal(shouldSelectNotifySession(real), true, '真实 UUID 会话 id 不被合成前缀误伤');
assert.equal(isSyntheticNotifySessionId(real), false);
assert.equal(isSyntheticNotifySessionId('ext:build-package'), true);
// 相似但非合成的真实形态不误伤：合成词出现在中间/后缀不算
assert.equal(shouldSelectNotifySession('memory-tool-abc-1234-5678-9abc'), true, '仅前缀匹配，中间出现合成词不误伤');
assert.equal(shouldSelectNotifySession('app'), false);
assert.equal(shouldSelectNotifySession('appx'), true, '裸词只精确匹配 app/memory，长词不误伤');

console.log('notify-session: ok');
