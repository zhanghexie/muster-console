/**
 * Resident tool projection (tool-exposure-resident-run-skill-plan §3 R5). These lists ARE
 * the model's whole surface: R4 expanded them to the end state and R5 retired the
 * tools.search/tools.call discovery pair, so anything not listed is unreachable.
 * Listing a tool by name makes it natively registered with its schema; role/mode
 * permission intersection semantics in consumers are unchanged. When adding a tool,
 * add it here for every role/preset that should see it — the preset-visible ⊆ resident
 * invariant is guarded by test/tool-discovery.mjs.
 */

/** MCP relay pair (capability-delivery B1): resident for every role (search returns an empty list, not an error, when no server is configured). */
export const MCP_RELAY_TOOL_IDS: readonly string[] = ['mcp.search', 'mcp.call'];

/**
 * Worker resident list. Preset differences are resolved by
 * intersecting with shared/hostTools meta presets in each projection: bgtasks.* and the
 * memory is shared across Worker presets; remember/confirm require a GUI turn.
 * node_repl.js stays GUI-only, and ui.render/ui.inspect stay direct GUI + PTY.
 * intent (standing intents) joined the worker surface on 2026-10-23 (user decision), same
 * GUI+PTY scope as the memory family.
 */
const WORKER_RESIDENT_TOOL_IDS: readonly string[] = [
  'turnChanges.trackFiles',
  'panel.run', 'desktop.run', 'github.run',
  'feedback.propose', 'feedback.history', 'feedback.assess',
  // Session communication (4)
  'sessions.create', 'terminal.create', 'sessions.message', 'sessions.readMessages', 'waitFor', 'sessions.setArchived',
  // Session status (5)
  'sessions.setStatus', 'sessions.rename', 'sessions.requestIntegrate', 'sessions.isolate', 'ui.notify',
  // Standing intents (1; memory-family scope GUI+PTY)
  'intent',
  // Observation and events (8)
  'sessions.observe', 'sessions.search', 'workers.options', 'workers.context', 'llm.quota', 'attachments.convert',
  'events.subscribe', 'events.unsubscribe', 'events.list', 'events.read', 'events.register', 'events.emit',
  // Memory
  'memory.search', 'memory.list', 'memory.get', 'memory.confirm', 'memory.note', 'memory.remember', 'memory.journal', 'memory.journalGet', 'memory.correct', 'memory.correctionStatus',
  // Smart widgets and suggested replies
  'ui.render', 'ui.inspect', 'ui.suggestReplies', 'ui.reminders',
  // Status share board (1)
  'share.set',
  // Background tasks (4; GUI+ACP presets)
  'bgtasks.shell', 'bgtasks.wait', 'bgtasks.list', 'bgtasks.kill',
  // Persistent execution (GUI preset only)
  'node_repl.js',
  // Browser domain run entry
  'browser.run',
  // Extension extension authoring and invocation; every call is session-bound.
  'extensions.run',
  // MCP relay
  ...MCP_RELAY_TOOL_IDS
];

/**
 * Scheduler resident list (seven management tools consolidated into sessions.run):
 * collaboration, nine runFactory domains, scheduler apps and the MCP relay pair. sessions.requestIntegrate is
 * deliberately absent: its catalog def is schedulerHidden (a Worker-side notification
 * entry), so listing it here would never surface it — the deviation from the §2.2 roster
 * is recorded in the R4 report. memory.* stays resident pending the data-driven review of
 * open question #4 (deferred by plan).
 */
const SCHEDULER_RESIDENT_TOOL_IDS: readonly string[] = [
  'turnChanges.trackFiles',
  'panel.run', 'desktop.run', 'github.run',
  'feedback.propose', 'feedback.history', 'feedback.assess',
  // Core session collaboration (5)
  'sessions.create', 'sessions.observe', 'sessions.message', 'sessions.readMessages', 'waitFor', 'sessions.setStatus',
  // Channel questionnaire, acceptance/integration, terminal (5)
  'askQuestion', 'sessions.review', 'sessions.integrate', 'terminal.create', 'terminal.write', 'terminal.capture',
  // Session orchestration (4): management actions keep full schemas in sessions.run.
  'sessions.interrupt', 'sessions.run', 'sessions.completeAndArchive', 'sessions.delete',
  // Session status (4; requestIntegrate stays worker-side — see note above)
  'sessions.setArchived', 'sessions.rename', 'sessions.isolate', 'ui.notify',
  // Observation and events remainder (7)
  'sessions.search', 'workers.options', 'llm.quota', 'attachments.convert',
  'events.subscribe', 'events.unsubscribe', 'events.list', 'events.read', 'events.register', 'events.emit',
  'events.resolveLaunch',
  // Memory
  'memory.search', 'memory.list', 'memory.get', 'memory.confirm', 'memory.note', 'memory.remember', 'memory.journal', 'memory.journalGet', 'memory.correct', 'memory.correctionStatus',
  // Smart widgets and suggested replies
  'ui.render', 'ui.inspect', 'ui.suggestReplies', 'ui.reminders',
  // Scheduler policy (2)
  'scheduler.policy.get', 'scheduler.policy.set',
  // UI inquiry (2)
  'ui.confirm', 'ui.prompt',
  // Gateways (2)
  'web.fetch', 'git.refreshRepos',
  // App info (2)
  'app.getConfig', 'app.instances',
  // Scheduler-owned persistent applications.
  'apps.run',
  // Event review (1) and memory intent (1)
  'events.review', 'intent',
  // Run entries (actions enumerated in each entry's schema; usage detail lives in the domain skill)
  'browser.run', 'workflow.run', 'runtimes.run', 'automations.run', 'themes.run', 'dispatch.run',
  'llm.run', 'extensions.run',
  // MCP relay
  ...MCP_RELAY_TOOL_IDS
];

/** Visibility only: callers still intersect these IDs with their existing role/mode permissions. */
export function residentHostToolIds(role: 'scheduler' | 'worker'): readonly string[] {
  return role === 'scheduler' ? SCHEDULER_RESIDENT_TOOL_IDS : WORKER_RESIDENT_TOOL_IDS;
}

/**
 * Scheduler registration gate (dynamic-tools reachability fix): a tool is registerable in the
 * scheduler session when it is on the static resident roster OR is a currently loaded dynamic
 * `ext.*` entry — approved extension dynamic tools are registered for the bound project at
 * session-creation time (piProvider enumerates the registry; mid-session additions re-register
 * best-effort via the registry onChange hook). Retired domain verbs (workflow.start and other
 * internal execution sources) are deliberately not registerable. Worker faces (GUI/PTY) keep
 * the documented dynamic-tools permission posture and do not use this gate.
 */
export function isSchedulerRegisterableTool(name: string): boolean {
  return SCHEDULER_RESIDENT_TOOL_IDS.includes(name) || name.startsWith('ext.');
}

export interface DiscoverableTool {
  name: string;
  description: string;
  summary?: string;
  parameters: Record<string, unknown>;
}

export function toolNameMatches(actual: string, requested: string): boolean {
  return actual === requested || actual.replace(/\./g, '_') === requested;
}

/**
 * Internal catalog directory query (test/diagnostic utility since R5 retired tools.search):
 * paging/budget behavior kept as-is for the tests that enumerate catalog groups and fetch
 * exact schemas; no longer exposed to the model as a tool.
 */
export function searchToolDirectory(tools: readonly DiscoverableTool[], args: Record<string, unknown>): unknown {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (name && args.names !== undefined) throw new Error('Pass either name or names, not both.');
  if (name) {
    const tool = tools.find(tool => toolNameMatches(tool.name, name));
    if (!tool) throw new Error('That tool is not in this session\'s available directory.');
    return { tool: { name: tool.name, description: tool.description, parameters: tool.parameters } };
  }
  let selected = tools;
  if (args.names !== undefined) {
    if (!Array.isArray(args.names) || !args.names.length || args.names.length > 20 || args.names.some(value => typeof value !== 'string' || !value.trim())) throw new Error('names needs 1-20 exact tool names.');
    selected = [...new Set(args.names as string[])].map(requested => {
      const tool = tools.find(tool => toolNameMatches(tool.name, requested.trim()));
      if (!tool) throw new Error('That tool is not in this session\'s available directory.');
      return tool;
    });
  }
  const group = typeof args.group === 'string' ? args.group.trim() : '';
  const terms = queryTerms(typeof args.query === 'string' ? args.query.trim() : '');
  const limit = Math.max(1, Math.min(20, Math.floor(Number(args.limit) || 10)));
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  const rows = selected.filter(tool => !group || tool.name.split('.')[0] === group).map(tool => {
    const text = `${tool.name} ${tool.description} ${tool.summary ?? ''}`.toLowerCase();
    const score = terms.reduce((total, term) => total + (tool.name.toLowerCase().includes(term) ? 4 : text.includes(term) ? 1 : 0), 0);
    return { tool, score };
  }).filter(row => !terms.length || row.score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  const page: Record<string, unknown>[] = [];
  let pageChars = 0;
  for (const { tool } of rows.slice(offset, offset + limit)) {
    const entry = args.includeSchema === true || args.names !== undefined
      ? { name: tool.name, description: tool.description, parameters: tool.parameters }
      : { name: tool.name, summary: (tool.summary || tool.description.split(/[。\n]/)[0]).slice(0, 160) };
    const chars = JSON.stringify(entry).length;
    // Leave room for the envelope under the executor's 12k result limit. Never skip an entry.
    if (page.length && pageChars + chars > 9000) break;
    page.push(entry); pageChars += chars;
  }
  return { tools: page, total: rows.length, ...(offset + page.length < rows.length ? { nextOffset: offset + page.length } : {}),
    groups: toolCapabilityIndex(tools), ...(rows.length ? {} : { hint: 'No matches; omit query to enumerate the available directory, or filter by group.' }) };
}

function toolCapabilityIndex(tools: readonly DiscoverableTool[]): string {
  const groups = new Map<string, number>();
  for (const tool of tools) {
    const group = tool.name.split('.')[0];
    if (group === 'tools') continue;
    groups.set(group, (groups.get(group) ?? 0) + 1);
  }
  const purposes: Record<string, string> = {
    sessions: 'session management/observation/messaging',
    browser: 'browser automation behind the single browser.run entry (open/navigate/click/fill/snapshot/screenshot; per-action params in the browser skill)',
    memory: 'memory and history', events: 'event subscribe/publish', share: 'work summaries',
    bgtasks: 'background commands/timed wake-ups', ui: 'interactive content/notify/input',
    attachments: 'attachment conversion', runtimes: 'runtime configuration',
    llm: 'model providers/quota', themes: 'themes', extensions: 'extension actions',
    automations: 'scheduled tasks', workflow: 'workflows',
    runs: 'external task delivery', terminal: 'terminal operations/screenshots',
    web: 'web page text', git: 'repository index', scheduler: 'scheduler policy',
    node_repl: 'persistent JavaScript', app: 'app info/help', intent: 'conditional trigger intents',
    mcp: 'third-party MCP servers via host relay'
  };
  return [...groups].map(([group, count]) => `${group}=${purposes[group] ?? group}(${count})`).join('; ');
}

function queryTerms(query: string): string[] {
  const terms = query.toLowerCase().split(/[\s,，。/]+/).filter(Boolean);
  for (const word of [...terms]) if (/^[\u3400-\u9fff]{3,}$/.test(word)) {
    for (let i = 0; i < word.length - 1; i++) terms.push(word.slice(i, i + 2));
  }
  return [...new Set(terms)];
}
