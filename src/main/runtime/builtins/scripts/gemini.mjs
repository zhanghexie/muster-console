import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { filterExtraArgs, wrapWinCmd, assertManagedTerminalArgs, writeInjectPrompt, agentHookCommand, HOOK_MARKER, readJsonLoose, writeJsonFile } from './_helpers.mjs';

/**
 * Gemini 原生 BeforeAgent/AfterAgent hooks 提供回合边界；通知 OSC 是出站，不能收信。
 */

/**
 * Gemini 会话 ID：宿主预分配的占位。gemini 不接受外部指定 session id
 * （官方-issue #22644 尚是 feature request），也无免模型回合的创建 API。
 * 占位 id 只用于关联宿主会话记录；checkResume 对占位返回 unbound。
 * 真实 UUID 存在于 ~/.gemini/tmp/<hash>/chats/ 时可 resume。
 */
export const GEMINI_PENDING_PREFIX = 'gemini-pending-';

function geminiHome() {
  return process.env.GEMINI_CLI_HOME ?? path.join(os.homedir(), '.gemini');
}

export function isPendingSessionId(sessionId) {
  return typeof sessionId !== 'string' || !sessionId || sessionId.startsWith(GEMINI_PENDING_PREFIX);
}

export function workspaceDirectories() {
  return { flag: '--include-directories', maxExtraDirectories: 5, rejectCommas: true,
    note: 'Gemini CLI registers up to 5 extra roots with --include-directories. Directory trust, native tool and sandbox settings still apply; this is not a host OS sandbox.' };
}

export async function allocate({ cwd } = {}) {
  if (cwd) ensureDetectHooks({ cwd });
  return { sessionId: `${GEMINI_PENDING_PREFIX}${randomUUID()}` };
}

export function resolveLaunch(input) {
  const { mode, sessionId, extraArgs, probe, cwd } = input;
  const extra = filterExtraArgs(extraArgs);
  assertManagedTerminalArgs(input, extra, 'Gemini CLI', ['--resume', '-r']);
  // Restored sessions created before hooks were added must receive the same boundaries.
  if (!probe && cwd) ensureDetectHooks({ cwd });
  // gemini 无原生 fork（无 --fork 类旗标）：新会话裸启动，源会话由用户经
  // /resume 浏览器自行接续（见 features 文档已知边界）。
  if ((mode === 'start' && isPendingSessionId(sessionId)) || mode === 'fork') {
    return wrapWinCmd(['gemini', ...extra]);
  }
  // start 拿到真实 id 与 resume 同形：`gemini --resume <sessionId|uuid>`
  return wrapWinCmd(['gemini', '--resume', sessionId, ...extra]);
}

/** -i keeps the real interactive TUI alive, unlike the headless -p option. */
export function appendPrompt({ prompt, extraArgs }) {
  const written = writeInjectPrompt(prompt);
  if (written) extraArgs.push('--prompt-interactive', written.promptArg);
  return true;
}

export async function receiveMessage() {
  return { status: 'unsupported', reason: 'Gemini 交互 TUI 没有公开的入站信道；ACP 是独立接入。普通信等原生 AfterAgent idle 后终端投递，优先信先确认中止。首发使用 -i 原生 prompt。' };
}

export function ensureDetectHooks({ cwd }) {
  const file = path.join(cwd, '.gemini', 'settings.json');
  const settings = readJsonLoose(file);
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const [event, activity, name] of [['BeforeAgent', 'active', 'before-agent'], ['AfterAgent', 'idle', 'after-agent']]) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = groups.map(group => !Array.isArray(group?.hooks) ? group : {
      ...group, hooks: group.hooks.filter(hook => !hook?.command?.includes(HOOK_MARKER)),
    }).filter(group => !Array.isArray(group?.hooks) || group.hooks.length).concat({
      hooks: [{ name: `muster-${name}`, type: 'command', command: agentHookCommand(activity, name), timeout: 10_000 }],
    });
  }
  settings.hooks = hooks;
  writeJsonFile(file, settings);
  return { file, events: ['BeforeAgent', 'AfterAgent'] };
}

export function uninstallDetectHooks({ cwd }) {
  const file = path.join(cwd, '.gemini', 'settings.json');
  if (!fs.existsSync(file)) return { file, removed: 0 };
  const settings = readJsonLoose(file);
  let removed = 0;
  for (const event of ['BeforeAgent', 'AfterAgent']) {
    if (!Array.isArray(settings.hooks?.[event])) continue;
    settings.hooks[event] = settings.hooks[event].map(group => !Array.isArray(group?.hooks) ? group : {
      ...group, hooks: group.hooks.filter(hook => {
        if (!hook?.command?.includes(HOOK_MARKER)) return true;
        removed++; return false;
      }),
    }).filter(group => !Array.isArray(group?.hooks) || group.hooks.length);
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  writeJsonFile(file, settings);
  return { file, removed };
}

/**
 * 真实会话存在性检查：sessions 存于 ~/.gemini/tmp/<project_hash>/chats/，
 * project_hash 算法是 CLI 内部实现，按 * 通配扫描文件名含 id 的会话文件。
 * 占位 id 恒 false。
 */
export function canResume({ sessionId }) {
  if (isPendingSessionId(sessionId)) return false;
  const tmpDir = path.join(geminiHome(), 'tmp');
  let found = false;
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(tmpDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(tmpDir, e.name));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
  for (const proj of projectDirs) {
    const chats = path.join(proj, 'chats');
    let entries;
    try {
      entries = fs.readdirSync(chats);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    }
    if (entries.some((name) => name.includes(sessionId))) {
      found = true;
      break;
    }
  }
  return found;
}

export function checkResume(input) {
  if (isPendingSessionId(input.sessionId)) return 'unbound';
  return canResume(input) ? 'attempt' : 'missing';
}
