import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { prepareClaudeInterrupt } from './_claude-interrupt.mjs';
import { prepareClaudeChannel, claudeChannelSupport } from './_claude-native.mjs';
import { filterExtraArgs, wrapWinCmd, assertManagedTerminalArgs, appendCliPrompt, agentHookCommand, HOOK_MARKER, readJsonLoose, writeJsonFile } from './_helpers.mjs';

export function workspaceDirectories() {
  return { flag: '--add-dir', note: 'Claude CLI registers additional writable directories with --add-dir. Native permissions, preapprovals and shell access depend on the CLI settings; this is not a host OS sandbox.' };
}

export function interruptInput() { return '\x1b'; }
export function prepareInterrupt({ cwd, sessionId }) {
  return prepareClaudeInterrupt(claudeSessionJsonlPath(cwd, sessionId), sessionId);
}

export async function allocate({ cwd } = {}) {
  if (cwd) {
    // P2：workspace 本地 hooks 装权威状态信号（无 env 的裸终端 hook 自行 no-op）
    ensureClaudeHooks({ cwd });
  }
  return { sessionId: randomUUID() };
}

export async function resolveLaunch(input) {
  const { mode, sessionId, extraArgs, forkFromSessionId, probe, cwd } = input;
  const extra = filterExtraArgs(extraArgs);
  assertManagedTerminalArgs(input, extra, 'Claude Code', [
    '--resume', '-r', '--continue', '-c', '--session-id', '--fork-session', '--from-pr', '--teleport', '--worktree', '-w'
  ]);
  const launch = native => legacyLaunch({ mode, sessionId, extra: [...native, ...extra], forkFromSessionId });
  if (probe) return launch([]);
  // Channels is a gated research preview, not a generally available TUI bus. MCP
  // initialization succeeds even when Claude drops every channel notification.
  // Require the vendor's explicit opt-in; never turn it on as an invisible default.
  const channelOptIn = extra.includes('--dangerously-load-development-channels') && extra.includes('server:muster-mailbox');
  if (!channelOptIn) return { ...launch([]), receiveMessage: async () => ({ status: 'unsupported',
    reason: '当前 Claude TUI 未显式启用厂商 Channels 预览；使用确认 idle/停止后的终端投递。厂商已开放通道时可在启动参数启用 server:muster-mailbox。' }) };
  const unsupported = await claudeChannelSupport(cwd);
  if (unsupported) return { ...launch([]), receiveMessage: async () => ({ status: 'unsupported', reason: unsupported }) };
  return prepareClaudeChannel(launch, { includeOptInFlag: false });
}

function legacyLaunch({ mode, sessionId, extra, forkFromSessionId }) {
  if (mode === 'fork' && forkFromSessionId) {
    return wrapWinCmd(['claude', '--resume', forkFromSessionId, '--fork-session', '--session-id', sessionId, ...extra]);
  }
  if (mode === 'start') {
    return wrapWinCmd(['claude', '--session-id', sessionId, ...extra]);
  }
  return wrapWinCmd(['claude', '--resume', sessionId, ...extra]);
}

/** 正文一律落盘；argv 只带短指令。claude.cmd 的 `%*` 会把 `|` / 换行截成前几个字。 */
export function appendPrompt({ prompt, extraArgs }) {
  return appendCliPrompt({ prompt, extraArgs });
}

export function claudeProjectDirName(cwd) {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9-]/g, '-');
}

export function claudeSessionJsonlPath(cwd, sessionId) {
  return path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.claude'),
    'projects',
    claudeProjectDirName(cwd),
    `${sessionId}.jsonl`
  );
}

export function canResume({ cwd, sessionId }) {
  if (!sessionId) return false;
  try {
    return fs.statSync(claudeSessionJsonlPath(cwd, sessionId)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

// ---------- 状态 hooks（P2）----------

/** 事件 → activity 映射；SessionEnd 装但忽略（退出由宿主 pty onExit 负责） */
const CLAUDE_HOOK_EVENTS = [
  { event: 'UserPromptSubmit', activity: 'active', name: 'user-prompt-submit' },
  { event: 'Stop', activity: 'idle', name: 'stop' },
  { event: 'PermissionRequest', activity: 'blocked', name: 'permission-request' },
  { event: 'SessionEnd', activity: 'ignore', name: 'session-end' }
];

function claudeSettingsPath(cwd) {
  return path.join(cwd, '.claude', 'settings.local.json');
}

/**
 * 合并写 workspace 本地 .claude/settings.local.json 装 4 个 hook。
 * 纪律：保留用户已有 hooks 与其它键；重复运行去重（先删带标记的旧条目再追加）。
 */
export function ensureClaudeHooks({ cwd }) {
  const file = claudeSettingsPath(cwd);
  const settings = readJsonLoose(file);
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const { event, activity, name } of CLAUDE_HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event].filter(Boolean) : [];
    const kept = groups
      .map((g) => {
        if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) return g;
        const hooksArr = g.hooks.filter(
          (h) => !(h && typeof h === 'object' && typeof h.command === 'string' && h.command.includes(HOOK_MARKER))
        );
        return { ...g, hooks: hooksArr };
      })
      // 我们的条目被剥掉后成空的组直接丢弃，避免重复 allocate 累积空组
      .filter((g) => g && typeof g === 'object' && (!Array.isArray(g.hooks) || g.hooks.length > 0));
    kept.push({
      hooks: [{ type: 'command', command: agentHookCommand(activity, name), timeout: 10 }]
    });
    hooks[event] = kept;
  }
  settings.hooks = hooks;
  writeJsonFile(file, settings);
  return { file, events: CLAUDE_HOOK_EVENTS.map((e) => e.event) };
}

/** 卸载：只删带标记的条目，用户 hooks 原样保留；空组丢弃 */
export function uninstallDetectHooks({ cwd }) {
  const file = claudeSettingsPath(cwd);
  if (!fs.existsSync(file)) return { file, removed: 0 };
  const settings = readJsonLoose(file);
  if (!settings.hooks || typeof settings.hooks !== 'object') return { file, removed: 0 };
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : null;
    if (!groups) continue;
    const next = [];
    for (const g of groups.filter(Boolean)) {
      if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) {
        next.push(g);
        continue;
      }
      const hooksArr = g.hooks.filter((h) => {
        const ours =
          h && typeof h === 'object' && typeof h.command === 'string' && h.command.includes(HOOK_MARKER);
        if (ours) removed += 1;
        return !ours;
      });
      if (hooksArr.length > 0) next.push({ ...g, hooks: hooksArr });
    }
    if (next.length > 0) settings.hooks[event] = next;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeJsonFile(file, settings);
  return { file, removed };
}
