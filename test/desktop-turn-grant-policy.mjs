/**
 * 桌面写动作的审批叠加：policy 必须认 turnGrant。
 *
 * 背景：desktop.act/focus/launch 的权限档从 read 提到 edit 后，policy 会对每次调用
 * 返回 prompt；而桌面后端自己的 turnGrant 是「一次授权覆盖该回合 30 分钟」。
 * 两层叠加会让技能文档承诺的 30 分钟复用失效，并出现「先审批卡、再桌面授权卡」。
 *
 * 本测试钉住：turnGrant 有效时 policy 把 prompt 降为 auto；无效时仍 prompt；
 * 只读门（plan）的 deny 不被越过；run 入口形态同样生效。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-turn-grant-'));
const compile = createSharedCompiler(root, temporary);
const load = (file) => import(pathToFileURL(compile(file)).href);

try {
  const { decideToolCallPermission } = await load('main/agentSession/tools/policy.ts');
  const { desktopTurnGrants } = await load('main/desktop/turnGrant.ts');

  const hostToolIds = ['desktop.act', 'desktop.focus', 'desktop.launch', 'desktop.list', 'desktop.look', 'desktop.run'];
  const hostClassOf = (id) => (id === 'desktop.act' || id === 'desktop.focus' || id === 'desktop.launch' || id === 'desktop.run' ? 'edit'
    : id === 'desktop.list' || id === 'desktop.look' ? 'read' : 'status');
  const base = (sessionId, engineToolName, input, mode = 'default') => ({
    mode, planExecuting: false, engineToolName, input, cwd: root, sessionId,
    hostToolIds, hostClassOf, userRules: []
  });
  const actArgs = { action: 'click', surfaceId: 'display-1', target: { windowId: 'w1', x: 10, y: 20 }, requestId: 'req-1' };

  // 1) 未授权：default 模式必须问（这是 edit 档的基线行为）。
  assert.equal(decideToolCallPermission(base('grant-none', 'desktop.act', actArgs)).decision, 'prompt',
    'without a turn grant, desktop.act still asks');

  // 2) 授权后：同一调用降为 auto，不再叠加第二张卡。
  const session = 'grant-yes';
  await desktopTurnGrants.authorize(session, () => true, async () => true, () => {});
  assert.equal(decideToolCallPermission(base(session, 'desktop.act', actArgs)).decision, 'auto',
    'an active turn grant satisfies the tool approval');
  assert.equal(decideToolCallPermission(base(session, 'desktop.focus', { surfaceId: 'w1', requestId: 'req-2' })).decision, 'auto',
    'focus is covered by the same grant');
  assert.equal(decideToolCallPermission(base(session, 'desktop.launch', { appId: 'C:\\app.exe', requestId: 'req-3' })).decision, 'auto',
    'launch is covered by the same grant');

  // 3) 只读门（plan）的 deny 不被授权越过。
  assert.equal(decideToolCallPermission(base(session, 'desktop.act', actArgs, 'plan')).decision, 'deny',
    'plan mode still denies desktop writes even with a grant');

  // 4) run 入口形态：desktop.run(action=act) 展开后命中同一判定。
  assert.equal(decideToolCallPermission(base(session, 'desktop.run', { action: 'act', params: actArgs })).decision, 'auto',
    'the run shell is satisfied by the grant as well');
  assert.equal(decideToolCallPermission(base('grant-none', 'desktop.run', { action: 'act', params: actArgs })).decision, 'prompt',
    'the run shell still asks without a grant');

  // 5) 新的用户消息撤销授权：回到 prompt。
  desktopTurnGrants.nextUserMessage(session);
  assert.equal(decideToolCallPermission(base(session, 'desktop.act', actArgs)).decision, 'prompt',
    'a new user message revokes the grant for policy as well');

  console.log('desktop-turn-grant-policy: OK (grant satisfies tool approval, plan deny preserved, run shell covered, user message revokes)');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
