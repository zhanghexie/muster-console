import { assertToolArguments } from '../../capabilities/schemaValidation';
import type { GuiHostTool } from '../types';

/**
 * A connection owns its tool list and caller identity. Every transport invokes
 * the same wrappers, so the model cannot supply a different session or cwd and
 * no transport can bypass the published parameter schema.
 */
export function bindSessionHostTools(
  tools: readonly GuiHostTool[],
  identity?: { sessionId: string; cwd: string }
): GuiHostTool[] {
  const aliases = new Map<string, string>();
  return tools.map((tool) => {
    const alias = tool.id.replace(/\./g, '_');
    const previous = aliases.get(alias);
    if (previous) throw new Error(`Host tool name collision: ${previous} and ${tool.id} both map to ${alias}`);
    aliases.set(alias, tool.id);
    return {
      ...tool,
      async execute(args, exec) {
        if (identity && (exec.sessionId !== identity.sessionId || exec.cwd !== identity.cwd)) {
          throw new Error('Host tool caller does not match the active session');
        }
        if (exec.signal?.aborted) throw new Error('Host tool call was cancelled');
        assertToolArguments(tool.parameters, args, tool.id);
        return tool.execute(args, identity ? { ...exec, ...identity } : exec);
      }
    };
  });
}
