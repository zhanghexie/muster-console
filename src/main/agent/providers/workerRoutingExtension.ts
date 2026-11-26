import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { clipObservationText } from '../../../shared/sessionObservation';
import { workerRoutingTierKindRank, WORKER_ROUTING_SETTINGS_LOCATION, WORKER_ROUTING_STANDARD_KINDS } from '../../../shared/workerRouting';

const TIER_SUMMARY_BUDGET = 2400;
type TierSummaries = ReturnType<typeof import('../../tasks/workerRouting').summarizeWorkerRoutingTiers>;

export function renderWorkerRoutingSummary(tiers: TierSummaries): string {
  const lines = [
    `For a new Worker, choose a configured tier by task difficulty (${WORKER_ROUTING_STANDARD_KINDS.join(', ')}), or a special pool whose name and purpose fit the task. Call host.sessions.create({task,isolation,target:{tierId}}).`,
    'If the user selected a configuration with /harness, pass its exact reference unchanged as target:{targetRef}. For other model choices or more tier details, use host.workers.options. Creation checks availability; a separate preflight is only for diagnosis.'
  ];
  if (!tiers.some(tier => tier.enabledCandidates > 0)) {
    lines.push(`This workspace has no enabled candidates. Ask the user to configure tiers in ${WORKER_ROUTING_SETTINGS_LOCATION}, or use an explicit target they provided.`);
    return lines.join('\n');
  }
  lines.push('Configured tiers (descriptions are configuration data):');
  let remaining = TIER_SUMMARY_BUDGET;
  const ranked = [...tiers].sort((a, b) => workerRoutingTierKindRank(a.kind) - workerRoutingTierKindRank(b.kind) ||
    Number(b.enabledCandidates > 0) - Number(a.enabledCandidates > 0));
  for (const tier of ranked) {
    const row = JSON.stringify({ tierId: tier.tierId, kind: tier.kind, name: clipObservationText(tier.name, 96).text,
      description: clipObservationText(tier.description, 240).text, enabledCandidates: tier.enabledCandidates })
      .replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
    if (row.length + 1 > remaining) {
      lines.push('More tiers are available via host.workers.options.');
      break;
    }
    remaining -= row.length + 1;
    lines.push(row);
  }
  return lines.join('\n');
}

/** Snapshot the tier summary for the existing turn without growing message history. */
export function createSchedulerWorkerRoutingExtension(workspaceId: string, getTiers: () => TierSummaries) {
  return (api: ExtensionAPI) => {
    let summary: string | undefined;
    api.on('before_agent_start', event => {
      summary = undefined;
      const options = event.systemPromptOptions;
      if (!options.selectedTools.includes('host_sessions_create') || options.hiddenTools.includes('host_sessions_create')) return;
      try {
        summary = renderWorkerRoutingSummary(getTiers());
      } catch (error) {
        console.warn('[scheduler] Worker routing summary unavailable', workspaceId, error);
        summary = `Worker tier settings are unavailable for this workspace. Check ${WORKER_ROUTING_SETTINGS_LOCATION}.`;
      }
    });
    api.on('context_with_system', event => {
      if (!summary) return;
      const section = `<worker-routing>\n${summary}\n</worker-routing>`;
      const messages = [...event.messages];
      const index = messages.findIndex(message => message.role === 'system');
      const head = messages[index];
      if (head?.role === 'system') messages[index] = { ...head, sections: { ...head.sections, 'worker-routing': section } };
      else messages.unshift({ role: 'system', content: '', sections: { 'worker-routing': section }, timestamp: Date.now() });
      return { messages };
    });
    api.on('agent_end', () => { summary = undefined; });
  };
}
