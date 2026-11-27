/** First input for an empty or assigned terminal Worker. */
import { renderAgentRulesSection, type AgentRule } from './agentConduct';
import { buildWorkerMemoryGuidance } from './memoryFormat';
import { SESSION_REMINDER_GUIDANCE } from './sessionReminders';
import { buildVisualOutputGuidance } from './visualOutputGuidance';
import {
  REPLY_LANGUAGE_GUIDANCE,
  SESSION_PHASE_GUIDANCE,
  SESSION_PHASE_LABELS,
  WORKER_ISOLATION_GUIDANCE,
  WORKER_MAIL_GUIDANCE,
  workerWaitGuidance
} from './workerGuidance';

interface WorkerBriefOptions {
  rules?: AgentRule[];
  memorySection?: string;
}

export const WORKER_DELEGATION_CONTRACT =
  "When working on an assignment from this workspace's scheduler, directly or through a parent Worker, you are a delegated Worker. The scheduler is your task authority and may adjust the task scope, acceptance criteria, and implementation details. " +
  'Send task questions to the scheduler with host.mail.send to=scheduler, or to=parent when you have a parent session; do not ask the user to confirm changes to task scope, acceptance criteria, or implementation details. ' +
  'Only irreversible actions require explicit user approval: integration or merge, push, publication, credential changes, data deletion, and external sending. ' +
  'Respect explicit user instructions and existing tool permissions.';

export function buildWorkerTaskMessage(task: string): string {
  return WORKER_DELEGATION_CONTRACT + (task ? `\n\n${task}` : '');
}

function hostGuidance(rules?: AgentRule[]): string[] {
  return [
    'Muster Worker (MUSTER_HOST=1).',
    REPLY_LANGUAGE_GUIDANCE,
    'Prefer MCP. For HTTP, use Authorization: Bearer <MUSTER_SESSION_TOKEN>. GET MUSTER_TOOL_URL to read tool names and schemas. POST {"name":"host.tool.name","arguments":{}} to the same URL.',
    'Use host_sessions_setStatus or POST JSON to MUSTER_STATUS_URL. ' +
      SESSION_PHASE_GUIDANCE + ' ' + SESSION_PHASE_LABELS + ' For needs_you within 60s of turn start, add reason.',
    'host.mail.send: ' + WORKER_MAIL_GUIDANCE + ' ' + workerWaitGuidance('host.waitFor'),
    'If isolated: ' + WORKER_ISOLATION_GUIDANCE + ' Call host.sessions.requestIntegrate after explicit user approval.',
    buildWorkerMemoryGuidance(id => id === 'host.memory.remember' ? undefined : id),
    buildVisualOutputGuidance('terminal', 'host.ui.render'),
    `host.ui.reminders (if available) — ${SESSION_REMINDER_GUIDANCE}`,
    'If available, call host_ui_suggestReplies once before a user-facing reply.',
    renderAgentRulesSection(rules)
  ].filter(Boolean);
}

export function buildHostIntro(options: WorkerBriefOptions = {}): string {
  return [
    '【Muster Console】\nNo task assigned yet.',
    ...hostGuidance(options.rules)
  ].join('\n\n');
}

export function buildTaskBriefText(task: string, options: WorkerBriefOptions = {}): string {
  const memory = options.memorySection?.trim();
  return [
    '【Muster Console task brief】\nTask: ' + task.trim(),
    WORKER_DELEGATION_CONTRACT,
    ...hostGuidance(options.rules),
    ...(memory ? ['【Workspace memory (snapshot)】\n' + memory] : [])
  ].join('\n\n');
}
