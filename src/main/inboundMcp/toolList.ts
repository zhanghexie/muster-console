/**
 * 入站 MCP 工具表：投影自 hostTools preset + catalog schema（bgtasks 用 spec 内联 schema）。
 * R5：只投影 Worker 常驻清单 ∩ preset——发现层退役后常驻清单即全部可用面。
 */
import { WORKER_TOOL_ALLOWLIST } from '../capabilities/catalog';
import { type InboundMcpToolDef } from '../../shared/inboundMcp';
import { type HostToolPresetId } from '../../shared/hostTools';
import { workerPresetProjectedCatalog } from '../capabilities/catalog/projectedCatalog';

export function inboundMcpToolDefs(preset: HostToolPresetId = 'pty-allowlist'): InboundMcpToolDef[] {
  return workerPresetProjectedCatalog(preset, preset === 'pty-allowlist').map(entry => ({ name: entry.name.replace(/\./g, '_'),
    description: entry.def.description, inputSchema: entry.def.parameters }));
}

export function inboundMcpAllowlist(preset: HostToolPresetId = 'pty-allowlist'): readonly string[] {
  return workerPresetProjectedCatalog(preset, preset === 'pty-allowlist').map(entry => entry.name);
}

export { WORKER_TOOL_ALLOWLIST };
