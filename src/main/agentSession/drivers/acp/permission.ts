import type { NativeApprovalChoice } from '../../../../shared/nativeSessionConfig';
import type { AcpMcpPermissionMetadata } from '../../../../shared/runtimeManifest';
import type { GuiDriverConnectInput } from '../../types';
import { evaluateNativeToolBoundary } from '../../tools/policy';
import { ACP_HOST_MCP_NAME } from './mcpServers';
import { acpNativeId } from './nativeConfig';

export const ACP_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export type AcpPermissionOutcome =
  | { outcome: { outcome: 'cancelled' } }
  | { outcome: { outcome: 'selected'; optionId: string } };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parsePermissionRequest(params: unknown) {
  const request = asRecord(params);
  const tool = asRecord(request.toolCall ?? request.tool_call);
  const toolCallId = acpNativeId(tool.toolCallId ?? tool.tool_call_id);
  const toolName = acpNativeId(tool.title) ?? acpNativeId(tool.kind) ?? 'tool';
  const input = asRecord(tool.rawInput ?? tool.raw_input ?? tool.input);
  const choices: NativeApprovalChoice[] = [];
  for (const item of Array.isArray(request.options) ? request.options.slice(0, 64) : []) {
    const option = asRecord(item);
    const id = acpNativeId(option.optionId ?? option.option_id);
    if (!id || choices.some(choice => choice.id === id)) continue;
    const kind = acpNativeId(option.kind);
    choices.push({
      id,
      name: typeof option.name === 'string' && option.name.trim() ? option.name.slice(0, 512) : id,
      kind,
      description: typeof option.description === 'string' ? option.description.slice(0, 4096) : undefined,
      ...(kind === 'allow_always' || kind === 'reject_always' ? { scope: 'persistent' }
        : kind === 'allow_once' || kind === 'reject_once' ? { scope: 'once' } : {})
    });
  }
  const preview = (Array.isArray(tool.content) ? tool.content.slice(0, 8) : []).map(item => {
    const content = asRecord(asRecord(item).content);
    return content.type === 'text' && typeof content.text === 'string' ? content.text.slice(0, 16_384) : '';
  }).filter(Boolean).join('\n\n');
  return { toolCallId, toolName, input, choices, preview };
}

export async function resolveAcpPermission(opts: {
  params: unknown;
  input: Pick<GuiDriverConnectInput, 'cwd' | 'workspaceContext' | 'hostTools' | 'requestApproval' | 'log'>;
  cancelled: () => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  mcpPermissionMetadata?: AcpMcpPermissionMetadata;
}): Promise<AcpPermissionOutcome> {
  const cancelled = { outcome: { outcome: 'cancelled' as const } };
  const { toolCallId, toolName, input, choices, preview } = parsePermissionRequest(opts.params);
  if (opts.cancelled() || opts.signal?.aborted || !toolCallId || !choices.length) return cancelled;
  const rawTool = asRecord(asRecord(opts.params).toolCall ?? asRecord(opts.params).tool_call);
  const metadata = opts.mcpPermissionMetadata;
  const mcpName = metadata ? asRecord(rawTool._meta)[metadata.toolNameKey] : undefined;
  const hostPrefix = `mcp__${ACP_HOST_MCP_NAME}__`;
  const ids = opts.input.hostTools.map(tool => tool.id);
  const engineName = acpNativeId(rawTool.name) ??
    (typeof mcpName === 'string' && /^mcp__[\w.-]+__[\w.-]+$/.test(mcpName) && mcpName.length <= 256 ? mcpName : toolName);
  const hostId = engineName.startsWith(hostPrefix) ? ids.find(id => id.replace(/\./g, '_') === engineName.slice(hostPrefix.length)) : undefined;
  const rule = () => evaluateNativeToolBoundary({
    engineToolName: hostId ?? engineName, input, cwd: opts.input.cwd, workspaceContext: opts.input.workspaceContext,
    hostToolIds: ids, hostClassOf: name => opts.input.hostTools.find(tool => tool.id === name)?.permissionClass ?? 'status'
  }, false);
  const first = rule();
  if (first.decision === 'deny' || JSON.stringify(first.updatedInput) !== JSON.stringify(input)) return cancelled;

  const controller = new AbortController();
  const cancel = () => controller.abort();
  opts.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, opts.timeoutMs ?? ACP_APPROVAL_TIMEOUT_MS);
  timer.unref?.();
  try {
    const abort = new Promise<null>(resolve => controller.signal.addEventListener('abort', () => resolve(null), { once: true }));
    const decision = await Promise.race([opts.input.requestApproval({
      toolCallId, toolName, input, nativeSource: 'ACP', nativeChoices: choices,
      ...(first.ruleReason || preview ? { reason: [first.ruleReason, preview].filter(Boolean).join('\n\n') } : {})
    }, controller.signal), abort]);
    if (opts.cancelled() || controller.signal.aborted || !decision ||
        JSON.stringify(rule()) !== JSON.stringify(first) ||
        !choices.some(choice => choice.id === decision.nativeChoiceId)) return cancelled;
    return { outcome: { outcome: 'selected', optionId: decision.nativeChoiceId! } };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', cancel);
  }
}
