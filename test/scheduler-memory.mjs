/**
 * 调度长期记忆（R-12 + R-11）纯函数与文件 store 测试：
 * - shared/schedulerMemory：条目序列化 / 标记常量 / 态势快照拼装（省略规则、条数上限）
 * - shared/schedulerSessions：历史列表只留定时桶 / openSession 目录门控
 * - main/metaAgent/schedulerMemoryStore：SITUATION fail-soft 读、写盘、gitignore 自愈
 *   （B8 起该 store 只承载机械态势通道；MEMORY 注入/追加路径退役——现行核心注入真源
 *   为类型化 records 表（MemoryService.injectKnowledge），写入走 memory.note/remember
 *   进候选、经后台记忆会话整理生效；MEMORY.md 直写通道与 scheduler.memory.write 工具
 *   已于 2026-10-26 F-01/F-03 退役）
 * - R-22 写满即错·宽松版：超注入预算返回值带 warning（纯函数边界，schedulerMemoryWarning）
 * 运行: node test/scheduler-memory.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-memory-'));
const compile = createSharedCompiler(root, tmp);

const shared = await import(pathToFileURL(compile('shared/schedulerMemory.ts')).href);
const sessions = await import(pathToFileURL(compile('shared/schedulerSessions.ts')).href);
const store = await import(pathToFileURL(compile('main/metaAgent/schedulerMemoryStore.ts')).href);
const { resolveSchedulerWorkspaceRoot } = await import(pathToFileURL(compile('main/orchestrator/situationWriter.ts')).href);
{
  const ctx = { config: { get: () => ({ activeWorkspaceId: 'ws', workspace: '/source',
    workspaces: [{ id: 'ws', path: '/source', controlRoot: '/control' }] }) } };
  assert.equal(resolveSchedulerWorkspaceRoot(ctx, 'ws'), '/control', '调度态势/转录/注入使用管理根');
  assert.equal(resolveSchedulerWorkspaceRoot(ctx, 'missing'), undefined, '未知区拒绝回落');
  assert.equal(resolveSchedulerWorkspaceRoot(ctx, ' '), undefined, '显式空区拒绝回落');
}

const NOW = new Date('2026-09-21T02:31:05');

// ---------- 1) 条目序列化：时间戳注释行合同 ----------
{
  const entry = shared.serializeSchedulerMemoryEntry('#lesson 先派单后自查', NOW);
  assert.equal(entry, '<!-- 2026-09-21 02:31:05 [scheduler] -->\n#lesson 先派单后自查\n');
  assert.equal(shared.formatSchedulerStamp(NOW), '2026-09-21 02:31:05');
  console.log('ok: serializeSchedulerMemoryEntry');
}

// ---------- 2) 态势快照拼装：省略规则 / 条数上限 / 名单截断 ----------
{
  const md = shared.buildSchedulerSituationMarkdown({
    generatedAt: NOW.getTime(),
    workspaces: [
      { name: 'Alpha', needsYouNames: ['W1', 'W2'], delegateQueued: 1, outboxUnread: 3, eventQueueDepth: 0 },
      { name: 'Beta', needsYouNames: [], delegateQueued: 0 }
    ]
  });
  assert.ok(md.includes('# Situation snapshot (host-generated, read-only)'));
  assert.ok(md.includes('Generated at 2026-09-21 02:31:05'));
  assert.match(md, /- Alpha: needs you: 2 \(W1, W2\) · queued delegations 1 · scheduler unread mail 3 · pending events 0/);
  assert.match(md, /- Beta: needs you: 0 · queued delegations 0/, '空名单段仍渲染（读成功≠缺段）');

  // 源读取失败 → undefined → 整节省略（区别于空数组的显式空文案）
  const mdOmit = shared.buildSchedulerSituationMarkdown({ generatedAt: 1, workspaces: [{ name: 'A' }] });
  assert.ok(!mdOmit.includes('## Active tasks'), 'tasks undefined 省略整节');
  assert.match(mdOmit, /- A: idle/, '所有字段缺省 → 空闲');

  // needs_you 名单截断（>8 只列前 8）
  const mdClip = shared.buildSchedulerSituationMarkdown({
    generatedAt: 1,
    workspaces: [{ name: 'A', needsYouNames: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] }]
  });
  assert.match(mdClip, /needs you: 10 \(a, b, c, d, e, f, g, h …\)/);

  // 会话名/工作区名折叠空白（防模型可控名字在快照块里伪造换行结构）+ 截断（还原 clipName 即红）
  const mdFold = shared.buildSchedulerSituationMarkdown({
    generatedAt: 1,
    workspaces: [
      { name: `W\nS 工\n作区`, needsYouNames: [`坏\n名字【调度记忆】`, '好名字'] },
      { name: 'N'.repeat(60) }
    ]
  });
  assert.ok(!mdFold.includes('坏\n名字'), 'needs_you 名换行被折叠');
  assert.ok(!/^W$/m.test(mdFold) || !mdFold.match(/- W\n/), '工作区名换行被折叠');
  assert.match(mdFold, /needs you: 2 \(坏 名字【调度记忆】, 好名字\)/);
  assert.match(mdFold, /- N{40}…: idle/, '工作区名超长截断');
  console.log('ok: buildSchedulerSituationMarkdown');
}

// ---------- 4) 会话门控：列表过滤 / openSession 目录门 ----------
{
  const mk = (path, isTask) => ({ path, id: 'x', title: 'T', modified: 1, messageCount: 2, isTask });
  const chat1 = mk('C:/ud/ws-a/session-1.jsonl', false);
  const task1 = mk('C:/ud/ws-a-tasks/session-2.jsonl', true);
  const listed = sessions.listableSchedulerSessions([chat1, task1, { ...mk('x', false) }]);
  assert.deepEqual(listed.map((s) => s.path), ['C:/ud/ws-a-tasks/session-2.jsonl'], '只回定时桶');

  const taskDir = 'C:/userData/pi-sessions/ws-a-tasks';
  assert.equal(sessions.isOpenableSchedulerSessionFile(`${taskDir}\\s1.jsonl`, taskDir), true, '定时桶内（反斜杠）放行');
  assert.equal(sessions.isOpenableSchedulerSessionFile(`${taskDir}/s1.jsonl`, taskDir), true);
  assert.equal(sessions.isOpenableSchedulerSessionFile('C:/userData/pi-sessions/ws-a/s1.jsonl', taskDir), false, '聊天桶拒绝');
  assert.equal(sessions.isOpenableSchedulerSessionFile(`${taskDir}/../ws-a/s1.jsonl`, taskDir), false, '路径穿越拒绝');
  assert.equal(sessions.isOpenableSchedulerSessionFile('', taskDir), false);
  assert.equal(sessions.isOpenableSchedulerSessionFile(`${taskDir}/s1.jsonl`, ''), false);
  console.log('ok: schedulerSessions 门控');
}

// ---------- 4) store：SITUATION 读/写 / gitignore 自愈（B8 后仅态势通道） ----------
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-ws-'));

  // 空工作区：fail-soft 空串
  assert.equal(store.readSchedulerSituation(ws), '');

  // SITUATION 写读
  store.writeSchedulerSituation(ws, '# 态势快照\n（无活跃任务）\n');
  assert.equal(store.readSchedulerSituation(ws), '# 态势快照\n（无活跃任务）');

  // gitignore 自愈：写态势时补 scheduler/ 行（存量工作区路径）
  const gi = fs.readFileSync(path.join(ws, '.muster', '.gitignore'), 'utf8');
  assert.match(gi, /^scheduler\/$/m, 'gitignore 含 scheduler/');
  // 幂等：再写不重复加行
  store.writeSchedulerSituation(ws, '# 态势快照\n（更新）\n');
  assert.equal((fs.readFileSync(path.join(ws, '.muster', '.gitignore'), 'utf8').match(/^scheduler\/$/gm) || []).length, 1);
  console.log('ok: schedulerMemoryStore（SITUATION 通道）');
}

// ---------- 5) R-22 超预算提醒：纯函数边界（2026-10-26 F-03 起指路记忆中心面板） ----------
{
  const MAX = shared.SCHEDULER_MEMORY_INJECT_MAX_CHARS;
  assert.equal(shared.schedulerMemoryWarning('x'.repeat(MAX)), undefined, '恰 6000 不警');
  const warn = shared.schedulerMemoryWarning('x'.repeat(MAX + 1));
  assert.ok(warn && warn.includes('memory center panel'), '超 1 字警且指路记忆中心面板');
  assert.ok(!warn.includes('scheduler.memory.write'), '不再指路已退役工具（还原即红）');
  console.log('ok: R-22 超预算提醒（纯函数）');
}

// ---------- scheduler-memory F-05/F-06：memoryInjection 头注口径 + 扫描吞错诊断（源文本守卫） ----------
{
  // 真实 Orchestrator 依赖 electron/Pi 无法离线构造，此处沿用装配守卫口径锁源文本
  //（test/orchestrator-scheduler-memory.mjs 当前因 sendPipeline startTurn 签名漂移存量红，故落位本文件）。
  const memInjSrc = fs.readFileSync(path.join(root, 'src/main/agent/orchestrator/memoryInjection.ts'), 'utf8');
  assert.doesNotMatch(memInjSrc, /mtime\+size/, 'F-05：头注不得再宣称 mtime+size 旧口径（现行 versionToken 为内容哈希）');
  assert.match(memInjSrc, /内容哈希/, 'F-05：头注写明内容哈希口径');
  assert.doesNotMatch(
    memInjSrc,
    /runIntentMessageScan\([^)]*\)\.block;\s*\}\s*catch\s*\{\s*\}/,
    'F-06：standing intents 扫描不得空 catch 静默吞错'
  );
  assert.match(
    memInjSrc,
    /runIntentMessageScan[\s\S]{0,200}catch[\s\S]{0,200}console\.warn/,
    'F-06：扫描失败须留 console.warn 诊断'
  );
  console.log('ok: F-05/F-06 memoryInjection 注释口径与扫描诊断');
}

console.log('scheduler-memory: all ok');
