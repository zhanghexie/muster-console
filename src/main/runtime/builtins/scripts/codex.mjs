import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareCodexTui } from './_codex-native.mjs';
import { cliLaunch } from './_native.mjs';
import {
  filterExtraArgs,
  assertManagedTerminalArgs,
  appendCliPrompt,
  agentHookCommand,
  HOOK_MARKER,
  readJsonLoose,
  writeJsonFile
} from './_helpers.mjs';

/**
 * Codex 会话 ID：宿主预分配的占位（codex 不接受外部指定 session id，
 * `codex [OPTIONS] [PROMPT]` 无 `--session-id` 等价旗标）。占位 id 只用于
 * 关联宿主会话记录；checkResume 对占位返回 unbound。
 * 真实 rollout id（UUID）存在 $CODEX_HOME/sessions 时才可 resume/fork。
 */
export const CODEX_PENDING_PREFIX = 'codex-pending-';

function codexHome() {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

export function isPendingSessionId(sessionId) {
  return typeof sessionId !== 'string' || !sessionId || sessionId.startsWith(CODEX_PENDING_PREFIX);
}

export function workspaceDirectories() {
  return { flag: '--add-dir', note: 'Codex CLI registers additional writable roots with --add-dir; native remote-TUI sessions pass them to the app-server as sandbox_workspace_write.writable_roots instead (the CLI rejects --add-dir beside --remote). The CLI sandbox, approval mode and user configuration determine native permissions; the host does not intercept native CLI tools.' };
}

export async function allocate({ cwd } = {}) {
  if (cwd) {
    // P2：workspace 本地 hooks 装权威状态信号（无 env 的裸终端 hook 自行 no-op）。
    // 注意 codex 有 hook 信任门：写入 ≠ 生效，需用户在 TUI /hooks 里 trust 一次（见 features 文档已知边界）。
    ensureCodexHooks({ cwd });
  }
  return { sessionId: `${CODEX_PENDING_PREFIX}${randomUUID()}` };
}

export function resolveLaunch(input) {
  const { mode, sessionId, extraArgs, forkFromSessionId, probe } = input;
  const extra = filterExtraArgs(extraArgs);
  const managed = input.isolatedWorktree ? { ...input, newConversation: true } : input;
  assertManagedTerminalArgs(managed, extra, 'Codex', ['--last', '--cd', '-C', '--worktree', '--remote', '--remote-auth-token-env']);
  if (!probe && input.isolatedWorktree && extra.slice(0, extra.includes('--') ? extra.indexOf('--') : extra.length).some(arg => arg.startsWith('-C'))) {
    throw new Error('Codex: remove -C from the runtime arguments before launching an isolated worktree');
  }
  if (!probe && input.isolatedWorktree) extra.unshift('--cd', input.cwd);
  if (!probe && input.newConversation && (extra[0] === 'resume' || extra[0] === 'fork')) {
    throw new Error(`Codex: remove ${extra[0]} from the runtime arguments before starting a new conversation from the workbench`);
  }
  const executable = input.executable ?? 'codex';
  const legacy = (args = extra) => legacyLaunch({ executable, mode, sessionId, extra: args, forkFromSessionId });
  return probe ? legacy() : prepareCodexTui({ ...input, executable, extraArgs: extra }, legacy);
}

function legacyLaunch({ executable, mode, sessionId, extra, forkFromSessionId }) {
  if (mode === 'fork' && forkFromSessionId) {
    // codex 原生 fork：从源会话分叉出新会话（sessionId 仅作宿主侧记录）
    return cliLaunch([executable, 'fork', forkFromSessionId, ...extra]);
  }
  if (mode === 'start' && isPendingSessionId(sessionId)) {
    // 占位 id 不是真实会话：裸启动新会话（resume <占位> 会直接报错退出）
    return cliLaunch([executable, ...extra]);
  }
  // start 拿到真实 id（等价空会话打开）与 resume 同形：`codex resume <id>`
  return cliLaunch([executable, 'resume', sessionId, ...extra]);
}

/** 正文一律落盘；codex TUI 接受位置参数 [PROMPT]，`--` 后带短指令 */
export function appendPrompt({ prompt, extraArgs }) {
  return appendCliPrompt({ prompt, extraArgs });
}

/**
 * 真实会话存在性检查：rollout 文件名形如 rollout-<ts>-<uuid>.jsonl，按
 * $CODEX_HOME/sessions/** 深度受限扫描。占位 id 恒 false。
 */
export function canResume({ sessionId }) {
  if (isPendingSessionId(sessionId)) return false;
  const sessionsDir = path.join(codexHome(), 'sessions');
  const suffix = `-${sessionId}.jsonl`;
  let found = false;
  const walk = (dir, depth) => {
    if (found || depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
      throw error;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith(suffix)) {
        found = true;
        return;
      }
      if (e.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(sessionsDir, 0);
  return found;
}

export function checkResume(input) {
  if (isPendingSessionId(input.sessionId)) return 'unbound';
  return canResume(input) ? 'attempt' : 'missing';
}

// ---------- 状态 hooks（P2）----------

/**
 * codex hooks.json 事件 → activity 映射（事件名官方文档核实，PascalCase）。
 * 事件集刻意最小（对齐 wmux 先例）：PreToolUse/PostToolUse 每工具调用都要
 * spawn 一次 node 进程，开销大；active 已由 UserPromptSubmit 覆盖。
 * codex 无 SessionEnd；退出由宿主 pty onExit 负责。
 */
const CODEX_HOOK_EVENTS = [
  { event: 'SessionStart', activity: 'active', name: 'session-start' },
  { event: 'UserPromptSubmit', activity: 'active', name: 'user-prompt-submit' },
  { event: 'PermissionRequest', activity: 'blocked', name: 'permission-request' },
  { event: 'Stop', activity: 'idle', name: 'stop' }
];

function codexHooksPath(cwd) {
  return path.join(cwd, '.codex', 'hooks.json');
}

/**
 * 合并写 workspace 本地 .codex/hooks.json：{ hooks: { <Event>: [{ hooks: [...] }] } }。
 * 结构与 claude settings 同族（matcher 组 + hooks 数组）；matcher 省略 = 全匹配。
 * 保留用户已有 hooks 与其它键；重复运行去重（先删带标记的旧条目再追加）。
 */
export function ensureCodexHooks({ cwd }) {
  const file = codexHooksPath(cwd);
  const top = readJsonLoose(file);
  const hooks = top.hooks && typeof top.hooks === 'object' ? top.hooks : {};
  for (const { event, activity, name } of CODEX_HOOK_EVENTS) {
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
  top.hooks = hooks;
  writeJsonFile(file, top);
  return { file, events: CODEX_HOOK_EVENTS.map((e) => e.event) };
}

/** 卸载：只删带标记的条目，用户 hooks 原样保留；空组与空事件键一并清掉 */
export function uninstallDetectHooks({ cwd }) {
  const file = codexHooksPath(cwd);
  if (!fs.existsSync(file)) return { file, removed: 0 };
  const top = readJsonLoose(file);
  if (!top.hooks || typeof top.hooks !== 'object') return { file, removed: 0 };
  let removed = 0;
  for (const event of Object.keys(top.hooks)) {
    const groups = Array.isArray(top.hooks[event]) ? top.hooks[event] : null;
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
    if (next.length > 0) top.hooks[event] = next;
    else delete top.hooks[event];
  }
  if (Object.keys(top.hooks).length === 0) delete top.hooks;
  writeJsonFile(file, top);
  return { file, removed };
}
