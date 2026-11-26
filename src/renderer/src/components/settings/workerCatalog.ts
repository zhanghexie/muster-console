import type { AgentRuntimeEntry, AppConfig } from '../../../../shared/types';
import { runtimeSurface } from '../../../../shared/types';
import { HARNESS_CATALOG, type HarnessCatalogEntry } from '../../../../shared/harnessCatalog';
import type { RuntimeAvailabilitySnapshot } from '../../../../shared/runtimeAvailability';
import type { RuntimePreflightResult } from '../../../../shared/runtimePreflight';
import { acpAgentEnabled } from '../../../../shared/acpAgentSettings';

export interface WorkerProduct {
  key: string;
  name: string;
  entry?: HarnessCatalogEntry;
  runtime?: AgentRuntimeEntry;
  terminal?: AgentRuntimeEntry;
  acpPresetId?: string;
  group: 'builtin' | 'local';
  mine: boolean;
  check?: RuntimePreflightResult;
  executable?: string;
  enabled: boolean;
  installUrl?: string;
  manifestEntry?: AgentRuntimeEntry;
}

/** A product owns optional chat and terminal endpoints; a transport is not a product. */
export function workerProducts(runtimes: AgentRuntimeEntry[], cfg: AppConfig,
  snapshot: RuntimeAvailabilitySnapshot | null): WorkerProduct[] {
  const consumed = new Set<string>(['acp']);
  const products: WorkerProduct[] = HARNESS_CATALOG.map(entry => {
    if (entry.runtimeId) consumed.add(entry.runtimeId);
    if (entry.cliRuntimeId) consumed.add(entry.cliRuntimeId);
    const runtime = runtimes.find(item => item.id === entry.runtimeId);
    const terminal = runtimes.find(item => item.id === entry.cliRuntimeId);
    const chatCheck = entry.acpPresetId ? snapshot?.acpPreflights?.[entry.acpPresetId] : snapshot?.runtimePreflights?.[entry.runtimeId ?? ''];
    const check = chatCheck ?? (!runtime && terminal ? snapshot?.runtimePreflights?.[terminal.id] : undefined);
    const executable = entry.acpPresetId ? snapshot?.acpExecutables?.[entry.acpPresetId] : check?.executable;
    const configured = entry.runtimeId === 'pi-external' || entry.runtimeId === 'omp'
      ? !!cfg.externalPi?.[entry.runtimeId]?.executable
      : entry.runtimeId === 'muse-gui' || entry.runtimeId === 'zcode-gui' ? !!cfg.externalHarness?.[entry.runtimeId]?.executable : false;
    const installed = check?.status === 'available' || check?.status === 'not_configured' ||
      (!!terminal && snapshot?.cliPrograms?.[terminal.id]?.status === 'found');
    return { key: `product:${entry.id}`, name: entry.name, entry, runtime, terminal, acpPresetId: entry.acpPresetId,
      group: entry.id === 'muster-core' ? 'builtin' : 'local', check, executable,
      mine: entry.id === 'muster-core' || installed || configured,
      enabled: !!terminal?.enabled || (!!runtime?.enabled && (!entry.acpPresetId || acpAgentEnabled(cfg, entry.acpPresetId))) };
  });
  for (const runtime of runtimes) {
    if (runtime.manifest) {
      const manifest = runtime.manifest;
      consumed.add(runtime.id);
      const chat = manifest.chat?.transport === 'acp' ? runtimes.find(item => item.id === 'acp') : undefined;
      products.push({ key: `manifest:${runtime.id}`, name: runtime.label, runtime: chat, terminal: manifest.terminal ? runtime : undefined,
        acpPresetId: manifest.chat ? manifest.id : undefined, group: 'local',
        mine: !runtime.builtin || !!snapshot?.acpExecutables?.[manifest.id] || snapshot?.cliPrograms?.[runtime.id]?.status === 'found',
        check: manifest.chat ? snapshot?.acpPreflights?.[manifest.id] : snapshot?.runtimePreflights?.[runtime.id],
        executable: manifest.chat ? snapshot?.acpExecutables?.[manifest.id] : undefined,
        enabled: (!!manifest.terminal && runtime.enabled) || (!!chat?.enabled && acpAgentEnabled(cfg, manifest.id) && (!!manifest.terminal || runtime.enabled)),
        installUrl: manifest.installUrl, manifestEntry: runtime });
      continue;
    }
    if (!runtime.builtin) continue;
    if (consumed.has(runtime.id)) continue;
    products.push({ key: `runtime:${runtime.id}`, name: runtime.label, group: 'local', mine: true,
      ...(runtimeSurface(runtime) === 'chat' ? { runtime } : { terminal: runtime }),
      check: snapshot?.runtimePreflights?.[runtime.id], enabled: runtime.enabled });
  }
  return products;
}
