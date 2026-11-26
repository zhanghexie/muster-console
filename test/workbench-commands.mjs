import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-commands-'));
const compileShared = createSharedCompiler(root, tmp);

const { parseWorkbenchCommand, formatHelpText, formatWorkspaceList, formatSessionList, formatDoneText, resolveListTarget } =
  await import(pathToFileURL(compileShared('shared/workbenchCommands.ts')).href);

assert.match(formatHelpText(), /Channel 对话.*\/bind/);
assert.doesNotMatch(formatHelpText(), /飞书|卡片|忙截图/);

// ---------- parseWorkbenchCommand ----------

assert.equal(parseWorkbenchCommand('帮助').type, 'help');
assert.equal(parseWorkbenchCommand('  help ').type, 'help');
assert.equal(parseWorkbenchCommand('/help').type, 'help');
assert.equal(parseWorkbenchCommand('工作区').type, 'workspaces');
assert.equal(parseWorkbenchCommand('ws').type, 'workspaces');
assert.equal(parseWorkbenchCommand('会话').type, 'sessions');
assert.equal(parseWorkbenchCommand('调度会话').type, 'sessions');
assert.equal(parseWorkbenchCommand('调度会话列表').type, 'sessions');
assert.equal(parseWorkbenchCommand('s').type, 'sessions');
assert.equal(parseWorkbenchCommand('新会话').type, 'newSession');
assert.equal(parseWorkbenchCommand('新调度会话').type, 'newSession');
assert.equal(parseWorkbenchCommand('/new').type, 'newSession');
assert.equal(parseWorkbenchCommand('工作会话').type, 'workSessions');
assert.equal(parseWorkbenchCommand('工作会话列表').type, 'workSessions');
assert.equal(parseWorkbenchCommand('/ts').type, 'workSessions');
assert.equal(parseWorkbenchCommand('状态').type, 'status');
assert.equal(parseWorkbenchCommand('停止').type, 'stop');
assert.equal(parseWorkbenchCommand('stop').type, 'stop');

assert.deepEqual(parseWorkbenchCommand('/'), { type: 'palette' });
assert.deepEqual(parseWorkbenchCommand('命令'), { type: 'palette' });
assert.deepEqual(parseWorkbenchCommand('/status'), { type: 'status', detail: 'brief' });
assert.deepEqual(parseWorkbenchCommand('/st'), { type: 'status', detail: 'brief' });
assert.deepEqual(parseWorkbenchCommand('/st v'), { type: 'status', detail: 'verbose' });
assert.deepEqual(parseWorkbenchCommand('/status verbose'), { type: 'status', detail: 'verbose' });
assert.deepEqual(parseWorkbenchCommand('/status 详细'), { type: 'status', detail: 'verbose' });
assert.deepEqual(parseWorkbenchCommand('状态 详细'), { type: 'status', detail: 'verbose' });
assert.equal(parseWorkbenchCommand('/s').type, 'sessions');
assert.equal(parseWorkbenchCommand('/stop').type, 'stop');
assert.deepEqual(parseWorkbenchCommand('/bind'), { type: 'bind', target: undefined });
assert.deepEqual(parseWorkbenchCommand('/bind 会话气泡'), { type: 'bind', target: '会话气泡' });
assert.deepEqual(parseWorkbenchCommand('绑定会话'), { type: 'bind', target: undefined });
assert.deepEqual(parseWorkbenchCommand('绑定工作会话'), { type: 'bind', target: undefined });
assert.deepEqual(parseWorkbenchCommand('绑定会话 1'), { type: 'bind', target: '1' });
assert.deepEqual(parseWorkbenchCommand('绑会话'), { type: 'bind', target: undefined });
assert.deepEqual(parseWorkbenchCommand('/unbind'), { type: 'unbind' });
assert.deepEqual(parseWorkbenchCommand('解绑'), { type: 'unbind' });
assert.deepEqual(parseWorkbenchCommand('退出绑定'), { type: 'unbind' });
assert.equal(parseWorkbenchCommand('绑定成功').type, 'plain');
assert.equal(parseWorkbenchCommand('状态如何').type, 'plain');

assert.deepEqual(parseWorkbenchCommand('切工作区 2'), { type: 'useWorkspace', target: '2' });
assert.deepEqual(parseWorkbenchCommand('切换工作区 metaapp'), { type: 'useWorkspace', target: 'metaapp' });
assert.deepEqual(parseWorkbenchCommand('ws 3'), { type: 'useWorkspace', target: '3' });
assert.deepEqual(parseWorkbenchCommand('/ws 3'), { type: 'useWorkspace', target: '3' });
assert.deepEqual(parseWorkbenchCommand('切会话 12'), { type: 'useSession', target: '12' });
assert.deepEqual(parseWorkbenchCommand('s 1'), { type: 'useSession', target: '1' });

// 命令词只做整词匹配，不能误吞普通句子
assert.equal(parseWorkbenchCommand('帮我看看这个 bug').type, 'plain');
assert.equal(parseWorkbenchCommand('这是什么工作区呢').type, 'plain');
assert.equal(parseWorkbenchCommand('随便聊聊').type, 'plain');
assert.equal(parseWorkbenchCommand('switch 会话到那边').type, 'plain');
assert.equal(parseWorkbenchCommand('').type, 'plain');

// ---------- 列表格式化 ----------

const wsList = [
  { id: 'a', path: 'E:/a', name: 'muster', openedAt: 0 },
  { id: 'b', path: 'E:/b', name: 'MetaApp', openedAt: 0 }
];
const wsText = formatWorkspaceList(wsList, 'b');
assert.match(wsText, /\[1\] muster/);
assert.match(wsText, /\[2\] MetaApp · 当前/);

const now = Date.now();
const sess = [
  { path: 'p1.jsonl', title: '修登录 bug', modified: now - 5 * 60_000, messageCount: 8, isTask: false },
  { path: 'p2.jsonl', title: '每晚构建', modified: now - 3 * 3600_000, messageCount: 20, isTask: true, taskName: '构建' }
];
const sessText = formatSessionList(sess, 20, now);
assert.match(sessText, /\[1\] 修登录 bug · 5m · 普通/);
assert.match(sessText, /\[2\] 每晚构建 · 3h · 定时任务/);
assert.ok(!sessText.includes('[3]'), '不应有第三条');
assert.match(formatSessionList([], 20, now), /还没有调度会话/);

// ---------- formatDoneText ----------

assert.equal(formatDoneText({ content: '', error: 'boom' }), '⚠️ 出错：boom');
assert.match(formatDoneText({ content: '部分结果', aborted: true }), /^⏹ 已手动停止/);
assert.equal(
  formatDoneText({
    content: '',
    plan: {
      status: 'executing',
      steps: [
        { step: 1, text: '读代码', completed: true },
        { step: 2, text: '改代码', completed: false }
      ]
    }
  }),
  '📋 计划（执行中）：\n[x] 1. 读代码\n[ ] 2. 改代码'
);
assert.equal(formatDoneText({ content: '  答案  ' }), '答案');
assert.equal(formatDoneText({ content: '' }), '（本轮没有文本输出）');

// ---------- resolveListTarget ----------

assert.equal(resolveListTarget('1', wsList), 0);
assert.equal(resolveListTarget('2', wsList), 1);
assert.equal(resolveListTarget('3', wsList), -1);
assert.equal(resolveListTarget('MUSTER', wsList), 0);
assert.equal(resolveListTarget('mus', wsList), 0);
assert.equal(resolveListTarget('metaapp', wsList), 1, '名称包含匹配取首个命中');
assert.equal(resolveListTarget('不存在', wsList), -1);
assert.equal(resolveListTarget('1', sess), 0, '会话列表按下标解析');
assert.equal(resolveListTarget('构建', sess), 1, '会话标题包含匹配');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] workbench-commands');
