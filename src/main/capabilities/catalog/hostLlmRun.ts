import { buildRunToolDomain, type RunToolDomain } from './runFactory';
import { LLM_GIT_WEB_TOOL_DEFS } from './llmGitWeb';

/** Prepared for the atomic name migration; the active llm.run still excludes quota. */
export function buildHostLlmRun(role: 'scheduler' | 'worker', includeQuota = true): RunToolDomain {
  if (role !== 'scheduler' && role !== 'worker') throw new Error('Invalid host LLM caller role');
  if (role === 'worker' && !includeQuota) throw new Error('Worker LLM run requires the quota source');
  return buildRunToolDomain({ prefix: 'llm.', runName: 'host.llm.run',
    purpose: role === 'worker' ? 'Inspect local provider failures.' : 'Manage model providers and inspect local provider failures.',
    skillPath: '~/.muster/skills/llm/SKILL.md', ...(role === 'worker' ? { include: ['quota'] } : !includeQuota ? { exclude: ['quota'] } : {}) }, LLM_GIT_WEB_TOOL_DEFS);
}
