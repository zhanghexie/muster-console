import { createInterface } from 'node:readline';
import { basicTui } from './_basic-tui.mjs';
import { filterExtraArgs } from './_helpers.mjs';
import { cliLaunch, spawnOwned } from './_native.mjs';

const runtime = basicTui('qwen', []);
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const SESSION_LIST_LIMIT = 10_000;

export const allocate = runtime.allocate;
export const appendPrompt = runtime.appendPrompt;
export const receiveMessage = runtime.receiveMessage;

function hasNativeSessionOverride(args) {
  const separator = args.indexOf('--');
  const options = separator < 0 ? args : args.slice(0, separator);
  return options.some(arg => /^(?:--(?:resume|continue|session-id|fork-session|worktree)|-[rc])(?:=|$)/.test(arg));
}

export function resolveLaunch({ mode, sessionId, extraArgs = [], probe, newConversation }) {
  const args = filterExtraArgs(extraArgs);
  if (mode === 'fork') throw new Error('Qwen CLI adapter cannot fork a native conversation');
  // Honor existing overrides that select another conversation or change Qwen's cwd.
  if (probe) return cliLaunch(['qwen', ...args]);
  if (hasNativeSessionOverride(args)) {
    if (newConversation) throw new Error('Remove the Qwen session or worktree override before opening a new conversation.');
    if (mode === 'resume') throw new Error('Remove the Qwen session or worktree override before resuming the saved conversation.');
    return cliLaunch(['qwen', ...args]);
  }
  if (!UUID.test(sessionId)) throw new Error('Invalid Qwen CLI session ID');
  return cliLaunch(['qwen', mode === 'resume' ? '--resume' : '--session-id', sessionId, ...args]);
}

export async function canResume({ cwd, sessionId, extraArgs = [] }) {
  if (!UUID.test(sessionId) || hasNativeSessionOverride(extraArgs)) return false;
  // Ask Qwen to resolve its configured storage and project scope. The command
  // is read-only and does not start a model turn.
  const lookup = spawnOwned(['qwen', 'sessions', 'list', '--json', '--limit', String(SESSION_LIST_LIMIT)], {
    cwd, stdio: ['ignore', 'pipe', 'pipe']
  });
  const { child } = lookup;
  const lines = createInterface({ input: child.stdout });
  let found = false;
  let count = 0;
  let invalidOutput = false;
  let diagnostic = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-1024); });
  lines.on('line', line => {
    if (!line.trim()) return;
    try {
      const { sessionId: listed } = JSON.parse(line);
      if (typeof listed !== 'string') invalidOutput = true;
      else {
        count++;
        if (listed === sessionId) found = true;
      }
    } catch {
      invalidOutput = true;
    }
  });
  try {
    return await new Promise((resolve, reject) => {
      const message = 'Could not check saved Qwen CLI sessions. Run qwen sessions list --json in the session directory and update Qwen Code if the command is unavailable.';
      const timer = setTimeout(() => reject(new Error(`Qwen CLI session lookup timed out. ${message}`)), 10_000);
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', code => {
        clearTimeout(timer);
        if (code !== 0 || invalidOutput) reject(new Error(message));
        else if (!found && (count >= SESSION_LIST_LIMIT || diagnostic.includes('more available')))
          reject(new Error('Qwen CLI session list was truncated before the saved session ID could be verified.'));
        else resolve(found);
      });
    });
  } finally {
    lines.close();
    lookup.dispose();
  }
}

export async function checkResume(input) {
  if (hasNativeSessionOverride(input.extraArgs ?? [])) return 'unsupported';
  if (!UUID.test(input.sessionId)) return 'unbound';
  return await canResume(input) ? 'attempt' : 'missing';
}
