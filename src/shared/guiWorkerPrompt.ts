/** Build the model-facing introduction from the tools available on this connection. */
import { renderAgentRulesSection, type AgentRule } from './agentConduct';
import { buildWorkerMemoryGuidance } from './memoryFormat';
import { SESSION_REMINDER_GUIDANCE } from './sessionReminders';
import { buildVisualOutputGuidance } from './visualOutputGuidance';
import {
  REPLY_LANGUAGE_GUIDANCE,
  SESSION_PHASE_GUIDANCE,
  WORKER_ISOLATION_GUIDANCE,
  WORKER_MAIL_GUIDANCE,
  workerWaitGuidance
} from './workerGuidance';

export interface GuiWorkerPromptOpts {
  sessionId?: string;
  cwd?: string;
  worktreePath?: string;
  mode?: string;
  tools: readonly { id: string }[];
  hostToolNamePrefix?: string;
  isSubagent?: boolean;
  isolated?: boolean;
  rules?: AgentRule[];
  memorySection?: string;
}

export function buildGuiWorkerSystemPrompt(opts: GuiWorkerPromptOpts): string {
  const { opening, guidance } = buildGuiWorkerPromptSections(opts);
  return [opening, guidance].filter(Boolean).join('\n\n');
}

export function buildGuiWorkerPromptSections(opts: GuiWorkerPromptOpts): { opening: string; guidance: string } {
  const available = new Set(opts.tools.map(tool => tool.id));
  const toolName = (id: string) => (opts.hostToolNamePrefix ?? '') + id.replaceAll('.', '_');
  const hasStatus = available.has('host.sessions.setStatus');
  const hasMail = available.has('host.mail.send');
  const isolated = opts.isolated || !!opts.worktreePath;
  const directory = [
    opts.cwd ? 'Current directory ' + opts.cwd + '.' : '',
    opts.worktreePath ? 'Assigned worktree ' + opts.worktreePath + '.' : ''
  ].filter(Boolean).join(' ');

  const identity = [
    opts.isSubagent ? 'You are a subagent running in your own Muster session.' : 'You are the Worker for this chat.',
    opts.sessionId ? `Your session ID in Muster is ${opts.sessionId}.` : '',
    opts.isSubagent
      ? 'Carry out the task delegated by your parent session and report the result back to it.'
      : 'Handle requests from the user and tasks delegated to this session.'
  ].filter(Boolean).join(' ');
  const opening = [
    'Muster Console opens or resumes your Harness session. Your Harness makes model calls, runs its native tools, and manages conversation context. Muster provides workspace context and workbench tools, and routes messages and tasks between sessions.',
    identity,
    REPLY_LANGUAGE_GUIDANCE,
    opts.mode ? `Permission mode: ${opts.mode}.` : '',
    directory
  ].filter(Boolean).join('\n\n');
  const guidance = [
    buildWorkerMemoryGuidance(id => available.has(id) ? toolName(id) : undefined),
    available.has('host.mcp.search') && available.has('host.mcp.call')
      ? `Third-party MCP: ${toolName('host.mcp.search')} → ${toolName('host.mcp.call')}.` : '',
    hasStatus
      ? `${toolName('host.sessions.setStatus')} — ${SESSION_PHASE_GUIDANCE}` : '',
    available.has('host.sessions.create')
      ? `Delegate independent subtasks with ${toolName('host.sessions.create')}. Set asSubagent=true and use inherit=true to reuse your launch settings. Include the task and choose isolation=shared or isolated.` : '',
    [
      hasMail ? `${toolName('host.mail.send')}: ${WORKER_MAIL_GUIDANCE}` : '',
      available.has('host.waitFor') ? workerWaitGuidance(toolName('host.waitFor')) : '',
      opts.isSubagent && hasMail
        ? 'Deliver to your parent (to="parent").' : ''
    ].filter(Boolean).join(' '),
    isolated ? [
      hasStatus ? WORKER_ISOLATION_GUIDANCE : 'Work in the assigned isolated worktree.',
      available.has('host.sessions.requestIntegrate')
        ? `Call ${toolName('host.sessions.requestIntegrate')} after explicit user approval.` : ''
    ].filter(Boolean).join(' ') : '',
    available.has('host.turnChanges.trackFiles')
      ? `For edits review may miss (e.g. shell or scripts), register exact paths before and after with ${toolName('host.turnChanges.trackFiles')}. See ~/.muster/skills/turn-changes/SKILL.md.` : '',
    opts.memorySection?.trim() ? '## Workspace Memory (connection snapshot)\n' + opts.memorySection.trim() : '',
    buildVisualOutputGuidance('chat', available.has('host.ui.render') ? toolName('host.ui.render') : undefined),
    available.has('host.ui.reminders')
      ? `${toolName('host.ui.reminders')} — ${SESSION_REMINDER_GUIDANCE}` : '',
    available.has('host.ui.suggestReplies')
      ? `Before sending each final reply to the user, call ${toolName('host.ui.suggestReplies')} exactly once.` : '',
    renderAgentRulesSection(opts.rules)
  ].filter(Boolean).join('\n\n');
  return { opening, guidance };
}
