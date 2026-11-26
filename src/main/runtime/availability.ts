import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentRuntimeEntry } from '../../shared/types';
import { runtimeSurface } from '../../shared/types';
import { HARNESS_CATALOG } from '../../shared/harnessCatalog';
import { acpAgentEnabled } from '../../shared/acpAgentSettings';
import { cliInstallHint, findOnPath } from '../../shared/runtimePreflight';
import type { RuntimeAvailabilitySnapshot } from '../../shared/runtimeAvailability';
import type { RuntimePreflightResult } from '../../shared/runtimePreflight';
import { getAcpPresets, resolveAcpLaunch } from '../agentSession/drivers/acp/agents';
import { resolveUserCodexExecutable } from '../agentSession/drivers/codex/executable';
import { manifestExecutable } from './manifestLaunch';
import { preflightRuntime, type PreflightDeps } from './preflight';
import { t } from '../../shared/i18n';

interface AvailabilityOptions {
  probe?: typeof preflightRuntime;
  presets?: () => Array<{ id: string; name: string }>;
  now?: () => number;
  probeTimeoutMs?: number;
}

type AvailabilityJob = { id: string; preset?: string; inspectDisabledChat?: boolean };

/** One startup snapshot, retained until an explicit user refresh. */
export class RuntimeAvailabilityReader {
  private cached?: { manifestKey: string; snapshot: RuntimeAvailabilitySnapshot };
  private pending?: { manifestKey: string; forced: boolean; promise: Promise<RuntimeAvailabilitySnapshot> };
  private queuedForced?: Promise<RuntimeAvailabilitySnapshot>;
  private generation = 0;
  private invalidation = 0;
  private readonly probe: typeof preflightRuntime;
  private readonly presets: NonNullable<AvailabilityOptions['presets']>;
  private readonly now: () => number;
  private readonly probeTimeoutMs: number;
  private initialError?: Error;

  constructor(private readonly deps: PreflightDeps, options: AvailabilityOptions = {}) {
    this.probe = options.probe ?? preflightRuntime;
    this.presets = options.presets ?? (() => getAcpPresets(path.dirname(deps.runtimes.rootDir)));
    this.now = options.now ?? Date.now;
    this.probeTimeoutMs = Math.max(1, Math.min(5000, options.probeTimeoutMs ?? 5000));
  }

  /** External settings can change without changing the runtime registry or AppConfig. */
  invalidate(): void {
    this.invalidation++;
    this.generation++;
  }

  private state(): { entries: AgentRuntimeEntry[]; presets: Array<{ id: string; name: string }>; key: string } {
    const entries = this.deps.runtimes.list();
    const presets = this.presets();
    const cfg = this.deps.config.get();
    // Never expose configuration credentials in the public availability snapshot or its revision.
    const key = crypto.createHash('sha256').update(JSON.stringify([
      entries, presets, cfg.workspace, cfg.llm, cfg.openai, cfg.cursor, cfg.claude, cfg.externalPi, cfg.externalHarness,
      process.env.PATH, process.env.PATHEXT
    ])).digest('hex');
    return { entries, presets, key };
  }

  async read(force = false): Promise<RuntimeAvailabilitySnapshot> {
    const manifestKey = JSON.stringify(this.deps.runtimes.list().filter(entry => entry.manifest));
    if (!force && this.cached?.manifestKey === manifestKey) {
      return this.selectableSnapshot(this.cached.snapshot);
    }
    if (this.cached && this.cached.manifestKey !== manifestKey) force = true;
    if (this.pending) {
      if (this.pending.manifestKey === manifestKey && (!force || this.pending.forced)) {
        return this.selectableSnapshot(await this.pending.promise);
      }
      // A click during the startup scan must run a fresh scan after it, since
      // an already-probed executable may have been installed in the meantime.
      // Coalesce simultaneous clicks into one subsequent manual scan.
      if (!this.queuedForced) {
        const pending = this.pending;
        const queued = (async (): Promise<RuntimeAvailabilitySnapshot> => {
          try { await pending.promise; } catch { /* The manual retry still gets a fresh scan. */ }
          return this.read(true);
        })();
        this.queuedForced = queued;
        void queued.then(
          () => { if (this.queuedForced === queued) this.queuedForced = undefined; },
          () => { if (this.queuedForced === queued) this.queuedForced = undefined; }
        );
      }
      return structuredClone(await this.queuedForced);
    }
    if (!force && this.initialError) throw this.initialError;
    let state: ReturnType<RuntimeAvailabilityReader['state']>;
    try { state = this.state(); }
    catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!this.cached) this.initialError = failure;
      throw failure;
    }
    const { entries, presets, key } = state;
    const host = this.deps.agentSessions;
    const generation = ++this.generation;
    const invalidation = this.invalidation;
    const promise = this.scan(entries, presets).then(snapshot => {
      if (invalidation !== this.invalidation || key !== this.state().key || host !== this.deps.agentSessions) {
        throw new Error(t('Worker 配置在检测期间变化，请手动重新检测'));
      }
      if (generation === this.generation) { this.cached = { manifestKey, snapshot }; this.initialError = undefined; }
      return snapshot;
    }).catch(error => {
      if (!this.cached) this.initialError = error instanceof Error ? error : new Error(String(error));
      throw error;
    });
    const pending = { manifestKey, forced: force, promise };
    this.pending = pending;
    try { return this.selectableSnapshot(await promise); }
    finally { if (this.pending === pending) this.pending = undefined; }
  }

  /** Apply current product preferences without discarding cached installation evidence. */
  private selectableSnapshot(snapshot: RuntimeAvailabilitySnapshot): RuntimeAvailabilitySnapshot {
    const result = structuredClone(snapshot);
    result.acpAgents = result.acpAgents.filter(agent => acpAgentEnabled(this.deps.config.get(), agent.id));
    if (!result.acpAgents.length) result.runtimes = result.runtimes.filter(runtime => runtime.id !== 'acp');
    return result;
  }

  /** The Core directory is selectable if an explicitly selectable model passes the normal probe. */
  private async probeJob(job: AvailabilityJob, expired: () => boolean): Promise<RuntimePreflightResult> {
    const options = { ...(job.preset ? { piModeId: job.preset } : {}),
      ...(job.inspectDisabledChat ? { inspectDisabledChat: true } : {}) };
    const initial = await this.probe(this.deps, job.id, options);
    if (job.id !== 'pi' || job.preset || initial.status !== 'not_configured' || expired()) return initial;

    const providers = this.deps.config.get().llm?.providers ?? [];
    for (const provider of providers) {
      // The model picker hides disabled providers and encodes the first `|` as
      // the provider/model separator. Also avoid resolution's fallback to a
      // different provider when configuration contains duplicate identifiers.
      if (provider.enabled === false || !provider.id || provider.id !== provider.id.trim() ||
          provider.id.includes('|') || providers.find(item => item.id === provider.id) !== provider) continue;
      for (const model of provider.models ?? []) {
        if (expired()) return initial;
        if (!model.id || model.id !== model.id.trim()) continue;
        const alternative = await this.probe(this.deps, job.id, {
          ...options, modelOverride: { providerId: provider.id, modelId: model.id }
        });
        if (alternative.ok && alternative.status === 'available') return {
          ...alternative,
          problems: [{ code: 'config_missing', message: t('默认模型不可用，请在新建会话时选择已配置的模型，或在大模型设置中调整默认模型。') }]
        };
        // A missing provider-wide prerequisite cannot improve by trying its
        // other models. In particular, avoid reloading config once per model
        // when the provider has no key; the first probe already tried reload.
        const current = this.deps.config.get().llm?.providers?.find(item => item.id === provider.id);
        if (!current || current.enabled === false || !current.apiKey?.trim() || !current.baseUrl?.trim()) break;
      }
    }
    return initial;
  }

  private async scan(entries: AgentRuntimeEntry[], presets: Array<{ id: string; name: string }>): Promise<RuntimeAvailabilitySnapshot> {
    const candidates = entries.filter(entry => entry.enabled && !(entry.manifest && !entry.manifest.terminal));
    const candidateIds = new Set(candidates.map(entry => entry.id));
    // Discover installed built-in GUI products even while disabled; this is
    // display-only and must not add them to selectable runtimes or ACP agents.
    const detectable = entries.filter(entry => entry.enabled || (entry.builtin && runtimeSurface(entry) === 'chat'
      && HARNESS_CATALOG.some(product => product.runtimeId === entry.id)));
    const cliPrograms: NonNullable<RuntimeAvailabilitySnapshot['cliPrograms']> = Object.create(null);
    for (const entry of entries) {
      if (!entry.manifest?.terminal) continue;
      const { command } = entry.manifest.terminal;
      cliPrograms[entry.id] = { command, status: manifestExecutable(command) ? 'found' : 'not_found' };
    }
    for (const entry of HARNESS_CATALOG) {
      const id = entry.cliRuntimeId;
      if (!id || !entries.some(runtime => runtime.id === id)) continue;
      const names = cliInstallHint(id).cli;
      if (!names.length) continue;
      if (id === 'codex' && resolveUserCodexExecutable({ lookupOnPath: () => [] })) {
        cliPrograms[id] = { command: names[0], status: 'found' };
        continue;
      }
      const pathEnv = process.env.PATH;
      let unknown = !pathEnv;
      const found = pathEnv ? findOnPath(names, {
        platform: process.platform,
        pathEnv: pathEnv.split(path.delimiter).map(dir => dir.trim().replace(/^"(.*)"$/, '$1')).join(path.delimiter),
        pathExt: process.env.PATHEXT,
        join: path.join,
        exists: candidate => {
          try {
            if (!fs.statSync(candidate).isFile()) return false;
            if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
            return true;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') unknown = true;
            return false;
          }
        }
      }) : null;
      cliPrograms[id] = { command: names[0], status: found ? 'found' : unknown ? 'unknown' : 'not_found' };
    }
    const acp = detectable.find(entry => entry.id === 'acp' && runtimeSurface(entry) === 'chat');
    const jobs: AvailabilityJob[] = [
      ...detectable.filter(entry => entry !== acp).map(entry => ({ id: entry.id, ...(!entry.enabled ? { inspectDisabledChat: true } : {}) })),
      ...(acp ? presets.map(preset => ({ id: acp.id, preset: preset.id, inspectDisabledChat: true })) : [])
    ];
    const passed = new Set<string>();
    const passedAcp = new Set<string>();
    const runtimePreflights: Record<string, RuntimePreflightResult> = Object.create(null);
    const acpPreflights: Record<string, RuntimePreflightResult> = Object.create(null);
    const acpExecutables: Record<string, string> = Object.create(null);
    let next = 0;
    // Local probes can touch executable discovery and trusted snapshots; keep their concurrency bounded.
    await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        try {
          let timer: ReturnType<typeof setTimeout> | undefined;
          let result;
          let expired = false;
          try {
            result = await Promise.race([
              this.probeJob(job, () => expired),
              new Promise<null>(resolve => { timer = setTimeout(() => { expired = true; resolve(null); }, this.probeTimeoutMs); })
            ]);
          } finally { expired = true; if (timer !== undefined) clearTimeout(timer); }
          if (job.preset) {
            acpPreflights[job.preset] = result ?? {
              id: job.id, surface: 'chat', status: 'unknown', ok: false,
              checkedAt: this.now(), problems: [{ code: 'error', message: t('检测超时，请重试') }]
            };
            if (result?.ok && result.status === 'available') {
              const rootDir = this.deps.runtimes.rootDir;
              if (typeof rootDir === 'string' && rootDir) {
                const current = resolveAcpLaunch(job.preset, undefined, getAcpPresets(path.dirname(rootDir)));
                if (!('error' in current) && current.executable) acpExecutables[job.preset] = current.executable;
              }
            }
          } else {
            runtimePreflights[job.id] = result ?? {
              id: job.id, surface: runtimeSurface(entries.find(entry => entry.id === job.id)), status: 'unknown', ok: false,
              checkedAt: this.now(), problems: [{ code: 'error', message: t('检测超时，请重试') }]
            };
          }
          // A deadline bounds waiting; it does not claim to terminate arbitrary trusted script code.
          if (candidateIds.has(job.id) && result?.ok && result.status === 'available') {
            passed.add(job.id);
            if (job.preset) passedAcp.add(job.preset);
          }
        } catch (error) {
          if (job.preset) acpPreflights[job.preset] = {
            id: job.id, surface: 'chat', status: 'unknown', ok: false,
            checkedAt: this.now(), problems: [{ code: 'error', message: (error as Error)?.message || t('检测失败') }]
          };
          else runtimePreflights[job.id] = {
            id: job.id, surface: runtimeSurface(entries.find(entry => entry.id === job.id)), status: 'unknown', ok: false,
            checkedAt: this.now(), problems: [{ code: 'error', message: (error as Error)?.message || t('检测失败') }]
          };
          // A failed or unknown probe never creates a selectable worker.
        }
      }
    }));
    return {
      runtimes: structuredClone(candidates.filter(entry => passed.has(entry.id))),
      runtimePreflights,
      cliPrograms,
      acpAgents: presets.filter(preset => passedAcp.has(preset.id)).map(({ id, name }) => ({ id, name })),
      acpPreflights,
      acpExecutables,
      checkedAt: this.now()
    };
  }
}

const readers = new WeakMap<object, RuntimeAvailabilityReader>();
export function invalidateRuntimeAvailability(runtimes: PreflightDeps['runtimes']): void {
  readers.get(runtimes)?.invalidate();
}
export function readRuntimeAvailability(deps: PreflightDeps, options: { force?: boolean } = {}): Promise<RuntimeAvailabilitySnapshot> {
  let reader = readers.get(deps.runtimes);
  if (!reader) { reader = new RuntimeAvailabilityReader(deps); readers.set(deps.runtimes, reader); }
  return reader.read(options.force === true);
}
