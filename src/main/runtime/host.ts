import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeJsonAtomicSync } from '../atomicJson';
import { t } from '../../shared/i18n';
import WebSocket from 'ws';
import { normalizeHarnessIntegration } from '../../shared/harnessIntegration';
import { inboundMcpLaunch } from '../inboundMcp/launch';
import type { WorkspaceExecutionContext } from '../../shared/workspaceExecutionContext';
import { additionalExecutionDirectories } from '../workspaceExecutionContext';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeRuntimeManifest, type RuntimeManifest } from '../../shared/runtimeManifest';
import { bindManifestCommands, manifestExecutable, manifestLaunch } from './manifestLaunch';
import { publishRuntimeManifests } from './manifestCatalog';
import { HARNESS_CATALOG } from '../../shared/harnessCatalog';
import { cliArgsForSession } from '../../shared/cliLaunchOptions';
import { errorMessage } from '../../shared/errors';
import { resolveUserCodexExecutable } from '../agentSession/drivers/codex/executable';
import type {
  AgentRuntimeEntry,
  RuntimeInjectStrategy,
  RuntimeModule,
  TerminalResumeCheck
} from './types';

/**
 * Development builds can launch Electron before electron-vite's asset-copy
 * hook has materialized `out/main/runtime/builtins`. Prefer the bundled path,
 * but use the source tree as an explicit un-packaged fallback so startup does
 * not enter a half-initialized runtime registry state.
 */
export function resolveRuntimeBuiltinsDir(
  bundledDir: string,
  sourceDir?: string,
  allowSourceFallback = false
): string {
  if (fs.existsSync(path.join(bundledDir, 'registry.json'))) return bundledDir;
  if (allowSourceFallback && sourceDir && fs.existsSync(path.join(sourceDir, 'registry.json'))) return sourceDir;
  return bundledDir;
}
export interface UpdateRuntimePatch {
  label?: string;
  enabled?: boolean;
  extraArgs?: string[];
  scriptSource?: string;
}

type StoredRuntime = AgentRuntimeEntry & { manifestApproval?: string };
const manifestFingerprint = (manifest: RuntimeManifest): string =>
  createHash('sha256').update(JSON.stringify(manifest)).digest('hex');

export class RuntimeHost {
  private root: string;
  private builtinsDir: string;
  private entries: StoredRuntime[] = [];
  private moduleCache = new Map<string, { mod: RuntimeModule; mtime: number; }>();
  private onChange?: () => void;
  private listeners = new Set<() => void>();

  constructor(opts: { userDataDir: string; builtinsDir: string; onChange?: () => void; }) {
    this.root = userDataStorage(opts.userDataDir).resolve('app', 'agent-runtimes');
    this.builtinsDir = opts.builtinsDir;
    this.onChange = opts.onChange;
  }

  get rootDir(): string {
    return this.root;
  }

  async ensureSeeded(): Promise<void> {
    const regPath = path.join(this.root, 'registry.json');
    if (!fs.existsSync(regPath)) {
      fs.mkdirSync(path.join(this.root, 'scripts'), { recursive: true });
      const seed = JSON.parse(
        fs.readFileSync(path.join(this.builtinsDir, 'registry.json'), 'utf8')
      ) as { runtimes: AgentRuntimeEntry[]; };
      const scriptsSrc = path.join(this.builtinsDir, 'scripts');
      for (const e of seed.runtimes) {
        if ((e.surface ?? 'pty') === 'chat' || !e.script) continue; // chat runtime 无脚本
        const src = path.join(scriptsSrc, e.script);
        const dest = path.join(this.root, 'scripts', e.script);
        fs.copyFileSync(src, dest);
      }
      fs.writeFileSync(regPath, JSON.stringify({ version: 1, runtimes: seed.runtimes }, null, 2));
    } else {
      this.refreshBuiltinScripts();
    }
    this.ensureHelperScripts();
    this.migrateBuiltins();
    this.reload();
  }

  /** builtin 脚本随内置源刷新：脚本仅在 registry.json 缺失时首种，否则 builtin 修复
   * 永远到不了存量安装（改 src/out 不生效，重启也只加载 userData 旧副本）。
   * 只覆盖内置种子脚本；内容一致不写（保 mtime 稳定，
   * 避免每次启动无谓变更触发 loadModule 重导入）。 */
  private refreshBuiltinScripts(): void {
    let seed: { runtimes: AgentRuntimeEntry[]; };
    try {
      seed = JSON.parse(fs.readFileSync(path.join(this.builtinsDir, 'registry.json'), 'utf8'));
    } catch {
      return; // 内置源不可读：不阻断启动，保持现有副本
    }
    const scriptsSrc = path.join(this.builtinsDir, 'scripts');
    for (const e of seed?.runtimes ?? []) {
      if (!e.builtin || (e.surface ?? 'pty') === 'chat' || !e.script) continue;
      const src = path.join(scriptsSrc, e.script);
      const dest = path.join(this.root, 'scripts', e.script);
      let srcText: string;
      try { srcText = fs.readFileSync(src, 'utf-8'); } catch { continue; }
      let destText: string | undefined;
      try { destText = fs.readFileSync(dest, 'utf-8'); } catch { /* 缺失则补种 */ }
      if (destText === srcText) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, srcText);
    }
  }

  /** Merge and upgrade builtin entries in existing registries. */
  private migrateBuiltins(): void {
    const regPath = path.join(this.root, 'registry.json');
    if (!fs.existsSync(regPath)) return;
    const seed = JSON.parse(
      fs.readFileSync(path.join(this.builtinsDir, 'registry.json'), 'utf8')
    ) as { runtimes: AgentRuntimeEntry[]; };
    const raw = this.readRegistryOrNull();
    if (!raw) return; // 坏档：不做迁移写入，现场保持原样，reload 自行回落 builtin 种子
    raw.runtimes ??= [];
    const seedById = new Map(
      (seed.runtimes ?? []).filter((e) => e.builtin).map((e) => [e.id, e])
    );
    const builtins = raw.runtimes.filter(entry => entry?.builtin && seedById.has(entry.id));
    const custom = raw.runtimes.filter(entry => entry && !entry.builtin && entry.manifest);
    let changed = builtins.length + custom.length !== raw.runtimes.length;
    raw.runtimes = [...builtins, ...custom];

    // 新增 builtin 种子（如 pi chat runtime）合并进已有 userData registry；
    // 被用户显式 remove 的内置项也按种子补回。
    for (const [id, seedEntry] of seedById) {
      if (!raw.runtimes.some((e) => e.id === id)) {
        raw.runtimes.push({ ...seedEntry, updatedAt: 0 });
        changed = true;
      }
    }

    // Retire factory service-plan runtimes without rebinding old sessions.
    const retained = raw.runtimes.filter(entry => !(entry.builtin && (entry.id === 'glm' || entry.id === 'mimo')));
    if (retained.length !== raw.runtimes.length) {
      raw.runtimes = retained;
      changed = true;
    }

    // 升级清理：DSH runtime 已整体移除，滤掉 userData registry 里的历史 dsh 条目
    const dshCount = raw.runtimes.filter((e) => e.id === 'dsh').length;
    if (dshCount > 0) {
      raw.runtimes = raw.runtimes.filter((e) => e.id !== 'dsh');
      changed = true;
    }

    for (const entry of raw.runtimes) {
      if (!entry.builtin) continue;
      const seedEntry = seedById.get(entry.id);
      if (!seedEntry) continue;
      // Normalize only known factory labels in the current Muster registry.
      if (entry.id === 'pi' && (entry.label === 'Pi' || entry.label === 'MetaAgent Core')) {
        entry.label = seedEntry.label;
        changed = true;
      }
      if (entry.script !== seedEntry.script) {
        entry.script = seedEntry.script;
        changed = true;
      }
      // surface 由种子权威定义（缺省 pty）
      const seedSurface = seedEntry.surface ?? 'pty';
      if ((entry.surface ?? 'pty') !== seedSurface) {
        entry.surface = seedSurface;
        changed = true;
      }
      // Old builtin CLI entries were seeded off. Adopt the new default only while
      // untouched; update() stamps updatedAt when a user deliberately changes it.
      if (seedSurface === 'pty' && seedEntry.enabled && !entry.enabled && entry.updatedAt === 0) {
        entry.enabled = true;
        changed = true;
      }
      // 清除历史种子写入的 detectManifestId（detect TOML 引擎已移除，字段不再是契约）
      if ('detectManifestId' in entry) {
        delete (entry as Record<string, unknown>).detectManifestId;
        changed = true;
      }
      // chat runtime 无脚本，跳过脚本内容升级
      if (seedSurface === 'pty' && seedEntry.script) {
        // 开箱脚本内容升级：种子 builtinScriptVersion 更高时覆盖 userData 脚本。
        // 文件缺失时无条件恢复（P1-5）：remove builtin 删了脚本，重启按种子补回条目时
        // 版本相等（seedVer == curVer）走不到复制——「有条目无脚本」会让预检永远
        // script_missing，与「builtin 会被补回」的自愈语义矛盾
        const seedVer = seedEntry.builtinScriptVersion ?? 0;
        const curVer = entry.builtinScriptVersion ?? 0;
        const dest = path.join(this.root, 'scripts', seedEntry.script);
        if (seedVer > curVer || !fs.existsSync(dest)) {
          const src = path.join(this.builtinsDir, 'scripts', seedEntry.script);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
            entry.builtinScriptVersion = Math.max(seedVer, curVer);
            this.moduleCache.delete(entry.id);
            changed = true;
          }
        }
      }
      const integrations = seedEntry.manifest?.integrations ?? seedEntry.integrations;
      if (JSON.stringify(entry.integrations) !== JSON.stringify(integrations)) {
        entry.integrations = normalizeHarnessIntegration(integrations); changed = true;
      }
      if (JSON.stringify(entry.manifest) !== JSON.stringify(seedEntry.manifest)) {
        entry.manifest = seedEntry.manifest; changed = true;
      }
    }
    if (changed) {
      writeJsonAtomicSync(regPath, { version: 1, runtimes: raw.runtimes });
    }
  }

  /** Copy/refresh builtins/scripts/_*.mjs into userData (infra helpers + agent-hook 分发副本). */
  private ensureHelperScripts(): void {
    const scriptsDest = path.join(this.root, 'scripts');
    const scriptsSrc = path.join(this.builtinsDir, 'scripts');
    if (!fs.existsSync(scriptsSrc)) return;
    fs.mkdirSync(scriptsDest, { recursive: true });
    for (const name of fs.readdirSync(scriptsSrc)) {
      if (!name.startsWith('_') || !name.endsWith('.mjs')) continue;
      const dest = path.join(scriptsDest, name);
      // 内容有变即覆盖：`_` 前缀是宿主基建（非用户 runtime 脚本），随版本升级分发
      let stale = !fs.existsSync(dest);
      if (!stale) {
        try {
          stale = fs.readFileSync(dest, 'utf8') !== fs.readFileSync(path.join(scriptsSrc, name), 'utf8');
        } catch {
          stale = true;
        }
      }
      if (stale) fs.copyFileSync(path.join(scriptsSrc, name), dest);
    }
  }

  /**
   * F-02（agent-runtime-registration）：registry.json 损坏（外部手改/异常半写）不得让裸
   * SyntaxError 沿 ensureSeeded/reload 上抛炸掉启动与注册广播链。解析失败时保留现场副本
   * （registry.json.bad）+ console.warn，返回 null 由调用方回落 builtin 种子（可从副本人工恢复）。
   */
  private readRegistryOrNull(): { runtimes: StoredRuntime[] } | null {
    const regPath = path.join(this.root, 'registry.json');
    try {
      const raw = JSON.parse(fs.readFileSync(regPath, 'utf8'));
      if (!Array.isArray(raw?.runtimes)) throw new Error('Invalid runtime registry');
      return raw;
    } catch (error) {
      const bad = `${regPath}.bad`;
      try {
        fs.copyFileSync(regPath, bad);
      } catch {
        // 现场副本保留失败时仍回落种子，不让启动链中断
      }
      console.warn(`[runtime-registry] registry.json 解析失败，已保留现场副本 ${bad}，回落 builtin 种子:`, error instanceof Error ? error.message : error);
      return null;
    }
  }

  reload(): void {
    const raw = this.readRegistryOrNull() ?? JSON.parse(
      fs.readFileSync(path.join(this.builtinsDir, 'registry.json'), 'utf8')
    ) as { runtimes: StoredRuntime[] };
    const seed = JSON.parse(fs.readFileSync(path.join(this.builtinsDir, 'registry.json'), 'utf8')) as { runtimes: AgentRuntimeEntry[] };
    const seedById = new Map(seed.runtimes.filter(entry => entry.builtin).map(entry => [entry.id, entry]));
    const reserved = new Set([...seedById.keys(), ...HARNESS_CATALOG.flatMap(product =>
      [product.id, product.acpPresetId, product.cliRuntimeId].filter((id): id is string => !!id)), 'shell', 'glm', 'mimo', 'dsh']);
    const seen = new Set<string>();
    this.entries = (raw.runtimes ?? []).flatMap<StoredRuntime>(entry => {
      if (!entry || typeof entry.id !== 'string' || seen.has(entry.id.toLowerCase())) return [];
      const builtin = seedById.get(entry.id);
      if (!entry.builtin) {
        if (!entry.manifest) return [];
        try {
          const manifest = normalizeRuntimeManifest(entry.manifest);
          if (reserved.has(entry.id.toLowerCase()) || entry.id !== manifest.id || entry.manifestApproval !== manifestFingerprint(manifest) ||
              [manifest.terminal, manifest.chat].some(endpoint => endpoint && !path.isAbsolute(endpoint.command))) {
            throw new Error('Unapproved or conflicting declaration');
          }
          seen.add(entry.id.toLowerCase());
          return [{ id: entry.id, manifest, manifestApproval: entry.manifestApproval, label: entry.label || manifest.label,
            builtin: false, enabled: entry.enabled === true, integrations: manifest.integrations, script: '',
            surface: manifest.terminal ? 'pty' : 'chat', updatedAt: entry.updatedAt }];
        } catch {
          console.warn('[runtime-registry] Ignored invalid or unapproved Runtime Manifest');
          return [];
        }
      }
      if (!builtin) return [];
      seen.add(entry.id.toLowerCase());
      const manifest = builtin.manifest ? normalizeRuntimeManifest(builtin.manifest) : undefined;
      return [{
        id: builtin.id,
        label: entry.label,
        script: builtin.script,
        builtin: true,
        enabled: entry.enabled,
        surface: builtin.surface,
        ...(builtin.terminalResume ? { terminalResume: builtin.terminalResume } : {}),
        extraArgs: entry.extraArgs,
        // 保留旧安装的输入法显示提示；更新接口仍拒绝写入此退役字段。
        uiHints: (entry as AgentRuntimeEntry & { uiHints?: unknown }).uiHints,
        builtinScriptVersion: entry.builtinScriptVersion,
        integrations: manifest?.integrations ?? normalizeHarnessIntegration(builtin.integrations),
        manifest,
        updatedAt: entry.updatedAt
      } as AgentRuntimeEntry];
    });
    publishRuntimeManifests(this.root, this.entries);
  }

  list(): AgentRuntimeEntry[] {
    return this.entries.map(({ manifestApproval: _approval, ...e }) => {
      // Factory labels have one current display name; user-defined labels stay intact.
      return e.id === 'pi' && (e.label === 'Pi' || e.label === 'MetaAgent Core')
        ? { ...e, label: 'Muster Core' }
        : structuredClone(e);
    });
  }

  onChanged(cb: () => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }

  changed(): void {
    for (const cb of this.listeners) { try { cb(); } catch (e) { console.error("Runtime listener failed", e); } }
    try { this.onChange?.(); } catch (e) { console.error("Runtime broadcast failed", e); }
  }

  listEnabled(): AgentRuntimeEntry[] {
    return this.list().filter((e) => e.enabled);
  }

  get(id: string): AgentRuntimeEntry | undefined {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return undefined;
    const { manifestApproval: _approval, ...publicEntry } = entry;
    return structuredClone(publicEntry);
  }

  scriptPath(id: string): string {
    const e = this.get(id);
    if (!e) throw new Error(t('runtime 未注册: {{id}}', { id }));
    this.assertPtySurface(e);
    return path.join(this.root, 'scripts', e.script);
  }

  /** chat surface runtime 无拉起脚本；误走 pty 路径（allocate/resolveLaunch/脚本加载）时明确报错 */
  private assertPtySurface(e: AgentRuntimeEntry): void {
    if ((e.surface ?? 'pty') === 'chat') {
      throw new Error(
        t('runtime {{id}} 是内置 GUI（chat）runtime：无启动脚本，不走 pty 拉起；应由 AgentSessionHost 驱动', { id: e.id })
      );
    }
    if (!e.script) throw new Error(t('runtime {{id}} 缺少启动脚本', { id: e.id }));
  }

  async loadModule(id: string): Promise<RuntimeModule> {
    const manifest = this.get(id)?.manifest;
    const terminal = manifest?.terminal;
    if (terminal) return {
      async allocate() { return { sessionId: randomUUID() }; },
      resolveLaunch({ mode, extraArgs, cliLaunchOptions }) {
        if (mode !== 'start') throw new Error(`${id} declarative runtime cannot restore or fork a native conversation`);
        const command = manifestExecutable(terminal.command);
        if (!command) throw Object.assign(new Error(`Runtime executable was not found: ${terminal.command}`), { code: 'CLI_NOT_FOUND' });
        return manifestLaunch(command, cliArgsForSession(id, cliLaunchOptions, [...(terminal.args ?? []), ...extraArgs], manifest));
      },
      appendPrompt: () => false,
      canResume: () => false
    };
    const file = this.scriptPath(id);
    const mtime = fs.statSync(file).mtimeMs;
    const cached = this.moduleCache.get(id);
    if (cached && cached.mtime === mtime) return cached.mod;
    const href = pathToFileURL(file).href + `?t=${mtime}`;
    const mod = (await import(href)) as RuntimeModule;
    this.moduleCache.set(id, { mod, mtime });
    return mod;
  }

  async allocate(id: string, cwd: string): Promise<string> {
    const mod = await this.loadModule(id);
    const { sessionId } = await mod.allocate({ cwd });
    if (!sessionId?.trim()) throw new Error(t('runtime {{id}} allocate 未返回 sessionId', { id }));
    return sessionId.trim();
  }

  /** Build flags before prompt's `--`; scripts declare capability rather than host id switches. */
  async prepareWorkspaceDirectories(id: string, context?: WorkspaceExecutionContext): Promise<{ args: string[]; note: string; }> {
    const mod = await this.loadModule(id);
    const capability = mod.workspaceDirectories?.();
    if (!capability) return { args: [], note: 'This runtime adapter registers only cwd. Other roots are path references; edits outside cwd depend on the CLI permission settings. Create a session in the target root for reliable access. The host does not provide an OS sandbox for CLI tools.' +
      (context?.handoverDirectory ? ' The handover document is outside cwd; if the CLI sandbox blocks it, report that the user must allow this session-owned directory or choose another harness.' : '') };
    if (!/^--[a-z][a-z0-9-]*$/.test(capability.flag) || !capability.note?.trim()) throw new Error('invalid CLI workspace-directory capability');
    const directories = additionalExecutionDirectories(context);
    if (capability.maxExtraDirectories !== undefined && directories.length > capability.maxExtraDirectories) throw new Error(`${id}: supports at most ${capability.maxExtraDirectories} extra directories; received ${directories.length}. Select another runtime or reduce the workspace roots.`);
    if (capability.rejectCommas && directories.some(dir => dir.includes(','))) throw new Error(`${id}: a directory containing a comma cannot be represented by ${capability.flag}; select another runtime.`);
    return { args: directories.flatMap(dir => [capability.flag, dir]), note: capability.note };
  }

  async resolveLaunch(
    id: string,
    mode: 'start' | 'resume' | 'fork' | 'new',
    sessionId: string,
    cwd: string,
    extraArgs: string[],
    forkFromSessionId?: string,
    probe = false,
    env?: Record<string, string>,
    cliLaunchOptions?: import('../../shared/cliLaunchOptions').CliLaunchOptions,
    isolatedWorktree?: boolean
  ): Promise<import('./types').RuntimeLaunch> {
    const entry = this.entries.find(entry => entry.id === id);
    if (!probe && mode === 'resume' && entry?.terminalResume !== 'by-id') {
      throw new Error(`${id} terminal adapter cannot restore a native conversation`);
    }
    const mod = await this.loadModule(id);
    const launchEnv = env ? { ...env } : undefined;
    if (!probe && launchEnv && entry?.surface === 'pty' && entry.integrations?.mcp?.strategy === 'session') {
      const mcp = inboundMcpLaunch();
      if (!mcp) throw new Error('Host MCP entry was not found; build or reinstall the workbench before launching this CLI');
      launchEnv.MUSTER_INBOUND_MCP_LAUNCH = JSON.stringify(mcp);
    }
    const executable = id === 'codex' && entry?.builtin ? resolveUserCodexExecutable({
      env: launchEnv ?? process.env,
      lookupOnPath: () => []
    }) : null;
    const launch = await mod.resolveLaunch({ mode: mode === 'new' ? 'start' : mode, sessionId, cwd, extraArgs, forkFromSessionId, probe, WebSocket,
      ...(executable ? { executable } : {}),
      ...(mode === 'new' ? { newConversation: true } : {}),
      ...(isolatedWorktree ? { isolatedWorktree } : {}),
      ...(launchEnv ? { env: launchEnv } : {}), ...(cliLaunchOptions ? { cliLaunchOptions: { ...cliLaunchOptions } } : {}) });
    try {
      const interruptInput = launch.interruptInput ?? mod.interruptInput?.();
      if (interruptInput !== undefined && (typeof interruptInput !== 'string' || !interruptInput.length || interruptInput.length > 64))
        throw new Error('runtime interruptInput must be a non-empty control sequence of at most 64 characters');
      return { ...launch, ...(interruptInput !== undefined ? { interruptInput } : {}),
        ...(!launch.prepareInterrupt && mod.prepareInterrupt ? { prepareInterrupt: mod.prepareInterrupt.bind(mod) } : {}),
        ...(!launch.receiveMessage && mod.receiveMessage ? { receiveMessage: mod.receiveMessage.bind(mod) } : {}) };
    } catch (error) {
      try { launch.dispose?.(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'runtime launch validation and cleanup failed'); }
      throw error;
    }
  }

  async appendPrompt(id: string, prompt: string, extraArgs: string[]): Promise<boolean> {
    const mod = await this.loadModule(id);
    if (typeof mod.appendPrompt !== 'function') {
      const helpersHref = pathToFileURL(path.join(this.builtinsDir, 'scripts', '_helpers.mjs')).href;
      const { writeInjectPrompt } = (await import(helpersHref)) as {
        writeInjectPrompt: (prompt: string) => { file: string; promptArg: string; } | null;
      };
      const written = writeInjectPrompt(prompt);
      if (written) extraArgs.push('--', written.promptArg);
      return true;
    }
    return mod.appendPrompt({ prompt, extraArgs });
  }

  /** 派活时首条简报的注入方式（脚本未声明则按 initial-prompt） */
  async injectStrategy(id: string): Promise<RuntimeInjectStrategy> {
    const mod = await this.loadModule(id);
    if (typeof mod.injectStrategy !== 'function') return 'initial-prompt';
    return mod.injectStrategy() === 'relaunch-resume' ? 'relaunch-resume' : 'initial-prompt';
  }

  /** TTY 输入框是否支持 bracketed paste（脚本未声明则按不支持处理，走逐字键入） */
  async pasteInput(id: string): Promise<boolean> {
    const mod = await this.loadModule(id);
    return typeof mod.pasteInput === 'function' && mod.pasteInput() === true;
  }

  async canResume(id: string, cwd: string, sessionId: string): Promise<boolean> {
    const result = await this.checkTerminalResume(id, cwd, sessionId);
    if (result.status === 'failed') throw new Error(result.detail);
    return result.status === 'attempt';
  }

  async checkTerminalResume(id: string, cwd: string, sessionId?: string, extraArgs?: readonly string[]): Promise<TerminalResumeCheck> {
    const entry = this.get(id);
    if (entry?.terminalResume !== 'by-id') return { status: 'unsupported' };
    if (!sessionId?.trim()) return { status: 'unbound' };
    try {
      const mod = await this.loadModule(id);
      const input = { cwd, sessionId, extraArgs: [...(extraArgs ?? entry.extraArgs ?? [])] };
      if (mod.checkResume) {
        const status = await mod.checkResume(input);
        if (status !== 'attempt' && status !== 'unbound' && status !== 'missing' && status !== 'unsupported') {
          throw new Error('Invalid terminal resume check result');
        }
        return { status };
      }
      if (!mod.canResume) return { status: 'unsupported' };
      return { status: await mod.canResume(input) ? 'attempt' : 'missing' };
    } catch (error) {
      return { status: 'failed', detail: errorMessage(error) };
    }
  }

  /** P2：卸载该 runtime 在 cwd 装的状态 hooks（无该能力的 runtime 返回 0） */
  async uninstallDetectHooks(id: string, cwd: string): Promise<{ file: string; removed: number; }> {
    const mod = await this.loadModule(id);
    if (typeof mod.uninstallDetectHooks !== 'function') {
      return { file: '', removed: 0 };
    }
    return mod.uninstallDetectHooks({ cwd });
  }

  async validateScriptFile(file: string): Promise<void> {
    const href = pathToFileURL(file).href + `?validate=${Date.now()}`;
    const mod = await import(href);
    if (typeof mod.allocate !== 'function' || typeof mod.resolveLaunch !== 'function') {
      throw new Error(t('脚本须导出 allocate 与 resolveLaunch'));
    }
  }

  async update(id: string, patch: UpdateRuntimePatch): Promise<AgentRuntimeEntry> {
    if (Object.prototype.hasOwnProperty.call(patch, 'uiHints')) {
      throw new Error(t('uiHints 已移除，请从更新请求中删除该参数'));
    }
    const e = this.entries.find(entry => entry.id === id);
    if (!e) throw new Error(t('runtime 未注册: {{id}}', { id }));
    if (patch.scriptSource != null && e.manifest) throw new Error(t('声明式 Runtime 不接受脚本源码修改，请更新 Manifest'));
    if (patch.extraArgs !== undefined && e.manifest && !e.builtin) throw new Error('Registered runtime arguments are fixed by its approved manifest');
    if (patch.scriptSource != null) {
      const file = this.scriptPath(id);
      const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
      fs.writeFileSync(file, patch.scriptSource, 'utf8');
      try {
        await this.validateScriptFile(file);
      } catch (err) {
        if (previous !== undefined) fs.writeFileSync(file, previous, 'utf8');
        else if (fs.existsSync(file)) fs.unlinkSync(file);
        throw err;
      }
      this.moduleCache.delete(id);
    }
    if (patch.label !== undefined) e.label = patch.label;
    if (patch.enabled !== undefined) e.enabled = patch.enabled;
    if (patch.extraArgs !== undefined) e.extraArgs = patch.extraArgs;
    e.updatedAt = Date.now();
    this.persist();
    return this.get(id)!;
  }

  prepareManifest(raw: unknown): RuntimeManifest {
    const manifest = bindManifestCommands(normalizeRuntimeManifest(raw));
    const id = manifest.id.toLowerCase();
    const seed = JSON.parse(fs.readFileSync(path.join(this.builtinsDir, 'registry.json'), 'utf8')) as { runtimes: AgentRuntimeEntry[] };
    if (this.entries.some(entry => entry.id.toLowerCase() === id) || seed.runtimes.some(entry => entry.id.toLowerCase() === id) ||
        HARNESS_CATALOG.some(product => [product.id, product.acpPresetId, product.cliRuntimeId].includes(id)) ||
        ['shell', 'glm', 'mimo', 'dsh'].includes(id)) throw new Error(t('runtime 已注册: {{id}}', { id: manifest.id }));
    return manifest;
  }

  registerManifest(approved: RuntimeManifest): AgentRuntimeEntry {
    const manifest = this.prepareManifest(approved);
    if (manifestFingerprint(manifest) !== manifestFingerprint(approved)) throw new Error('Runtime launch configuration changed during confirmation');
    const entry: StoredRuntime = {
      id: manifest.id, label: manifest.label, script: '', builtin: false, enabled: true,
      surface: manifest.terminal ? 'pty' : 'chat', manifest, manifestApproval: manifestFingerprint(manifest),
      integrations: manifest.integrations, updatedAt: Date.now()
    };
    this.entries.push(entry);
    try { this.persist(); }
    catch (error) { this.entries.pop(); throw error; }
    return this.get(entry.id)!;
  }

  remove(id: string): { removed: true; id: string; } {
    const e = this.get(id);
    if (!e) throw new Error(t('runtime 未注册: {{id}}', { id }));
    if ((e.surface ?? 'pty') === 'pty' && e.script) {
      const file = path.join(this.root, 'scripts', e.script);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    const previous = this.entries;
    this.entries = previous.filter((x) => x.id !== id);
    try { this.persist(); }
    catch (error) { this.entries = previous; throw error; }
    this.moduleCache.delete(id);
    return { removed: true, id };
  }

  restoreBuiltins(ids?: string[]): AgentRuntimeEntry[] {
    const seed = JSON.parse(fs.readFileSync(path.join(this.builtinsDir, 'registry.json'), 'utf8')) as {
      runtimes: AgentRuntimeEntry[];
    };
    const seedList = (seed.runtimes ?? []).filter((e) => e.builtin);
    const targets = ids?.length
      ? ids.map((id) => {
          const found = seedList.find((s) => s.id === id);
          if (!found) throw new Error(t('不是开箱种子: {{id}}', { id }));
          return found;
        })
      : seedList;
    const now = Date.now();
    const restored: AgentRuntimeEntry[] = [];
    for (const seedEntry of targets) {
      if ((seedEntry.surface ?? 'pty') !== 'chat' && seedEntry.script) {
        const src = path.join(this.builtinsDir, 'scripts', seedEntry.script);
        const dest = path.join(this.root, 'scripts', seedEntry.script);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
      const manifest = seedEntry.manifest ? normalizeRuntimeManifest(seedEntry.manifest) : undefined;
      const next: AgentRuntimeEntry = { ...seedEntry, manifest, integrations: manifest?.integrations ?? seedEntry.integrations, updatedAt: now };
      const idx = this.entries.findIndex((e) => e.id === seedEntry.id);
      if (idx >= 0) this.entries[idx] = next;
      else this.entries.push(next);
      this.moduleCache.delete(seedEntry.id);
      restored.push(next);
    }
    this.persist();
    return restored;
  }

  private persist(): void {
    writeJsonAtomicSync(
      path.join(this.root, 'registry.json'),
      { version: 1, runtimes: this.entries }
    );
    publishRuntimeManifests(this.root, this.entries);
    this.changed();
  }
}
