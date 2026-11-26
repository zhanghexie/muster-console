/**
 * AgentSessionHost 拆分纯函数单测（2026-09-26 host.ts → host/ 拆分的回归锁）：
 * - migrateMode：旧 permissionMode 会话迁移（acceptEdits 必须迁 default，不得升 auto）
 * - forkTranscriptFromSeeds：fork transcript 前缀格式与截断（发给 LLM 的上下文协议）
 * - reorderQueueItems：排队重排（目标序 + 未覆盖 id 保序追加 + 无变化返回 null）
 * - resolveConnectionModel：连接生效模型与缓存键（键错=切模型误判重建/漏重建）
 * 运行: node test/host-split-pure.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const Module = require('module');

// .ts 即时转译（CJS）+ electron stub：与 gui-host-lifecycle 同一套路
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
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => os.tmpdir(), isReady: () => true },
      ipcMain: { handle: () => {}, on: () => {} }
    };
  }
  return origLoad.apply(this, arguments);
};

const internal = require(path.join(root, 'src/main/agentSession/host/internal.ts'));
const sessionOps = require(path.join(root, 'src/main/agentSession/host/sessionOps.ts'));
const connection = require(path.join(root, 'src/main/agentSession/host/connection.ts'));

// ---------- migrateMode：旧数据迁移（guiMode 缺失时按 permissionMode） ----------
{
  const meta = (over) => ({
    id: 's1',
    name: 's1',
    runtime: 'pi',
    type: 'terminal',
    cwd: '',
    ...over
  });
  assert.equal(internal.migrateMode(meta({ guiMode: 'ask', permissionMode: 'auto' }), 'auto'), 'ask', '显式 guiMode 优先');
  assert.equal(internal.migrateMode(meta({ permissionMode: 'ask' }), 'auto'), 'ask');
  assert.equal(internal.migrateMode(meta({ permissionMode: 'auto' }), 'default'), 'auto');
  assert.equal(
    internal.migrateMode(meta({ permissionMode: 'acceptEdits' }), 'auto'),
    'default',
    'acceptEdits 迁 default——不得掉进 fallback 升成 auto（权限静默升级）'
  );
  assert.equal(internal.migrateMode(meta({}), 'auto'), 'auto', '无旧档 → fallback');
  assert.equal(internal.migrateMode(meta({}), 'default'), 'default');
}

// ---------- forkTranscriptFromSeeds：格式与截断（LLM 上下文协议，勿改字面） ----------
{
  const t = (s) => sessionOps.forkTranscriptFromSeeds(s);
  const out = t([
    { role: 'user', text: '第一句' },
    { role: 'assistant', text: '第一答' },
    { role: 'user', text: '第二句' }
  ]);
  assert.match(out, /^\[本会话 fork 自另一会话，以下是先前的对话记录，仅作上下文参考\]\n/, '前缀行原样');
  assert.match(out, /【用户】第一句\n\n【助手】第一答\n\n【用户】第二句$/, '角色标注与双换行拼接');

  const long = 'x'.repeat(internal.FORK_TRANSCRIPT_MAX + 10);
  const truncated = t([{ role: 'user', text: long }]);
  const prefix = '[本会话 fork 自另一会话，以下是先前的对话记录，仅作上下文参考]\n';
  // body = 【用户】(4 字符) + x…（标签计入总长，截断含标签共 MAX 字符）
  assert.equal(
    truncated,
    `${prefix}【用户】${'x'.repeat(internal.FORK_TRANSCRIPT_MAX - 4)}\n…（过长已截断）`,
    '超长 body 截到 FORK_TRANSCRIPT_MAX 并加截断标记'
  );
}

// ---------- reorderQueueItems：排队重排（纯函数） ----------
{
  const q = (id) => ({ messageId: id, text: `t-${id}` });
  const reorder = sessionOps.reorderQueueItems;
  const [c, a, b] = [q('c'), q('a'), q('b')];

  assert.deepEqual(reorder([a, b, c], ['c', 'a']), [c, a, b], '目标序生效，未覆盖 id（b）保序追加尾部');
  assert.equal(reorder([a, b, c], ['a', 'b', 'c']), null, '顺序无变化 → null（免落盘/推送）');
  assert.equal(reorder([a, b, c], ['x', 'a']), null, '未知 id 被忽略且结果与原序一致 → null');
  assert.equal(reorder([a, b, c], []), null, '空 ids → 原序不变（无变化返回 null，不丢消息）');
  assert.deepEqual(
    reorder([a, b, c], ['c', 'c', 'b']),
    [c, b, a],
    '重复 id 只认领一次，剩余（a）保序追加尾部'
  );
}

// ---------- resolveConnectionModel：生效模型与连接键（缓存键语义） ----------
{
  const LLM = { provider: { id: 'p1' }, model: { id: 'm1' } };
  const resolve = (over = {}) =>
    connection.resolveConnectionModel({
      runtimeId: 'pi',
      session: undefined,
      llmNow: LLM,
      resolvedMode: null,
      ...over
    });

  // 默认（pi 无覆盖无模式）：全局激活
  assert.deepEqual(resolve().effModel, { providerId: 'p1', modelId: 'm1' });
  assert.equal(resolve().modelKey, 'p1/m1');

  // 会话覆盖最优先
  const ov = resolve({
    session: { modelOverride: { providerId: 'ovp', modelId: 'ovm' } }
  });
  assert.deepEqual(ov.effModel, { providerId: 'ovp', modelId: 'ovm' });
  assert.equal(ov.modelKey, 'ovp/ovm');

  // claude 恒定；Codex 默认走 CLI，显式覆盖进入键；两者都不吃全局 llm
  assert.deepEqual(resolve({ runtimeId: 'claude' }).effModel, { providerId: 'claude', modelId: '' });
  assert.equal(resolve({ runtimeId: 'claude' }).modelKey, 'claude/');
  assert.deepEqual(resolve({ runtimeId: 'codex-gui' }).effModel, { providerId: 'codex-gui', modelId: '' });
  const codex = resolve({ runtimeId: 'codex-gui', session: { modelOverride: { providerId: 'codex-gui', modelId: 'chosen' } } });
  assert.deepEqual(codex.effModel, { providerId: 'codex-gui', modelId: 'chosen' });
  assert.equal(codex.modelKey, 'codex-gui/chosen', '会话覆盖改变连接键，下回合重连');
  assert.equal(resolve({ runtimeId: 'codex-gui', cfg: { llm: { activeModelId: 'unrelated' } } }).modelKey, 'codex-gui/', '切工作台全局模型不影响 Codex');

  // Cursor now uses an ACP preset identity and the selected ACP model.
  const cursor = resolve({ runtimeId: 'acp', session: { piModeId: 'cursor', modelOverride: { providerId: 'acp', modelId: 'composer-2.5' } } });
  assert.deepEqual(cursor.effModel, { providerId: 'acp', modelId: 'composer-2.5' });
  assert.equal(cursor.modelKey, JSON.stringify(['acp', 'cursor', 'composer-2.5']));
  assert.deepEqual(resolve({ runtimeId: 'acp' }).effModel, { providerId: 'acp', modelId: '' });

  // 模式钉住（connectExtras.modelOverride）：缺哪侧回落哪侧
  const pinned = resolve({
    resolvedMode: { connectExtras: { modelOverride: { providerId: 'mvp', modelId: '' } } }
  });
  assert.deepEqual(pinned.effModel, { providerId: 'mvp', modelId: 'm1' });


}

console.log('host-split-pure: ok (4 组纯函数)');
