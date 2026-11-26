import fs from 'node:fs';
import { assertHarnessMcpPublicPath } from './publicPath';
export { assertHarnessMcpPublicPath } from './publicPath';
import type { AgentRuntimeEntry } from '../../shared/types';
import type { InboundMcpEngineFile, InboundMcpSetupStatus } from '../../shared/inboundMcp';
import { normalizeHarnessIntegration } from '../../shared/harnessIntegration';
import { openCodeMcpFile, type OpenCodeMcpLayout } from './opencode';
import { builtinMcpFile } from './builtinMcp';
import { resolveHarnessPath, type HarnessPathContext } from './resolve';
export interface HarnessMcpWorkspaceRoot { id: string; path: string; label?: string }
export function harnessMcpTargets(entries: AgentRuntimeEntry[], context: HarnessPathContext & { workspaceRoots?: HarnessMcpWorkspaceRoot[]; defaultOpenCodeLayout?: OpenCodeMcpLayout }): { files: InboundMcpEngineFile[]; statuses: InboundMcpSetupStatus['engines'] } {
  const files: InboundMcpEngineFile[] = [], statuses: InboundMcpSetupStatus['engines'] = [];
  const usedIds = new Set<string>(), destinations = new Set<string>();
  for (const entry of entries.filter(entry => entry.enabled)) {
    try {
      const mcp = normalizeHarnessIntegration(entry.integrations)?.mcp;
      if (mcp?.strategy === 'config-file') {
        const roots = mcp.base === 'workspace' ? context.workspaceRoots ?? (context.workspaceDir ? [{ id: 'workspace', path: context.workspaceDir }] : []) : [undefined];
        if (!roots.length) { statuses.push({ id: `runtime:${entry.id}`, label: entry.label, path: '', state: 'pending-workspace', detail: 'Waiting for a registered workspace source folder.' }); continue; }
        for (const root of roots) {
          const profile = mcp.dialect === 'opencode' ? openCodeMcpFile(context, context.defaultOpenCodeLayout)
            : mcp.dialect ? builtinMcpFile(mcp.dialect, context) : undefined;
          const pathContext = { ...context, workspaceDir: root?.path ?? context.workspaceDir };
          const destination = profile?.path ?? (() => {
            const primary = resolveHarnessPath(mcp, pathContext);
            if (!mcp.fallbacks?.length) return primary;
            for (const candidate of [mcp, ...(mcp.fallbacks ?? [])]) {
              const file = resolveHarnessPath(candidate, pathContext);
              assertHarnessMcpPublicPath(file);
              try { fs.lstatSync(file); return file; }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            }
            return primary;
          })();
          assertHarnessMcpPublicPath(destination);
          const id = `${mcp.id || entry.id}${root ? `:${root.id}` : ''}`;
          const key = (context.platform ?? process.platform) === 'win32' ? destination.toLowerCase() : destination;
          if (usedIds.has(id) || destinations.has(key)) throw new Error('Conflicting harness MCP configuration identity or destination');
          usedIds.add(id); destinations.add(key);
          files.push({ id, label: root ? `${entry.label} / ${root.label ?? root.id}` : entry.label, path: destination, format: mcp.format, serversKey: mcp.serversKey, ...profile });
        }
      } else statuses.push({ id: `runtime:${entry.id}`, label: entry.label, path: '', state: mcp?.strategy ?? 'unsupported', detail: mcp?.reason ?? 'No trusted MCP integration declaration is available for this harness.' });
    } catch (error) { statuses.push({ id: `runtime:${entry.id}`, label: entry.label, path: '', state: 'error', error: (error as Error).message }); }
  }
  return { files, statuses };
}
