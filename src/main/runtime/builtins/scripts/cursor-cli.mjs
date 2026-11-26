import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { cliLaunch } from './_native.mjs';
import { filterExtraArgs, assertManagedTerminalArgs, appendCliPrompt, agentHookCommand, HOOK_MARKER, readJsonLoose, writeJsonFile } from './_helpers.mjs';

const execFileAsync = promisify(execFile);
const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function workspaceDirectories() {
  return { flag: '--add-dir', note: 'Cursor CLI registers additional workspace roots with --add-dir. Native tool and shell access depend on Cursor sandbox/trust settings; this is not a host OS sandbox.' };
}

export async function allocate({ cwd } = {}) {
  if (cwd) {
    // P2：workspace 本地 hooks（camelCase 事件名）；无 env 的裸终端 hook 自行 no-op
    ensureCursorHooks({ cwd });
  }
  const launch = cliLaunch(['cursor-agent', 'create-chat']);
  const { stdout } = await execFileAsync(launch.command, launch.args, {
    cwd, timeout: 60_000, windowsHide: true, encoding: 'utf-8',
    windowsVerbatimArguments: launch.windowsVerbatimArguments === true
  });
  return { sessionId: parseCursorChatId(stdout) };
}

export function parseCursorChatId(stdout) {
  const lines = String(stdout)
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const sessionId = lines[lines.length - 1];
  if (!CHAT_ID.test(sessionId))
    throw new Error('cursor-agent create-chat 未返回有效 chatId；请检查 CLI 更新或登录状态后重试');
  return sessionId;
}

export function resolveLaunch(input) {
  const extra = filterExtraArgs(input.extraArgs);
  assertManagedTerminalArgs(input, extra, 'Cursor', ['--resume', '--continue', '--workspace']);
  return cliLaunch(['cursor-agent', '--resume', input.sessionId, ...extra]);
}

export function checkResume({ sessionId }) {
  // A native create-chat ID can be passed back to Cursor. The TUI owns load/exit.
  return CHAT_ID.test(sessionId) ? 'attempt' : 'unbound';
}

/** 正文一律落盘；argv 只带「请使用 UTF-8 编码读取并立即执行任务文件：path」（`--` 防 flag）。 */
export function appendPrompt({ prompt, extraArgs }) {
  return appendCliPrompt({ prompt, extraArgs });
}

/**
 * `cursor-agent create-chat` 要走一次网络往返，派活时先空拉起会赢过带 prompt 的
 * spawn（把它盖掉），因此改成拉起后 kill + `--resume` 时再带 prompt。
 */
export function injectStrategy() {
  return 'relaunch-resume';
}

export async function receiveMessage() {
  return { status: 'unsupported', reason: 'Cursor 交互 TUI 没有公开 attach/入站 IPC；agent acp 是另一种接入。保留同一会话 resume + 原生 prompt 兜底，不另起 ACP 冒充当前终端。' };
}

// ---------- 状态 hooks（P2）----------

/**
 * cursor hooks 事件为 camelCase 原生名。
 * 注意：beforeShellExecution 在**每条** shell 命令执行前都会触发（不是仅在需要授权时，
 * 见 cursor.com/docs/hooks），映射 blocked / needs_you 会把正常工作中的会话误标「需要你」。
 * 授权挂起交给 Claude PermissionRequest hook、模型 phase=needs_you 或 LLM 读屏兜底。
 * hooks 只上报 activity+event，不写 phase / label。
 */
const CURSOR_HOOK_EVENTS = [
  { event: 'sessionStart', activity: 'active', name: 'session-start' },
  { event: 'beforeSubmitPrompt', activity: 'active', name: 'user-prompt-submit' },
  { event: 'preToolUse', activity: 'active', name: 'pre-tool-use' },
  { event: 'stop', activity: 'idle', name: 'stop' },
  { event: 'beforeShellExecution', activity: 'active', name: 'shell-start' },
  { event: 'afterShellExecution', activity: 'active', name: 'shell-end' }
];

function cursorHooksPath(cwd) {
  return path.join(cwd, '.cursor', 'hooks.json');
}

/**
 * 合并写 workspace 本地 .cursor/hooks.json：{ version, hooks: { <event>: [{command}] } }。
 * 保留用户已有 hooks 与 version 键；重复运行去重（带标记旧条目先删再追加）。
 */
export function ensureCursorHooks({ cwd }) {
  const file = cursorHooksPath(cwd);
  const top = readJsonLoose(file);
  const hooks = top.hooks && typeof top.hooks === 'object' ? top.hooks : {};
  for (const { event, activity, name } of CURSOR_HOOK_EVENTS) {
    const entries = Array.isArray(hooks[event]) ? hooks[event].filter(Boolean) : [];
    const kept = entries.filter(
      (e) => !(e && typeof e === 'object' && typeof e.command === 'string' && e.command.includes(HOOK_MARKER))
    );
    kept.push({ command: agentHookCommand(activity, name) });
    hooks[event] = kept;
  }
  top.hooks = hooks;
  if (typeof top.version !== 'number') top.version = 1;
  writeJsonFile(file, top);
  return { file, events: CURSOR_HOOK_EVENTS.map((e) => e.event) };
}

/** 卸载：只删带标记的条目；空事件数组与空 hooks 键一并清掉 */
export function uninstallDetectHooks({ cwd }) {
  const file = cursorHooksPath(cwd);
  if (!fs.existsSync(file)) return { file, removed: 0 };
  const top = readJsonLoose(file);
  if (!top.hooks || typeof top.hooks !== 'object') return { file, removed: 0 };
  let removed = 0;
  for (const event of Object.keys(top.hooks)) {
    const entries = Array.isArray(top.hooks[event]) ? top.hooks[event] : null;
    if (!entries) continue;
    const next = entries.filter((e) => {
      const ours =
        e && typeof e === 'object' && typeof e.command === 'string' && e.command.includes(HOOK_MARKER);
      if (ours) removed += 1;
      return !ours;
    });
    if (next.length > 0) top.hooks[event] = next;
    else delete top.hooks[event];
  }
  if (Object.keys(top.hooks).length === 0) delete top.hooks;
  writeJsonFile(file, top);
  return { file, removed };
}
