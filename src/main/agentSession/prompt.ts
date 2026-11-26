import type { GuiWorkerMode, SessionMeta } from '../../shared/types';
import { renderAgentRulesSection, type AgentRule } from '../../shared/agentConduct';
import { contextHasRulesText } from './contextScan';
import { buildGuiWorkerPromptSections } from '../../shared/guiWorkerPrompt';
import type { GuiSessionToolset } from './tools/registry';
import type { GuiDriverConnectInput } from './types';
import type { WorkspaceExecutionContext } from '../../shared/workspaceExecutionContext';

const HOST_CONTEXT_OPEN = '<muster_host_context source="automatic">';
const HOST_CONTEXT_CLOSE = '</muster_host_context>';

/** Delimit host-supplied text before joining it with the user's input. */
export function formatGuiHostContext(...sections: Array<string | null | undefined>): string {
  const body = sections.filter(section => section?.trim()).join('\n\n');
  if (!body) return '';
  const escaped = body.replaceAll(HOST_CONTEXT_OPEN, '&lt;muster_host_context source="automatic"&gt;')
    .replaceAll(HOST_CONTEXT_CLOSE, '&lt;/muster_host_context&gt;');
  return `${HOST_CONTEXT_OPEN}\n${escaped}\n${HOST_CONTEXT_CLOSE}`;
}

/** For adapters that deliver mode or extension instructions through the first input. */
export function firstGuiUserMessageContext(input: Pick<GuiDriverConnectInput, 'firstPromptPrefix' | 'systemPromptAppend'>): string {
  return formatGuiHostContext(input.firstPromptPrefix?.trim(), input.systemPromptAppend.trim());
}

/** Keep the user's input verbatim and place first-turn host guidance after it. */
export function appendGuiHostContext(text: string, context: string | null | undefined): string {
  return context ? (text ? `${text}\n\n${context}` : context) : text;
}

export function materializeGuiWorkerPrompt(
  session: Pick<SessionMeta, 'id' | 'cwd' | 'worktreePath' | 'parentSessionId'>,
  mode: GuiWorkerMode,
  toolset: Pick<GuiSessionToolset, 'runtimeId' | 'hostTools'>,
  options: {
    rules?: AgentRule[];
    memorySection?: string;
    workspaceContext?: WorkspaceExecutionContext;
    workspaceSection?: string;
    piLoadsProjectContext?: boolean;
  } = {}
): { text: string; policy: string } {
  const { runtimeId, hostTools } = toolset;
  const { rules, memorySection, workspaceContext, workspaceSection } = options;
  const mcpNamespace = ['claude', 'codex-gui', 'acp', 'zcode-gui'].includes(runtimeId);
  const rulesInProjectContext = runtimeId === 'pi' && options.piLoadsProjectContext && session.cwd?.trim() &&
    contextHasRulesText(session.cwd, renderAgentRulesSection(rules));
  const worktreeInScope = workspaceContext?.mappings.some(mapping => mapping.worktreePath === session.worktreePath);
  const { opening, guidance } = buildGuiWorkerPromptSections({
    sessionId: session.id,
    cwd: workspaceContext ? undefined : session.cwd,
    worktreePath: worktreeInScope ? undefined : session.worktreePath,
    mode: runtimeId === 'pi' ? mode : undefined,
    tools: hostTools,
    hostToolNamePrefix: mcpNamespace ? 'mcp__muster__' : undefined,
    isSubagent: !!session.parentSessionId?.trim(),
    isolated: !!workspaceContext?.mappings.length,
    rules: rulesInProjectContext ? undefined : rules,
    memorySection: runtimeId === 'pi' ? undefined : memorySection
  });
  const policy = [opening, guidance].filter(Boolean).join('\n\n');
  return {
    policy,
    text: workspaceSection ? [opening, workspaceSection, guidance].filter(Boolean).join('\n\n') : policy
  };
}
