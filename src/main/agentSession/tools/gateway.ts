import { runWithToolInvocation } from '../../runtimeKernel/toolInvocation';
import { assertToolArguments } from '../../capabilities/schemaValidation';
import type { GuiDriverConnectInput, GuiHostTool } from '../types';
import { decideToolCallPermission, evaluateNativeToolBoundary } from './policy';
import { describeDenyReason } from '../drivers/pi/approvalExtension';
import { isPlanToolName } from '../../../shared/planExtract';
import { runAsGuiExecutionTurn, runOutsideGuiExecutionTurn } from '../../agent/agentScope';
import { withDesktopCaptureImageScope, type DesktopCaptureImage } from '../../desktop/captureImageScope';
import { isDesktopLookCall } from '../../desktop/lookInvocation';

type GatewayInput = Pick<GuiDriverConnectInput,
  'sessionId' | 'cwd' | 'workspaceContext' | 'hostTools' | 'getPolicyState' | 'getTurnId' | 'requestApproval' | 'nativePermissions'> & {
    getDesktopTurnId?(): string | undefined;
  };
type GatewayCall = { id: string; signal?: AbortSignal; approvalName?: string;
  /** Captured by an authenticated transport before reading a potentially slow body. */
  desktopTurnSnapshot?: { id?: string; isCurrent(): boolean } };

export interface GuiHostToolResult { ok: boolean; text: string; errorEnvelope?: true; image?: DesktopCaptureImage; imageCurrent?: () => boolean }
type GuiPreparedHostTool = { ok: true; execute(): Promise<GuiHostToolResult> } | { ok: false; text: string };

/** Shared policy, identity and parameter boundary for protocol adapters. */
export function createGuiHostToolGateway(
  input: GatewayInput,
  options?: { isCurrent?: () => boolean; captureImages?: boolean }
): {
  invoke(name: string, args: unknown, call: GatewayCall): Promise<GuiHostToolResult>;
  prepare(name: string, args: unknown, call: GatewayCall): Promise<GuiPreparedHostTool>;
} {
  const byName = new Map<string, GuiHostTool>();
  for (const tool of input.hostTools) {
    for (const name of [tool.id, tool.id.replace(/\./g, '_')]) {
      const previous = byName.get(name);
      if (previous && previous.id !== tool.id) {
        throw new Error(`Host tool name collision: ${previous.id} and ${tool.id} map to ${name}`);
      }
      byName.set(name, tool);
    }
  }
  const hostToolIds = input.hostTools.map((tool) => tool.id);
  const hostClassOf = (id: string) => input.hostTools.find((tool) => tool.id === id)?.permissionClass ?? 'status';
  const prepare = async (name: string, args: unknown, call: GatewayCall): Promise<GuiPreparedHostTool> => {
      const turnId = input.getTurnId?.();
      const desktopTurnId = call.desktopTurnSnapshot ? call.desktopTurnSnapshot.id : input.getDesktopTurnId?.();
      const current = (): boolean => !call.signal?.aborted && (options?.isCurrent?.() ?? true) &&
        (!input.getTurnId || (!!turnId && input.getTurnId() === turnId));
      const desktopCurrent = (): boolean => current() && !!desktopTurnId && (call.desktopTurnSnapshot
        ? call.desktopTurnSnapshot.isCurrent() === true : input.getDesktopTurnId?.() === desktopTurnId);
      if (!current()) return { ok: false, text: 'The originating connection or request has closed.' };
      const tool = byName.get(name);
      if (!tool) return { ok: false, text: `Unknown host tool: ${name}` };
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return { ok: false, text: `Invalid parameters for ${tool.id}: expected an object.` };
      }
      try {
        const original = structuredClone(args as Record<string, unknown>);
        assertToolArguments(tool.parameters, original, tool.id);
        const evaluate = () => {
          const policy = input.nativePermissions ? undefined : input.getPolicyState();
          const request = {
            engineToolName: tool.id,
            input: original,
            cwd: input.cwd,
            sessionId: input.sessionId,
            workspaceContext: input.workspaceContext,
            hostToolIds,
            hostClassOf
          };
          const decision = policy ? decideToolCallPermission({ ...request, ...policy }) : evaluateNativeToolBoundary(request, true);
          return { policy, ...decision };
        };
        let first = evaluate();
        if (first.decision === 'deny') {
          return { ok: false, text: first.ruleReason ?? (first.policy
            ? describeDenyReason(first.policy.mode, first.policy.planExecuting, tool.id, first.updatedInput)
            : 'Host tool denied by its resource policy.') };
        }
        assertToolArguments(tool.parameters, first.updatedInput, tool.id);
        if (first.decision === 'prompt') {
          const before = JSON.stringify(first.policy);
          const approvedInput = JSON.stringify(first.updatedInput);
          const approvalName = call.approvalName ?? tool.id;
          const decision = await input.requestApproval({
            toolCallId: call.id,
            toolName: approvalName,
            input: first.updatedInput,
            requireHumanApproval: true,
            ...(first.ruleReason ? { reason: first.ruleReason } : {})
          }, !input.nativePermissions && isPlanToolName(approvalName) ? undefined : call.signal);
          if (!decision.approved) return { ok: false, text: decision.reason ?? 'User denied the tool call.' };
          if (!current()) return { ok: false, text: 'The originating connection or request has closed.' };
          const fresh = evaluate();
          const unchanged = fresh.decision === first.decision && JSON.stringify(fresh.policy) === before;
          if ((!unchanged && fresh.decision !== 'auto') || JSON.stringify(fresh.updatedInput) !== approvedInput) {
            return { ok: false, text: 'Tool permissions or parameters changed while awaiting approval. Please retry.' };
          }
          assertToolArguments(tool.parameters, fresh.updatedInput, tool.id);
          first = fresh;
        }
        if (!current()) return { ok: false, text: 'The originating connection or request has closed.' };
        const approvedState = JSON.stringify([first.policy, first.decision, first.updatedInput]);
        const approvedInput = structuredClone(first.updatedInput);
        let used = false;
        return { ok: true, async execute() {
          if (used) return { ok: false, text: 'The prepared host tool call has already been used.' };
          used = true;
          if (!current()) return { ok: false, text: 'The originating connection or request has closed.' };
          try {
            const fresh = evaluate();
            if (JSON.stringify([fresh.policy, fresh.decision, fresh.updatedInput]) !== approvedState) {
              return { ok: false, text: 'Tool permissions or parameters changed after preflight. Please retry.' };
            }
            assertToolArguments(tool.parameters, approvedInput, tool.id);
            const execute = () => runWithToolInvocation({ sessionId: input.sessionId, toolCallId: call.id, turnId }, () => tool.execute(approvedInput, {
              sessionId: input.sessionId, cwd: input.cwd, signal: call.signal
            }));
            const invoke = () => turnId ? runAsGuiExecutionTurn({ sessionId: input.sessionId, turnId, isCurrent: current,
              ...(desktopTurnId ? { desktopTurnId, isDesktopCurrent: desktopCurrent } : {}) }, execute)
              : runOutsideGuiExecutionTurn(execute);
            const captured: { value: string; image?: DesktopCaptureImage; imageCurrent?: () => boolean } = options?.captureImages && isDesktopLookCall(tool.id, approvedInput)
              ? await withDesktopCaptureImageScope(invoke) : { value: await invoke() };
            const text = captured.value;
            if (!current()) return { ok: false, text: 'The originating connection or request has closed.' };
            if (tool.resultFormat === 'execute-result-json') {
              try {
                const outcome: unknown = JSON.parse(text);
                if (!outcome || typeof outcome !== 'object' || typeof (outcome as { ok?: unknown }).ok !== 'boolean') {
                  throw new Error('Missing result status');
                }
                const envelope = outcome as { ok: boolean; error?: unknown };
                // A serialization fallback can include an error on an otherwise successful result.
                if (envelope.ok && envelope.error !== undefined) {
                  return { ok: false, errorEnvelope: true, text: JSON.stringify({ ...envelope, ok: false }) };
                }
                if (!envelope.ok) return { ok: false, errorEnvelope: true, text };
                return { ok: true, text, ...(captured.image
                  ? { image: captured.image, imageCurrent: captured.imageCurrent } : {}) };
              } catch {
                return { ok: false, text: 'Host tool returned an invalid result envelope.' };
              }
            }
            return { ok: true, text, ...(captured.image ? { image: captured.image, imageCurrent: captured.imageCurrent } : {}) };
          } catch (error) {
            return { ok: false, text: error instanceof Error ? error.message : String(error) };
          }
        } };
      } catch (error) {
        return { ok: false, text: error instanceof Error ? error.message : String(error) };
      }
  };
  return { prepare, async invoke(name, args, call) {
    const prepared = await prepare(name, args, call);
    return prepared.ok ? prepared.execute() : prepared;
  } };
}
