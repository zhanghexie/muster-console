export const REPLY_LANGUAGE_GUIDANCE =
  "Reply in the user's requested language. Otherwise, use the language of their latest prose, excluding host prompts, quotes, code, and tool output.";

export const SESSION_PHASE_GUIDANCE =
  '能继续就继续。必须用户行动时，报「需要你」并说清等什么。明确任务已交付并核验、用户无需再操作时，报「完成」。普通对话自然结束即可。';

export const SESSION_PHASE_LABELS = '需要你 = needs_you，完成 = done。';

export const WORKER_MAIL_GUIDANCE = 'kind=notice for progress (keep working), kind=ask for a reply, kind=handoff for delivery.';

export function workerWaitGuidance(tool: string): string {
  return `Arm ${tool} for a reply or event and keep working.`;
}

export const WORKER_ISOLATION_GUIDANCE = 'Use the assigned isolated worktree and commit before needs_you.';
