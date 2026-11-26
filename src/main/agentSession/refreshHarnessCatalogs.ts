import { HARNESS_CATALOG } from '../../shared/harnessCatalog';
import { cliCapabilities } from '../../shared/cliLaunchOptions';
import type { CatalogModelCoverage, CatalogModelProgress, HarnessCatalogRefreshRow } from '../../shared/harnessCatalogRefresh';
import type { RuntimeAvailabilitySnapshot } from '../../shared/runtimeAvailability';
import type { AppConfig } from '../../shared/types';
import { t } from '../../shared/i18n';
import { workspaceRootLabel } from '../../shared/workspaceRoots';
import type { AppContext } from '../context';
import { readRuntimeAvailability } from '../runtime/availability';
import { collectEnvSecrets, redactSafetyText } from '../safety/redact';
import { assertSessionTargetCurrent, resolveSessionTarget, type SessionTarget } from '../sessions/targets';
import { requireWorkspace, sourceRootsFor } from '../workspacePaths';
import { listAcpModels } from './drivers/acp/models';
import { listClaudeModels } from './drivers/claude/models';
import { listCodexModels } from './drivers/codex/models';
import { listExternalPiModels } from './drivers/externalPi/models';
import { listMuseModels } from './drivers/muse/process';
import { listZCodeModels } from './drivers/zcode/process';

type CatalogResult = { ok: true; items: unknown[]; warning?: string; coverage?: CatalogModelCoverage } | { ok: false; error: string; cleanupFailed?: true };
type CatalogEngine = {
  runtimeId: string;
  agentId?: string;
  name: string;
  read: (cwd: string, signal: AbortSignal, onProgress: (progress: CatalogModelProgress) => void) => Promise<CatalogResult>;
};

function catalogEngines(snapshot: RuntimeAvailabilitySnapshot, cfg: AppConfig, userDataDir: string): CatalogEngine[] {
  const available = new Map(snapshot.runtimes.filter(entry => entry.enabled).map(entry => [entry.id, entry]));
  const cliCanRead = (id: string | undefined): boolean => {
    const entry = id && available.get(id);
    return !!entry && !!cliCapabilities(entry.id, entry.manifest).model;
  };
  const enabled = (runtimeId: string, cli: string): boolean =>
    available.has(runtimeId) || (cliCanRead(cli) && snapshot.runtimePreflights?.[runtimeId]?.status === 'available');
  const jobs: CatalogEngine[] = [];
  const isolatedClaude = cfg.claude?.isolateConfig === true;
  const claudeChat = available.has('claude');
  const claudeTerminal = enabled('claude', 'claude-code') && cliCanRead('claude-code');
  const addClaude = (name: string, isolateConfig: boolean): void => {
    jobs.push({ runtimeId: 'claude', name, read: (cwd, signal) => listClaudeModels({ cwd, userDataDir, isolateConfig, refresh: true, signal }) });
  };
  if (claudeChat) addClaude(claudeTerminal && isolatedClaude ? t('Claude Code（工作台聊天）') : 'Claude Code', isolatedClaude);
  if (claudeTerminal && (!claudeChat || isolatedClaude)) addClaude(claudeChat ? t('Claude Code（原生终端）') : 'Claude Code', false);
  if (enabled('codex-gui', 'codex')) jobs.push({ runtimeId: 'codex-gui', name: 'Codex', read: (cwd, signal) => listCodexModels(cwd, true, signal) });

  const acp = new Map(snapshot.acpAgents.map(agent => [agent.id, agent.name]));
  for (const entry of HARNESS_CATALOG) {
    if (entry.acpPresetId && cliCanRead(entry.cliRuntimeId) && snapshot.acpPreflights?.[entry.acpPresetId]?.status === 'available') {
      acp.set(entry.acpPresetId, entry.name);
    }
  }
  for (const entry of available.values()) {
    const manifest = entry.manifest;
    if (manifest?.chat && cliCanRead(entry.id) && snapshot.acpPreflights?.[manifest.id]?.status === 'available') acp.set(manifest.id, entry.label);
  }
  for (const [agentId, name] of acp) jobs.push({ runtimeId: 'acp', agentId, name,
    read: (cwd, signal, onProgress) => listAcpModels({ cwd, agentId, userDataDir, signal, refresh: true, allModels: true, onProgress }) });

  for (const [runtimeId, cli, name] of [['pi-external', 'pi-external-cli', 'Pi'], ['omp', 'omp-cli', 'Oh My Pi']] as const) {
    if (enabled(runtimeId, cli)) jobs.push({ runtimeId, name,
      read: (cwd, signal) => listExternalPiModels({ cwd, runtimeId, executableOverride: cfg.externalPi?.[runtimeId]?.executable, refresh: true, signal }) });
  }
  if (enabled('muse-gui', 'muse-cli')) jobs.push({ runtimeId: 'muse-gui', name: 'Muse Code',
    read: (cwd, signal) => listMuseModels({ cwd, executableOverride: cfg.externalHarness?.['muse-gui']?.executable, refresh: true, signal }) });
  if (available.has('zcode-gui')) jobs.push({ runtimeId: 'zcode-gui', name: 'ZCode',
    read: (cwd, signal) => listZCodeModels({ cwd, executableOverride: cfg.externalHarness?.['zcode-gui']?.executable, refresh: true, signal }) });
  return jobs;
}

interface CatalogRefreshObservers {
  availability: () => void;
  catalogs: (workspace: string, rows: HarnessCatalogRefreshRow[]) => void;
  progress: (row: HarnessCatalogRefreshRow) => void;
  updated: (runtimeId: string, target: SessionTarget, agentId?: string) => void;
}

/** Explicit settings action. Catalogs share the normal adapter snapshots and process owners. */
export async function refreshHarnessCatalogs(ctx: AppContext, userDataDir: string, signal: AbortSignal, observers: CatalogRefreshObservers) {
  const requestedWorkspace = ctx.config.get().activeWorkspaceId;
  const availability = await readRuntimeAvailability(ctx, { force: true });
  if (signal.aborted) throw new Error(t('模型发现已取消'));
  observers.availability();
  const cfg = ctx.config.get();
  if (cfg.activeWorkspaceId !== requestedWorkspace) throw new Error(t('当前工作区已变化，请重试'));
  const workspace = requireWorkspace(cfg, requestedWorkspace);
  const engines = catalogEngines(availability, cfg, userDataDir);
  const roots = sourceRootsFor(workspace);
  const jobs = roots.flatMap(root => engines.map(engine => ({ engine, root })));
  const rows: HarnessCatalogRefreshRow[] = jobs.map(({ engine, root }, index) => ({
    id: String(index), name: engine.name, ...(roots.length > 1 ? { source: workspaceRootLabel(root) } : {}), state: 'queued'
  }));
  const secrets = [...collectEnvSecrets(process.env), ...(cfg.llm?.providers ?? []).map(provider => provider.apiKey)]
    .filter((value): value is string => typeof value === 'string' && value.length >= 4);
  const safe = (error: unknown): string => redactSafetyText(error instanceof Error ? error.message : String(error), secrets).slice(0, 600);
  observers.catalogs(workspace.name, rows);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, async () => {
    while (!signal.aborted && next < jobs.length) {
      const index = next++;
      const { engine, root } = jobs[index];
      const update = (patch: Partial<HarnessCatalogRefreshRow>): void => {
        rows[index] = { ...rows[index], ...patch };
        observers.progress(rows[index]);
      };
      const deadline = new AbortController();
      const abort = (): void => deadline.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, engine.runtimeId === 'acp' ? 125_000 : 30_000);
      timeout.unref?.();
      update({ state: 'reading' });
      try {
        const target = await resolveSessionTarget(cfg, { workspaceId: workspace.id, rootId: root.id, rootsRevision: workspace.rootsRevision });
        assertSessionTargetCurrent(ctx.config.get(), target);
        if (deadline.signal.aborted) throw new Error(t('模型发现已取消'));
        const result = await engine.read(target.cwd, deadline.signal, progress => update({ progress }));
        if (result.ok === false) {
          if (result.cleanupFailed) ctx.ui.notify(t('模型探测进程回收失败'), safe(result.error));
          throw new Error(deadline.signal.aborted && !signal.aborted && !result.cleanupFailed ? t('模型发现超时，请重试') : result.error);
        }
        assertSessionTargetCurrent(ctx.config.get(), target);
        if (deadline.signal.aborted) throw new Error(t(signal.aborted ? '模型发现已取消' : '模型发现超时，请重试'));
        const coverage = result.coverage;
        const partial = !!result.warning || (!!coverage && coverage.read < coverage.total);
        update({ state: partial ? 'partial' : 'done', models: result.items.length, progress: undefined,
          ...(coverage ? { coverage: { ...coverage, ...(coverage.detail ? { detail: safe(coverage.detail) } : {}) } } : {}),
          ...(result.warning ? { error: safe(result.warning) } : {}) });
        observers.updated(engine.runtimeId, target, engine.agentId);
      } catch (error) {
        update({ state: 'failed', progress: undefined, error: safe(error) });
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
      }
    }
  }));
  if (signal.aborted) throw new Error(t('模型发现已取消'));
  return { workspace: workspace.name, rows };
}
