import { projectInterfaceToolResult } from './interfaceToolResult';
import { projectResourceToolResult } from './resourceToolResult';
import { projectSessionToolResult } from './sessionToolResult';

/** Project a public tool's payload only after its host-side consumers have used it. */
export function modelToolResult(name: string, args: Readonly<Record<string, unknown>>, value: unknown): unknown {
  // Each projector recognizes its own public actions and passes everything else
  // through. A new projection must also take effect at the shared wire boundary.
  const session = projectSessionToolResult(name, args, value);
  const resource = projectResourceToolResult(name, args, session);
  return projectInterfaceToolResult(name, args, resource);
}
