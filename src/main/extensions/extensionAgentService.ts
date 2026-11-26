import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context';
import type { GuiHostTool } from '../agentSession/types';
import type { GuiWorkerHistoryPage, GuiWorkerPush } from '../../shared/guiWorker';
import { ExtensionDataStore } from './extensionData';
import { listJournalDays, readJournalDay } from '../memory/journal';
import { controlRootFor, defaultRootFor, requireSourceRoot } from '../../shared/workspaceRoots';
import type { ExtensionAgentSessionMeta } from '../../shared/extensionAgentSession';
import { extensionSidebarTaskRef } from './extensionSidebarTaskRef';
import { extensionSkillNames } from './extensionSkillNames';
import type { ExtensionManifest } from '../../shared/extensionManifest';
import type { ExtensionDomainInstanceIdentity } from '../../shared/extensionDomain';
import type { ExtensionDomainEvent } from '../../shared/extensionDomain';
import type { ExtensionDomainContext } from '../../shared/extensionDomain';
import { ExtensionRuntime } from './extensionRuntime';
import { extensionAgentToolsForSession } from './extensionAgentToolset';
import { ExtensionDomainRegistry } from './extensionDomainRegistry';
import { ExtensionAgentResourceManager, type ExtensionMcpTrust } from './extensionAgentResources';
import { ExtensionMcpSessionManager } from './extensionMcpSession';
import { extensionDomainInstanceKey } from '../../shared/extensionDomain';
import type { ExtensionModelGateway } from './extensionModelGateway';
import { llmChatStream } from './extensionLlm';

type ExtensionRuntimeBinding = { runtime: ExtensionRuntime; manifest: ExtensionManifest; identity: ExtensionDomainInstanceIdentity };

export class ExtensionAgentService {
  private readonly extensionSessions = new Map<string, ExtensionRuntimeBinding>();
  private readonly extensionBindings = new Map<string, ExtensionRuntimeBinding & { sessionId?: string }>();
  readonly extensionDomains: ExtensionDomainRegistry;
  readonly extensionResources: ExtensionAgentResourceManager;
  readonly extensionMcp: ExtensionMcpSessionManager;
  private readonly stopPush: () => void;
  private modelGateway?: ExtensionModelGateway;
  private closing?: Promise<void>;

  constructor(private readonly ctx: AppContext, private readonly userData: string, options?: { extensionDomains?: ExtensionDomainRegistry; extensionResources?: ExtensionAgentResourceManager; extensionMcp?: ExtensionMcpSessionManager }) {
    this.extensionDomains = options?.extensionDomains ?? new ExtensionDomainRegistry();
    this.extensionResources = options?.extensionResources ?? new ExtensionAgentResourceManager();
    this.extensionMcp = options?.extensionMcp ?? new ExtensionMcpSessionManager();
    this.stopPush = ctx.agentSessions?.onPush(push => this.onPush(push)) ?? (() => {});
  }

  setModelGateway(gateway: ExtensionModelGateway): void { this.modelGateway = gateway; }

  private onPush(_push: GuiWorkerPush): void {
    // The renderer already receives the standard AgentChatView push through
    // agentSession:event. Extension panels only need the domain event below.
  }

  history(sessionId: string): GuiWorkerHistoryPage | null {
    return this.ctx.agentSessions?.getHistoryRange(sessionId, undefined, 120) ?? null;
  }

  close(): Promise<void> {
    return this.closing ??= this.closeAllResources();
  }

  private async closeAllResources(): Promise<void> {
    this.stopPush();
    await Promise.allSettled(this.openingOwners.values());
    const releaseSessionIds = new Set([...this.extensionBindings.values()].flatMap(binding => binding.sessionId ? [binding.sessionId] : []));
    const extensionSessionIds = new Set([...this.extensionSessions.keys(), ...releaseSessionIds]);
    const runtimes = new Set([...this.extensionSessions.values(), ...this.extensionBindings.values()].map(binding => binding.runtime));
    this.extensionSessions.clear();
    this.extensionBindings.clear();
    this.openingOwners.clear();
    this.extensionResources.close();

    const results = await Promise.allSettled([
      ...[...extensionSessionIds].map(sessionId => this.extensionMcp.close(sessionId)),
      ...[...runtimes].map(runtime => runtime.close()),
      ...[...releaseSessionIds].map(sessionId => this.ctx.agentSessions?.release(sessionId)),
      this.extensionDomains.closeAll()
    ]);
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Extension Agent cleanup failed');
  }

  private readonly openingOwners = new Map<string, Promise<string | undefined>>();
  async domainOwner(identity: ExtensionDomainInstanceIdentity, manifest: ExtensionManifest, directory: string): Promise<string> {
    const existing = this.extensionBindings.get(extensionDomainInstanceKey(identity));
    if (existing?.sessionId && existing.identity.packageFingerprint === identity.packageFingerprint &&
        existing.identity.sourceRootId === identity.sourceRootId) return existing.sessionId;
    return (await this.openExtension(identity, manifest, directory, 'trusted-once')).sessionId;
  }

  async openExtension(identity: ExtensionDomainInstanceIdentity, manifest: ExtensionManifest, packageRoot: string, mcpTrust?: ExtensionMcpTrust): Promise<{ sessionId: string; meta: ExtensionAgentSessionMeta }> {
    if (!manifest.agent) throw new Error('Extension does not declare a host Agent');
    const sessionId = await this.openSidebar(identity, manifest, packageRoot, mcpTrust);
    if (!sessionId) throw new Error('Extension Agent Session is unavailable');
    return { sessionId, meta: this.extensionMeta(identity) };
  }

  async openPanel(identity: ExtensionDomainInstanceIdentity, manifest: ExtensionManifest, packageRoot: string, mcpTrust?: ExtensionMcpTrust): Promise<string | undefined> {
    return manifest.agent
      ? (await this.openExtension(identity, manifest, packageRoot, mcpTrust)).sessionId
      : this.openSidebar(identity, manifest, packageRoot);
  }

  hostToolSessionId(identity: ExtensionDomainInstanceIdentity, manifest: ExtensionManifest): string | undefined {
    const binding = manifest.agent && this.extensionBindings.get(extensionDomainInstanceKey(identity));
    if (!binding) return undefined;
    this.requireRuntimeBinding(identity, manifest, undefined);
    return binding.sessionId;
  }

  private async openSidebar(identity: ExtensionDomainInstanceIdentity, manifest: ExtensionManifest, packageRoot: string, mcpTrust?: ExtensionMcpTrust): Promise<string | undefined> {
    if (this.closing) throw new Error('Extension service is closing');
    const key = extensionDomainInstanceKey(identity);
    const pending = this.openingOwners.get(key);
    if (pending) {
      const result = await pending;
      const binding = this.extensionBindings.get(key);
      if (binding?.identity.packageFingerprint === identity.packageFingerprint && binding.identity.sourceRootId === identity.sourceRootId) return result;
      return this.openSidebar(identity, manifest, packageRoot, mcpTrust);
    }
    const opening = this.openDomainOwner(identity, manifest, packageRoot, mcpTrust);
    this.openingOwners.set(key, opening);
    try { return await opening; } finally { this.openingOwners.delete(key); }
  }

  private async openDomainOwner(identity: ExtensionDomainInstanceIdentity, manifest: ExtensionManifest, packageRoot: string, mcpTrust?: ExtensionMcpTrust): Promise<string | undefined> {
    if (manifest.id !== identity.extensionId || manifest.surface.kind !== 'sidebar' || !manifest.domain) {
      throw new Error('Extension requires a sidebar manifest with domain');
    }
    const workspace = this.ctx.config.get().workspaces.find(item => item.id === identity.workspaceId);
    if (!workspace) throw new Error('Extension workspace is unavailable');
    const key = extensionDomainInstanceKey(identity);
    const existing = this.extensionBindings.get(key);
    if (!manifest.agent) {
      if (existing && !existing.sessionId && existing.identity.packageFingerprint === identity.packageFingerprint &&
          existing.identity.sourceRootId === identity.sourceRootId) return undefined;
      await this.disposeBinding(key);
      const runtime = new ExtensionRuntime({ identity, manifest, packageRoot, domains: this.extensionDomains, resources: this.extensionResources });
      await runtime.open();
      this.extensionBindings.set(key, { runtime, manifest: structuredClone(manifest), identity: structuredClone(identity) });
      return undefined;
    }
    if (!manifest.permissions.includes('agent.state')) throw new Error('Extension Agent requires agent.state permission');
    if (!this.ctx.agentSessions) throw new Error('GUI Agent Session host unavailable');
    // The extension package is a resource root and may live outside every
    // registered project source folder (global packages intentionally do).
    // Pi sessions still need a registered cwd/root identity for the shared
    // workspace safety checks, so keep those two paths separate.
    const agentRoot = identity.sourceRootId ? requireSourceRoot(workspace, identity.sourceRootId) : defaultRootFor(workspace);
    if (existing?.sessionId && existing.identity.sourceRootId === identity.sourceRootId) {
      const sessionId = existing.sessionId;
      const current = this.ctx.sessions.get(sessionId);
      if (current) {
        if (existing.identity.packageFingerprint !== identity.packageFingerprint) {
          this.extensionBindings.delete(key);
          this.extensionSessions.delete(sessionId);
          await this.extensionMcp.close(sessionId).catch(() => {});
          await existing.runtime.close().catch(() => {});
          // Development reload keeps the persisted Pi transcript while
          // replacing the package-bound DomainRuntime and Agent resources.
          const runtime = new ExtensionRuntime({ identity, manifest, packageRoot, sessionId, sidebarTaskRef: extensionSidebarTaskRef(current, identity, manifest.scope), domains: this.extensionDomains, resources: this.extensionResources, ...(mcpTrust ? { mcpTrust } : {}) });
          try {
            await runtime.open();
            await this.extensionMcp.open({ sessionId, identity, manifest, packageRoot, resources: runtime.agentResourceMount() });
            const binding = { sessionId, runtime, manifest: structuredClone(manifest), identity: structuredClone(identity) };
            this.extensionBindings.set(key, binding);
            this.extensionSessions.set(sessionId, { runtime, manifest: structuredClone(manifest), identity: structuredClone(identity) });
            const reopened = current.archived ? this.ctx.sessions.setArchived(sessionId, false) : current;
            if (reopened.archived) throw new Error('Extension Agent Session could not be reopened');
            this.ctx.agentSessions.open(reopened);
            await this.waitForAgentSessionOpen(sessionId);
            return sessionId;
          } catch (error) {
            this.extensionBindings.delete(key);
            this.extensionSessions.delete(sessionId);
            await this.extensionMcp.close(sessionId).catch(() => {});
            await runtime.close().catch(() => {});
            await this.ctx.agentSessions.release(sessionId).catch(() => {});
            throw error;
          }
        } else {
          await this.extensionMcp.open({ sessionId, identity, manifest, packageRoot, resources: existing.runtime.agentResourceMount() });
          const reopened = current.archived ? this.ctx.sessions.setArchived(sessionId, false) : current;
          if (reopened.archived) throw new Error('Extension Agent Session could not be reopened');
          this.ctx.agentSessions.open(reopened);
          await this.waitForAgentSessionOpen(sessionId);
          return sessionId;
        }
      }
    }
    await this.disposeBinding(key);
    const session = await this.ctx.sessions.createTerminal({
      name: `${manifest.name} AI`,
      runtime: 'pi',
      cwd: agentRoot.path,
      workspaceId: identity.workspaceId,
      rootId: agentRoot.id,
      hidden: true,
      deferModelValidation: true,
      activate: false,
      injectHostIntro: false,
      meta: { extensionAgent: 'true', extensionId: identity.extensionId, extensionScope: manifest.scope, extensionInstanceId: identity.extensionInstanceId, extensionSkillNames: JSON.stringify(extensionSkillNames(manifest)) }
    });
    // 面板内助手的信任模型：读自动、编辑与命令确认（standard），不继承全局默认档。
    this.ctx.sessions.updateGuiMode(session.id, 'standard');
    const runtime = new ExtensionRuntime({ identity, manifest, packageRoot, sessionId: session.id, sidebarTaskRef: extensionSidebarTaskRef(session, identity, manifest.scope), domains: this.extensionDomains, resources: this.extensionResources, ...(mcpTrust ? { mcpTrust } : {}) });
    try {
      await runtime.open();
      await this.extensionMcp.open({ sessionId: session.id, identity, manifest, packageRoot, resources: runtime.agentResourceMount() });
      const binding = { sessionId: session.id, runtime, manifest: structuredClone(manifest), identity: structuredClone(identity) };
      this.extensionBindings.set(key, binding);
      this.extensionSessions.set(session.id, { runtime, manifest: structuredClone(manifest), identity: structuredClone(identity) });
      await this.waitForAgentSessionOpen(session.id);
      return session.id;
    } catch (error) {
      this.extensionBindings.delete(key);
      this.extensionSessions.delete(session.id);
      await this.extensionMcp.close(session.id).catch(() => {});
      await runtime.close().catch(() => {});
      await this.ctx.agentSessions.release(session.id).catch(() => {});
      throw error;
    }
  }

  async sendExtension(identity: ExtensionDomainInstanceIdentity, manifest: ExtensionManifest, packageRoot: string, text: string, mcpTrust?: ExtensionMcpTrust): Promise<unknown> {
    const opened = await this.openExtension(identity, manifest, packageRoot, mcpTrust);
    if (!this.ctx.agentSessions) throw new Error('GUI Agent Session host unavailable');
    return this.ctx.agentSessions.send(opened.sessionId, text, undefined, { steerOnBusy: false });
  }

  private async waitForAgentSessionOpen(sessionId: string): Promise<void> {
    if (!this.ctx.agentSessions) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.ctx.agentSessions.waitUntilOpen(sessionId),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); timer.unref?.(); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async releaseExtension(identity: ExtensionDomainInstanceIdentity): Promise<void> {
    const binding = this.extensionBindings.get(extensionDomainInstanceKey(identity));
    if (!binding?.sessionId || !this.ctx.agentSessions) return;
    // Releasing a sidebar archives the Pi connection and closes only the
    // session-owned MCP clients. Keep the DomainRuntime/resource mount alive so
    // the same persisted session can be reopened without losing extension state.
    await this.extensionMcp.close(binding.sessionId).catch(() => {});
    await this.ctx.agentSessions.release(binding.sessionId);
  }

  /** Permanently dispose a extension panel instance and its retained runtime. */
  async closeExtension(identity: ExtensionDomainInstanceIdentity): Promise<void> {
    const key = extensionDomainInstanceKey(identity);
    await this.openingOwners.get(key)?.catch(() => {});
    await this.disposeBinding(key);
  }

  private async disposeBinding(key: string): Promise<void> {
    const binding = this.extensionBindings.get(key);
    if (!binding) return;
    this.extensionBindings.delete(key);
    if (binding.sessionId) {
      this.extensionSessions.delete(binding.sessionId);
      await this.extensionMcp.close(binding.sessionId).catch(() => {});
    }
    await binding.runtime.close().catch(() => {});
    if (binding.sessionId && this.ctx.agentSessions) await this.ctx.agentSessions.release(binding.sessionId).catch(() => {});
  }

  /** Broker calls from isolated extension workers. */
  async brokerExtensionDomain(identity: ExtensionDomainInstanceIdentity, manifest: ExtensionManifest, method: string, args: unknown[], context: ExtensionDomainContext, onDelta?: (delta: string) => void): Promise<unknown> {
    if (method === 'llm.chatStream') {
      if (!manifest.permissions.includes('models')) throw new Error('Extension did not declare models permission');
      const options = args[1] && typeof args[1] === 'object' ? args[1] as Record<string, unknown> : {};
      const configured = this.ctx.config.get();
      let llmContext = this.ctx;
      if (typeof options.providerId === 'string' && options.providerId) {
        const provider = configured.llm?.providers.find(item => item.id === options.providerId && item.enabled !== false);
        const model = provider?.models.find(item => item.id === options.modelId);
        if (!provider || !model) throw new Error('所选模型不存在或已禁用');
        if (provider.api && provider.api !== 'openai-completions') throw new Error('扩展流式调用目前需要 OpenAI 兼容模型');
        llmContext = { ...this.ctx, config: { ...this.ctx.config, get: () => ({ ...configured, openai: { ...configured.openai, baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: model.id } }) } } as AppContext;
      }
      return llmChatStream(llmContext, identity.extensionId, args[0], options, onDelta ?? (() => {}), `${identity.workspaceId}:${identity.extensionInstanceId}`, context.signal);
    }
    if (method === 'models.list' || method === 'models.invoke' || method === 'models.customImage' || method === 'models.sealImageKey') {
      if (!manifest.permissions.includes('models')) throw new Error('Extension did not declare models permission');
      if (!this.modelGateway) throw new Error('Extension model gateway is unavailable');
      if (context.signal.aborted) throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      const owner = `${identity.workspaceId}:${identity.extensionInstanceId}`;
      if (method === 'models.sealImageKey') return this.modelGateway.sealImageKey(owner, args[0], args[1]);
      if (method === 'models.customImage') return this.modelGateway.customImage(owner, args[0], context.signal);
      return method === 'models.list' ? this.modelGateway.list() : this.modelGateway.invoke(owner, args[0]);
    }
    const key = extensionDomainInstanceKey(identity);
    const binding = this.extensionBindings.get(key);
    if (!binding) throw new Error('extension domain session is unavailable');
    if (context.signal.aborted) throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    if (method === 'data.read' || method === 'data.write' || method === 'data.list') {
      return this.extensionData(identity, manifest, binding.sessionId, method, args);
    }
    if (method === 'journal.list' || method === 'journal.read') {
      return this.extensionJournal(identity, manifest, binding.sessionId, method, args);
    }
    if (method === 'notify') return this.extensionNotify(identity, manifest, binding.sessionId, args[0]);
    throw new Error(`Unknown extension host broker method: ${method}`);
  }

  extensionSubscribe(identity: ExtensionDomainInstanceIdentity, listener: (event: ExtensionDomainEvent) => void): () => void {
    const binding = this.extensionBindings.get(extensionDomainInstanceKey(identity));
    if (!binding) return () => {};
    return binding.runtime.subscribe(event => {
      try { listener(event); }
      catch (error) { console.warn('[extension extension] domain event renderer listener failed:', error); }
    });
  }

  private extensionMeta(identity: ExtensionDomainInstanceIdentity): ExtensionAgentSessionMeta {
    return { kind: 'extension-agent', extensionId: identity.extensionId, extensionInstanceId: identity.extensionInstanceId, workspaceId: identity.workspaceId, sourceRootId: identity.sourceRootId, packageFingerprint: identity.packageFingerprint, surfaceId: identity.surfaceId, runtimeId: 'pi' };
  }

  extensionData(identity: ExtensionDomainInstanceIdentity, manifest: ExtensionManifest, sessionId: string | undefined, method: 'data.read' | 'data.write' | 'data.list', args: unknown[]): unknown {
    this.requireRuntimeBinding(identity, manifest, sessionId);
    if (!manifest.permissions.includes('data')) throw new Error('extension extension did not declare data permission');
    const data = new ExtensionDataStore(this.userData, identity.workspaceId, manifest);
    if (method === 'data.read') {
      if (typeof args[0] !== 'string') throw new Error('extension data path is required');
      const content = data.read(args[0], args[1] === 'shared' ? 'shared' : 'workspace');
      return content === null ? null : { content };
    }
    if (method === 'data.write') {
      if (typeof args[0] !== 'string' || typeof args[1] !== 'string') throw new Error('extension data write requires path and text');
      data.write(args[0], args[1], args[2] === 'shared' ? 'shared' : 'workspace');
      return { ok: true };
    }
    return data.list(typeof args[0] === 'string' ? args[0] : '', args[1] === 'shared' ? 'shared' : 'workspace');
  }

  extensionJournal(identity: ExtensionDomainInstanceIdentity, manifest: ExtensionManifest, sessionId: string | undefined, method: 'journal.list' | 'journal.read', args: unknown[]): unknown {
    this.requireRuntimeBinding(identity, manifest, sessionId);
    if (!manifest.permissions.includes('data')) throw new Error('extension extension did not declare data permission');
    const workspace = this.ctx.config.get().workspaces.find(item => item.id === identity.workspaceId);
    if (!workspace) throw new Error('extension extension workspace is unavailable');
    const root = controlRootFor(workspace);
    if (method === 'journal.list') return { dates: listJournalDays(root) };
    if (typeof args[0] !== 'string') throw new Error('extension journal date is required');
    return readJournalDay(root, args[0]);
  }

  extensionNotify(identity: ExtensionDomainInstanceIdentity, manifest: ExtensionManifest, sessionId: string | undefined, text: unknown): boolean {
    this.requireRuntimeBinding(identity, manifest, sessionId);
    if (!manifest.permissions.includes('hostTools')) throw new Error('extension extension did not declare hostTools permission');
    if (typeof text !== 'string' || !text.trim()) throw new Error('extension notification text is required');
    this.ctx.notify.push({ workspaceId: identity.workspaceId, sessionId: `extension:${identity.extensionId}`, sessionName: manifest.name, kind: 'info', text: text.trim().slice(0, 500), toast: true });
    return true;
  }

  /** Register a generic extension runtime after its Pi session has been created. */
  registerExtensionSession(sessionId: string, runtime: ExtensionRuntime, manifest: ExtensionManifest, identity: ExtensionDomainInstanceIdentity): void {
    if (!sessionId || manifest.surface.kind !== 'sidebar' || !manifest.domain || !manifest.agent) throw new Error('Invalid extension Extension Agent binding');
    this.extensionSessions.set(sessionId, { runtime, manifest: structuredClone(manifest), identity: structuredClone(identity) });
  }

  unregisterExtensionSession(sessionId: string): void {
    this.extensionSessions.delete(sessionId);
    void this.extensionMcp.close(sessionId).catch(() => {});
  }

  extensionPromptForSession(sessionId: string): string | undefined {
    const binding = this.extensionSessions.get(sessionId);
    if (!binding) return undefined;
    return binding.runtime.agentPrompt();
  }

  extensionToolsForSession(sessionId: string): GuiHostTool[] {
    const binding = this.extensionSessions.get(sessionId);
    return binding ? [...extensionAgentToolsForSession(binding.runtime, binding.manifest, binding.identity), ...this.extensionMcp.toolsForSession(sessionId)] : [];
  }

  async extensionSnapshot(identity: ExtensionDomainInstanceIdentity, manifest: ExtensionManifest, sessionId: string | undefined, args?: unknown): Promise<unknown> {
    const binding = this.requireRuntimeBinding(identity, manifest, sessionId);
    return binding.runtime.snapshot({ manifest, actor: 'human', requestId: randomUUID(), signal: new AbortController().signal, ...(args && typeof args === 'object' && Number.isSafeInteger((args as Record<string, unknown>).expectedVersion) ? { expectedVersion: (args as Record<string, unknown>).expectedVersion as number } : {}) });
  }

  async extensionQuery(identity: ExtensionDomainInstanceIdentity, manifest: ExtensionManifest, sessionId: string | undefined, name: string, args?: unknown): Promise<unknown> {
    const binding = this.requireRuntimeBinding(identity, manifest, sessionId);
    return binding.runtime.query(name, args ?? {}, { manifest, actor: 'human', requestId: randomUUID(), signal: new AbortController().signal });
  }

  async extensionCommand(identity: ExtensionDomainInstanceIdentity, manifest: ExtensionManifest, sessionId: string | undefined, name: string, args?: unknown, signal?: AbortSignal): Promise<unknown> {
    const binding = this.requireRuntimeBinding(identity, manifest, sessionId);
    const input = args && typeof args === 'object' ? args as Record<string, unknown> : {};
    return binding.runtime.execute(name, input, { manifest, sessionId, actor: 'human', requestId: randomUUID(), signal: signal ?? new AbortController().signal, ...(Number.isSafeInteger(input.expectedVersion) ? { expectedVersion: input.expectedVersion as number } : {}) });
  }

  private requireRuntimeBinding(identity: ExtensionDomainInstanceIdentity, manifest: ExtensionManifest, sessionId: string | undefined): ExtensionRuntimeBinding {
    const key = extensionDomainInstanceKey(identity);
    const binding = sessionId ? this.extensionSessions.get(sessionId) : this.extensionBindings.get(key);
    if (!binding || binding.manifest.id !== manifest.id || extensionDomainInstanceKey(binding.identity) !== key ||
        binding.identity.sourceRootId !== identity.sourceRootId || binding.identity.packageFingerprint !== identity.packageFingerprint) throw new Error('Extension runtime identity is invalid');
    return binding;
  }
}
