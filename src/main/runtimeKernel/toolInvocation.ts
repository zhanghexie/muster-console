import { AsyncLocalStorage } from 'node:async_hooks';

/** Captured by a trusted driver/gateway, never deserialized from tool arguments. */
export interface ToolInvocation {
  sessionId: string;
  toolCallId: string;
  turnId?: string;
  actionId?: string;
}
const invocation = new AsyncLocalStorage<Readonly<ToolInvocation>>();
export function currentToolInvocation(): Readonly<ToolInvocation> | undefined { return invocation.getStore(); }
export function runWithToolInvocation<T>(source: ToolInvocation, execute: () => T): T {
  if (!source.sessionId || !source.toolCallId) throw new Error('Trusted tool invocation identity is required');
  const parent = invocation.getStore();
  // Projected tools expand into several actions without inventing a new model call.
  const value = parent?.sessionId === source.sessionId
    ? { ...parent, actionId: source.actionId ?? source.toolCallId }
    : { ...source };
  return invocation.run(Object.freeze(value), execute);
}
export function runOutsideToolInvocation<T>(execute: () => T): T { return invocation.exit(execute); }
