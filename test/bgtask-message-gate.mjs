/**
 * 后台子代理消息整包的订阅门控自测（2026-09-14 性能专项回归）。
 *
 * `task-messages` 的 payload 是全量 GuiChatMessage[]（含工具卡与工具输出，与主聊天
 * sync 同构、真机单会话可到 2.93MB），而渲染层只有 BgTasksPanel 挂载时才消费它——
 * 面板关着推的每一包都是白扔（且 send 无条件走 webContents）。故按会话门控。
 *
 * 运行: node test/bgtask-message-gate.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const managerSrc = fs.readFileSync(
  path.join(root, 'src/main/agentSession/background/manager.ts'),
  'utf8'
);

// ---------- 1. 门控逻辑：复刻 pushMessages 的判定，验证行为 ----------
{
  // 从源码里取出门控那一行，确保测的是真实实现而不是我复述的版本
  assert.match(
    managerSrc,
    /if \(!this\.messageSubs\.has\(task\.parentSessionId\)\) return;/,
    'pushMessages 必须按父会话门控'
  );

  // 行为模型：订阅集 + 门控判定
  const subs = new Set();
  const sent = [];
  const setSubscribed = (sessionId, on) => {
    const id = String(sessionId ?? '');
    if (!id) return;
    if (on) subs.add(id);
    else subs.delete(id);
  };
  const pushMessages = (sessionId) => {
    if (!subs.has(sessionId)) return;
    sent.push(sessionId);
  };

  pushMessages('s1');
  assert.equal(sent.length, 0, '未订阅时不得推整包');

  setSubscribed('s1', true);
  pushMessages('s1');
  pushMessages('s2');
  assert.deepEqual(sent, ['s1'], '只推订阅了的会话');

  setSubscribed('s1', false);
  pushMessages('s1');
  assert.deepEqual(sent, ['s1'], '退订后不再推');

  setSubscribed('', true);
  assert.equal(subs.size, 0, '空 sessionId 不得进订阅集');
}

// ---------- 2. 快照仍无条件推（胶囊要显示运行数/未读，不能被门控波及） ----------
{
  const snapAt = managerSrc.indexOf('private scheduleSnapshot');
  const snapBlock = managerSrc.slice(snapAt, snapAt + 400);
  assert.ok(snapAt > 0, 'scheduleSnapshot 应存在');
  assert.ok(
    !/messageSubs/.test(snapBlock),
    '任务列表快照不得被消息门控影响（面板关着也要显示运行数/未读）'
  );
  assert.match(snapBlock, /kind: 'snapshot'/, '快照推送保持原样');
}

// ---------- 3. 全链路接线：IPC / preload / hook / 面板 ----------
{
  const ipcSrc = fs.readFileSync(path.join(root, 'src/main/ipc/backgroundTasks.ts'), 'utf8');
  assert.match(ipcSrc, /bgTasks:subscribeMessages/, '应有订阅通道');
  assert.match(ipcSrc, /setMessagesSubscribed\(/, '通道应转调 manager');

  const preloadSrc = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8');
  assert.match(preloadSrc, /subscribeMessages: \(sessionId: string, on: boolean\)/, 'preload 应暴露订阅');

  const hookSrc = fs.readFileSync(
    path.join(root, 'src/renderer/src/agentChat/useBgTasks.ts'),
    'utf8'
  );
  assert.match(hookSrc, /wantMessages = true/, 'hook 应带 wantMessages 参数（默认真，兼容其他调用方）');
  assert.match(
    hookSrc,
    /subscribeMessages\(sessionId, true\)/,
    '面板挂载时订阅'
  );
  assert.match(
    hookSrc,
    /subscribeMessages\(sessionId, false\)/,
    '卸载时必须退订，否则门控形同虚设'
  );
  // 订阅时要补齐全量：关面板期间主进程没推，直接订阅会缺中间轮次
  assert.match(hookSrc, /bgTasks\.list\(sessionId\)\.then\(\(r\) => \{\s*if \(alive && r\?\.messages\)/, '订阅时应走 list 补齐当前全量');

  const areaSrc = fs.readFileSync(
    path.join(root, 'src/renderer/src/agentChat/BgTasksArea.tsx'),
    'utf8'
  );
  assert.match(
    areaSrc,
    /useBgTasks\(sessionId, presence\.mounted\)/,
    '订阅条件应是面板挂载态（presence.mounted，含退场动画期间）'
  );
  // hook 顺序：presence 必须先算出来
  assert.ok(
    areaSrc.indexOf('const presence = usePresence') < areaSrc.indexOf('useBgTasks(sessionId'),
    'usePresence 必须在 useBgTasks 之前调用'
  );
}

console.log('bgtask-message-gate: 3 组断言全过');
