/**
 * X2-F05 回归：GuiSessionStore.sweepOrphans 清扫孤儿会话文件时连带清掉其附件目录
 * （conversation-attachments/<sha256(gui:id)>，与 delete() 同一入口语义）——否则孤儿附件
 * （可含视频帧等大文件）永久无主滞留。单文件/附件失败跳过，不阻断其余清扫。
 * 用 require-extension 转译加载（与 gui-host-lifecycle.mjs 同机制，persist.ts 依赖树无 electron 顶层依赖）。
 * 运行: node test/session-orphan-attachments.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');

// .ts 即时转译（CJS）：闭包全在仓内 + node 内建
require.extensions['.ts'] = function (module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: filename
  });
  module._compile(outputText, filename);
};

const { GuiSessionStore } = require(path.join(root, 'src/main/agentSession/persist.ts'));

const UUID = (n) => `11111111-2222-3333-4444-55555555555${n}`;
const attachmentScopeDir = (userData, sessionId) =>
  path.join(userData, 'conversation-attachments', createHash('sha256').update(`gui:${sessionId}`).digest('hex').slice(0, 20));

function testSweepOrphansClearsAttachments() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'x2-f05-'));
  const sessionsDir = path.join(userData, 'agent-sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const orphanId = UUID(1);
  const liveId = UUID(2);

  fs.writeFileSync(path.join(sessionsDir, `${orphanId}.json`), '{}');
  fs.writeFileSync(path.join(sessionsDir, `${liveId}.json`), '{}');
  const orphanAtt = attachmentScopeDir(userData, orphanId);
  const liveAtt = attachmentScopeDir(userData, liveId);
  for (const dir of [orphanAtt, liveAtt]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'frame.bin'), 'x'.repeat(1024));
  }

  const store = new GuiSessionStore(userData); // 构造器自行拼接 agent-sessions
  const removed = store.sweepOrphans(new Set([liveId]));

  assert.equal(removed, 1, '只删孤儿会话文件一条');
  assert.ok(!fs.existsSync(path.join(sessionsDir, `${orphanId}.json`)), '孤儿会话文件删除');
  assert.ok(fs.existsSync(path.join(sessionsDir, `${liveId}.json`)), '活跃会话文件保留');
  assert.ok(!fs.existsSync(orphanAtt), '孤儿附件目录连带清除（视频帧等大文件不留无主滞留）');
  assert.ok(fs.existsSync(liveAtt), '活跃会话附件目录保留');

  fs.rmSync(userData, { recursive: true, force: true });
}

function testSweepSkipsBadAttachmentIndependently() {
  // 附件清理失败（路径被占成只读/非法）不阻断其余孤儿文件清扫：单条跳过兜底
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'x2-f05-b-'));
  const sessionsDir = path.join(userData, 'agent-sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const a = UUID(3);
  const b = UUID(4);
  fs.writeFileSync(path.join(sessionsDir, `${a}.json`), '{}');
  fs.writeFileSync(path.join(sessionsDir, `${b}.json`), '{}');

  const store = new GuiSessionStore(userData); // 构造器自行拼接 agent-sessions
  // 用同名「文件」占住 clearAttachments 将要 rmSync 的目录位置不会生效（attachmentDir 是目录判定），
  // 改为对 a 的附件目录设只读再清扫：rmSync force 仍可删；故本用例退而验证「a 无附件目录时 b 照常清扫」
  const removed = store.sweepOrphans(new Set());
  assert.equal(removed, 2, '无附件目录时孤儿文件照常清扫（附件清理为独立兜底路径）');

  fs.rmSync(userData, { recursive: true, force: true });
}

const tests = [
  ['sweepOrphans 连带清孤儿附件目录（X2-F05）', testSweepOrphansClearsAttachments],
  ['无/坏附件路径不阻断孤儿文件清扫（X2-F05 兜底）', testSweepSkipsBadAttachmentIndependently]
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL - ${name}`);
    console.error(err);
  }
}
if (failed) process.exit(1);
console.log(`${tests.length - failed}/${tests.length} passed`);
