import { t } from '../../shared/i18n';
import { defaultRootFor, requireSourceRoot } from '../../shared/workspaceRoots';
import { resolveExtensionProjectBindingAsync } from './extensionProjectBinding';
import type { ExtensionToolContext } from './extensionHostTool';
import { extensionSkillNames } from './extensionSkillNames';
import type { ExtensionTaskSource } from '../../shared/boardTodo';
import { getChatCapabilities, isChatRuntimeId } from '../../shared/agentRuntimeCapabilities';
import type { SessionMeta } from '../../shared/types';
import type { GuiHostTool } from '../agentSession/types';
import { randomUUID } from 'node:crypto';
import type { ExtensionManifest } from '../../shared/extensionManifest';
import type { ExtensionDomainInstanceIdentity } from '../../shared/extensionDomain';
import type { ExtensionAgentService } from './extensionAgentService';
import { ExtensionPackageCatalog, type ExtensionInstanceBinding } from './extensionPackageCatalog';
import fs from 'node:fs';
import path from 'node:path';
import { ExtensionDevelopmentTrustStore, type ExtensionDevelopmentScope, type ExtensionDevelopmentTrustMode, type ExtensionDevelopmentTrustSubject } from './extensionDevelopmentTrust';
import type { ExtensionMcpTrust } from './extensionAgentResources';
import { ExtensionIsolatedCommandRuntime, ExtensionIsolatedDomainRuntime, type ExtensionIsolatedBroker } from './extensionIsolatedRuntime';
import { injectExtensionPanelChrome } from '../../shared/panelRelay';
import { ExtensionPanelViews, type PanelPlacement } from './panelViews';
import type { AppContext } from '../context';
import type { ExtensionBridgeCall, ExtensionPanelMethod } from '../../shared/extensions';
import { ExtensionRunningPackageVerifier } from './extensionPackageVerifier';
import { ExtensionMediaStore } from './extensionMediaStore';
import { ExtensionExportService } from './extensionExportService';
import type { ExtensionModelGateway } from './extensionModelGateway';
import { ExtensionHtmlThumbnail } from './extensionHtmlThumbnail';
import { ExtensionHostPanelLifecycle } from './extensionHostPanelLifecycle';
import { ExtensionHostDomainFactoryRegistry } from './extensionHostDomainFactories';
import { handleExtensionMediaBridge } from './extensionHostMedia';
import { handleExtensionTaskBridge } from './extensionHostTasks';
import { resolveLiveExtensionBinding, type ExtensionLiveBinding } from './extensionLiveBinding';
import type { ExtensionSourcePackage } from './extensionSourceLayout';

export interface ExtensionPanelInstance {
  token: string;
  identity: ExtensionDomainInstanceIdentity;
  binding: ExtensionInstanceBinding;
  manifest: ExtensionManifest;
  entry: string;
  sessionId?: string;
  mcpTrust?: ExtensionMcpTrust;
  developmentTrust: { trusted: boolean; subject: ExtensionDevelopmentTrustSubject };
}

/** popup（独立窗口）面板身份：ExtensionPanelViews 的泛型合同。 */
export interface ExtensionPanelViewIdentity {
  token: string;
  instanceId: string;
  generation: number;
  workspaceId: string;
  sourceRootId: string;
  extensionId: string;
  viewId: string;
  entry: string;
  permissions: readonly string[];
  extension: { name: string };
  /** extension 独立窗口 = 完整应用窗口（面板 + AI 侧栏整体），而非裸面板页。 */
  detachedAppWindow: boolean;
}

export type ExtensionPanelEventEmitter = (event: { token: string; topic: string; value: unknown }) => void;
export type ExtensionDangerousConfirmation = (title: string, detail: string, signal: AbortSignal) => Promise<boolean>;
export type ExtensionPanelCommand = (identity: ExtensionDomainInstanceIdentity, name: string, args: unknown, signal: AbortSignal) => Promise<unknown>;
export type ExtensionPanelLlm = (identity: ExtensionDomainInstanceIdentity, messages: unknown, options: unknown, signal: AbortSignal) => Promise<unknown>;
export type ExtensionPanelLlmStream = (identity: ExtensionDomainInstanceIdentity, messages: unknown, options: unknown, signal: AbortSignal, onDelta: (delta: string) => void) => Promise<{ text: string }>;
export type ExtensionWorkspaceActivationCheck = (input: { workspaceId: string; extensionId: string; scope: 'global' | 'project'; controlRoot?: string; }) => boolean;

/** extension package/instance host. UI resource delivery can layer on this identity contract. */
export class ExtensionHost {
  private readonly htmlThumbnails = new ExtensionHtmlThumbnail();
  private prepareReload?: (id: string, directory: string) => Promise<void>;
  private packagePreparation: Promise<void> = Promise.resolve();
  private readonly views = new Map<string, ExtensionPanelInstance>();
  private readonly reloads = new Map<string, Promise<ExtensionPanelInstance>>();
  private readonly panelOperations = new Map<string, Promise<void>>();
  private readonly panelLifecycle = new ExtensionHostPanelLifecycle();
  private readonly eventStops = new Map<string, () => void>();
  private readonly eventEmitters = new Map<string, ExtensionPanelEventEmitter>();
  private readonly pickedFiles = new Map<string, Set<string>>();
  private readonly domainFactories = new ExtensionHostDomainFactoryRegistry();
  private readonly commandRuntimes = new Map<string, ExtensionIsolatedCommandRuntime>();
  private readonly verifier: ExtensionRunningPackageVerifier;

  constructor(private readonly catalog: ExtensionPackageCatalog, private readonly agent: ExtensionAgentService, private readonly developmentTrust?: ExtensionDevelopmentTrustStore, private readonly confirmDangerous?: ExtensionDangerousConfirmation, private readonly panelCommand?: ExtensionPanelCommand, private readonly panelLlm?: ExtensionPanelLlm, private readonly panelLlmStream?: ExtensionPanelLlmStream, private readonly runtimeWorkerFile?: string, private readonly appContext?: AppContext, private readonly mediaStore?: ExtensionMediaStore, private readonly pickFiles?: () => Promise<string[]>, private readonly exportService?: ExtensionExportService, private readonly modelGateway?: ExtensionModelGateway, private readonly executeHostTool?: (context: ExtensionToolContext, name: string, args: unknown, signal: AbortSignal) => Promise<unknown>, private readonly workspaceActivation?: ExtensionWorkspaceActivationCheck) {
    this.verifier = new ExtensionRunningPackageVerifier({ layout: catalog.layout });
    // 独立窗口（placement='window'）复用 ExtensionPanelViews：muster-app 协议
    // 对 extension token 同样交付，popup 内的 SDK 调用经 maHost 通道回到本 host。域事件不推
    // popup（操作仍生效，主窗口面板照常实时刷新）。
    if (appContext) this.panelViews = new ExtensionPanelViews<ExtensionPanelViewIdentity>(appContext, (instance, call) => this.bridgePanelCall(instance, call));
  }

  /** popup（独立窗口）承载面；无 AppContext（纯测试）时不可用。 */
  readonly panelViews?: ExtensionPanelViews<ExtensionPanelViewIdentity>;

  setReloadPreparation(prepare: (id: string, directory: string) => Promise<void>): void { this.prepareReload = prepare; }

  setPackagePreparation(preparation: Promise<void>): void { this.packagePreparation = preparation; }

  private async bridgePanelCall(instance: ExtensionPanelViewIdentity, call: ExtensionBridgeCall): Promise<unknown> {
    const method = call.method;
    const args = Array.isArray(call.args) ? call.args : [];
    return this.call(instance.token, method, args);
  }

  listGlobal(): ReturnType<ExtensionPackageCatalog['list']> {
    return this.catalog.list('global');
  }

  scanGlobal(): ReturnType<ExtensionPackageCatalog['scanGlobal']> {
    return this.catalog.scanGlobal();
  }

  async developmentTrustStatus(input: { scope: ExtensionDevelopmentScope; extensionId: string; controlRoot?: string }): Promise<{ trusted: boolean; subject: ExtensionDevelopmentTrustSubject }> {
    const packageInfo = await this.verifier.verifyFresh({ scope: input.scope, extensionId: input.extensionId, ...(input.controlRoot ? { controlRoot: input.controlRoot } : {}) });
    const subject: ExtensionDevelopmentTrustSubject = { extensionId: packageInfo.manifest.id, scope: input.scope, directory: packageInfo.descriptor.directory, fingerprint: packageInfo.fingerprint };
    return { trusted: this.developmentTrust?.isTrusted(subject) ?? false, subject };
  }

  async trustDevelopment(input: { scope: ExtensionDevelopmentScope; extensionId: string; mode: ExtensionDevelopmentTrustMode; controlRoot?: string }): Promise<{ trusted: boolean; subject: ExtensionDevelopmentTrustSubject }> {
    const status = await this.developmentTrustStatus(input);
    if (!this.developmentTrust) throw new Error('extension development trust is unavailable');
    this.developmentTrust.trust(status.subject, input.mode);
    return { trusted: true, subject: status.subject };
  }

  async revokeDevelopment(input: { scope: ExtensionDevelopmentScope; extensionId: string; controlRoot?: string }): Promise<{ trusted: boolean; subject: ExtensionDevelopmentTrustSubject }> {
    const status = await this.developmentTrustStatus(input);
    this.developmentTrust?.revoke(status.subject);
    return { trusted: false, subject: status.subject };
  }

  listDevelopmentTrust(): readonly ReturnType<ExtensionDevelopmentTrustStore['listPersistent']>[number][] {
    return this.developmentTrust?.listPersistent() ?? [];
  }

  private async assertProjectBinding(manifest: ExtensionManifest, workspaceId: string, sourceRootId?: string): Promise<void> {
    if (manifest.scope !== 'project' || !this.appContext) return;
    const workspace = this.appContext.config.get().workspaces.find(item => item.id === workspaceId);
    if (!workspace || !manifest.project || !sourceRootId) throw new Error('Project extension is missing its binding');
    const mappings = this.appContext.extensionSystem?.authoringServices.mappings.list();
    if ((await resolveExtensionProjectBindingAsync(workspace, manifest.project, mappings)).id !== sourceRootId) throw new Error('Extension belongs to a different project');
  }

  private resolveLiveBinding(input: { workspaceId: string; extensionId: string; scope: 'global' | 'project'; controlRoot?: string; sourceRootId?: string; expectedFingerprint?: string; packageInfo: Parameters<typeof resolveLiveExtensionBinding>[0]['packageInfo'] }): Promise<ExtensionLiveBinding> {
    return resolveLiveExtensionBinding(input, {
      catalog: this.catalog,
      workspace: workspaceId => this.appContext?.config.get().workspaces?.find(item => item.id === workspaceId),
      mappings: workspace => this.appContext?.extensionSystem?.authoringServices.mappings.list() ?? [],
      isWorkspaceActivated: this.workspaceActivation,
      developmentTrust: this.developmentTrust
    });
  }

  private async hostTool(identity: ExtensionDomainInstanceIdentity, manifest: ExtensionManifest, args: unknown[], signal: AbortSignal, assertRequestCurrent?: () => void): Promise<unknown> {
    if (!manifest.permissions.includes('hostTools')) throw new Error('Extension did not declare hostTools permission');
    if (!this.executeHostTool) throw new Error('Extension host tool execution is unavailable');
    assertRequestCurrent?.();
    const workspace = this.appContext?.config.get().workspaces.find(item => item.id === identity.workspaceId);
    if (!workspace) throw new Error('Extension workspace is unavailable');
    const root = identity.sourceRootId ? requireSourceRoot(workspace, identity.sourceRootId) : defaultRootFor(workspace);
    const controlRoot = manifest.scope === 'project' ? root.path : undefined;
    const pkg = await this.verifier.verifyFresh({ scope: manifest.scope, extensionId: manifest.id, controlRoot });
    const live = await this.resolveLiveBinding({ workspaceId: identity.workspaceId, extensionId: manifest.id, scope: manifest.scope, ...(controlRoot ? { controlRoot } : {}), ...(identity.sourceRootId ? { sourceRootId: identity.sourceRootId } : {}), expectedFingerprint: identity.packageFingerprint, packageInfo: pkg });
    const assertBindingCurrent = () => {
      live.assertCurrent(signal);
      assertRequestCurrent?.();
    };
    assertBindingCurrent();
    if (live.sourceRoot?.id !== root.id || live.sourceRoot.path !== root.path || !live.workspace) throw new Error('Extension source root changed');
    const sessionId = this.agent.hostToolSessionId(identity, manifest);
    const result = await this.executeHostTool({ workspaceId: workspace.id, sourceRootId: root.id, sourceRoot: root.path,
      rootsRevision: live.workspace.rootsRevision, manifest, sessionId, assertCurrent: () => {
        assertBindingCurrent();
        if (sessionId && this.agent.hostToolSessionId(identity, manifest) !== sessionId) throw new Error('Extension Agent binding changed');
      } }, String(args[0]), args[1], signal);
    assertBindingCurrent();
    return result;
  }

  async open(input: { workspaceId: string; extensionId: string; scope?: 'global' | 'project'; controlRoot?: string; surfaceId?: string; sourceRootId?: string; mcpTrust?: import('./extensionAgentResources').ExtensionMcpTrust }, emit?: ExtensionPanelEventEmitter): Promise<ExtensionPanelInstance> {
    const extensionId = input.extensionId;
    const scope = input.scope ?? 'global';
    if (scope === 'project' && !input.controlRoot) throw new Error('Project extension extensions require a control root');
    const surfaceId = input.surfaceId ?? 'main';
    const extensionInstanceId = `${input.workspaceId}:${extensionId}:${surfaceId}`;
    return this.runPanelOperation(extensionInstanceId, async () => {
      await this.packagePreparation;
      const packageInfo = await this.verifier.verifyFresh({ scope, extensionId, ...(input.controlRoot ? { controlRoot: input.controlRoot } : {}) });
      await this.catalog.register(packageInfo);
      const live = await this.resolveLiveBinding({ workspaceId: input.workspaceId, extensionId, scope, ...(input.controlRoot ? { controlRoot: input.controlRoot } : {}), ...(input.sourceRootId ? { sourceRootId: input.sourceRootId } : {}), packageInfo });
      if (packageInfo.manifest.surface.kind !== 'sidebar' || !packageInfo.manifest.domain) throw new Error('Extension is not a sidebar panel');
      const trustSubject = live.trustSubject;
      const trusted = live.trusted;
      const effectiveMcpTrust = input.mcpTrust ?? (this.developmentTrust?.isTrusted(trustSubject) ? 'trusted-once' : 'untrusted');
      const identity: ExtensionDomainInstanceIdentity = { extensionId, extensionInstanceId, workspaceId: input.workspaceId, ...(input.sourceRootId ? { sourceRootId: input.sourceRootId } : {}), packageFingerprint: packageInfo.fingerprint, surfaceId };
      const binding = this.catalog.bindInstance({ workspaceId: input.workspaceId, extensionId, extensionInstanceId, surfaceId, scope, ...(input.sourceRootId ? { sourceRootId: input.sourceRootId } : {}), ...(input.controlRoot ? { controlRoot: input.controlRoot } : {}), packageFingerprint: packageInfo.fingerprint });
      this.ensureDomainFactory(packageInfo.descriptor.directory, packageInfo.manifest, packageInfo.fingerprint);
      const sessionId = await this.agent.openPanel(identity, packageInfo.manifest, packageInfo.descriptor.directory, effectiveMcpTrust);
      const view: ExtensionPanelInstance = { token: randomUUID(), identity, binding, manifest: packageInfo.manifest, entry: packageInfo.manifest.surface.entry!, sessionId, mcpTrust: effectiveMcpTrust, developmentTrust: { trusted, subject: trustSubject } };
      this.views.set(view.token, view);
      this.panelLifecycle.open(view.token);
      this.panelViews?.create({ token: view.token, instanceId: identity.extensionInstanceId, generation: 1, workspaceId: identity.workspaceId, sourceRootId: identity.sourceRootId ?? '', extensionId, viewId: surfaceId, entry: view.entry, permissions: packageInfo.manifest.permissions, extension: { name: packageInfo.manifest.name }, detachedAppWindow: true });
      this.eventEmitters.set(view.token, emit ?? (() => {}));
      if (emit) this.eventStops.set(view.token, this.agent.extensionSubscribe(identity, event => emit({ token: view.token, topic: event.type, value: event })));
      return structuredClone(view);
    });
  }

  private async runPanelOperation<T>(instanceId: string, work: () => Promise<T>): Promise<T> {
    // Desktop and web panels can hold separate views of the same runtime.
    const operation = Promise.resolve(this.panelOperations.get(instanceId)).then(work);
    const settled = operation.then(() => {}, () => {});
    this.panelOperations.set(instanceId, settled);
    try { return await operation; }
    finally { if (this.panelOperations.get(instanceId) === settled) this.panelOperations.delete(instanceId); }
  }

  async call(token: string, method: ExtensionPanelMethod, args: unknown[] = []): Promise<unknown> {
    const view = this.views.get(token);
    if (!view) throw new Error('extension extension instance is unavailable');
    await this.assertPackageFingerprint(view);
    if (this.views.get(token) !== view) throw new Error('Extension panel is closed');
    if (['agent.open', 'agent.release', 'agent.send', 'agent.history'].includes(method) && !view.manifest.agent) {
      throw new Error('Extension does not declare a host Agent');
    }
    if (method === 'tool') {
      const result = await this.hostTool(view.identity, view.manifest, args, this.panelLifecycle.parentSignal(token));
      // A completed host-owned render creates an artifact in the trusted browser
      // capture directory. Mark only that returned path as eligible for the
      // existing media.import bridge; arbitrary panel paths remain rejected.
      if (args[0] === 'host.tasks.render' || args[0] === 'host_tasks_render') {
        const render = result && typeof result === 'object' ? (result as Record<string, unknown>).render : undefined;
        const artifact = render && typeof render === 'object' ? (render as Record<string, unknown>).artifact : undefined;
        const artifactPath = artifact && typeof artifact === 'object' && typeof (artifact as Record<string, unknown>).path === 'string'
          ? (artifact as Record<string, unknown>).path as string : undefined;
        if (artifactPath) this.pickedFiles.get(token)?.add(artifactPath);
      }
      return result;
    }
    if (method === 'agent.open') {
      const opened = await this.agent.openExtension(view.identity, view.manifest, view.binding.directory, view.mcpTrust);
      view.sessionId = opened.sessionId;
      return { sessionId: opened.sessionId };
    }
    if (method === 'agent.release') {
      await this.agent.releaseExtension(view.identity);
      return { ok: true };
    }
    const session = view.sessionId;
    if (method === 'agent.send') {
      if (!session) throw new Error('Extension Agent Session is unavailable');
      if (!this.appContext?.agentSessions) throw new Error('GUI Agent Session host unavailable');
      const text = args[0];
      if (typeof text !== 'string' || !text.trim() || text.length > 64_000) throw new Error('Extension agent message is invalid');
      await this.appContext.agentSessions.send(session, text, undefined, { steerOnBusy: false });
      return { ok: true };
    }
    if (method === 'ui.confirm') {
      if (!this.confirmDangerous) throw new Error('extension confirmation is unavailable');
      const options = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] as Record<string, unknown> : {};
      const title = typeof options.title === 'string' ? options.title.trim() : '';
      if (!title || title.length > 240) throw new Error('Extension confirmation title is invalid');
      const detail = typeof options.detail === 'string' ? options.detail.slice(0, 8_000) : '';
      const request = this.panelLifecycle.childSignal(token);
      try {
        return { confirmed: await this.confirmDangerous(title, detail, request.signal) };
      } finally {
        request.dispose();
      }
    }
    const owner = `${view.identity.workspaceId}:${view.identity.extensionInstanceId}`;
    const requirePermission = (permission: string): void => { if (!view.manifest.permissions.includes(permission as never)) throw new Error(`Extension did not declare permission: ${permission}`); };
    const mediaBridge = await handleExtensionMediaBridge(method, {
      owner,
      token,
      workspaceId: view.identity.workspaceId,
      args,
      permissions: view.manifest.permissions,
      pickedFiles: this.pickedFiles.get(token),
      pickFiles: this.pickFiles,
      setPickedFiles: files => this.pickedFiles.set(token, new Set(files)),
      mediaStore: this.mediaStore,
      htmlThumbnails: this.htmlThumbnails,
      exportService: this.exportService,
      browser: this.appContext?.browser ?? undefined,
      isViewCurrent: () => this.views.get(token) === view,
      isActiveWorkspace: () => this.appContext?.config.get().activeWorkspaceId === view.identity.workspaceId,
      requirePermission: permission => requirePermission(permission),
    });
    if (mediaBridge.handled) return mediaBridge.value;
    const taskBridge = await handleExtensionTaskBridge({
      token,
      owner,
      method,
      args,
      view,
      signal: this.panelLifecycle.parentSignal(token),
      appContext: this.appContext,
      catalog: this.catalog,
      developmentTrust: this.developmentTrust,
      htmlThumbnails: this.htmlThumbnails,
      exportService: this.exportService,
      isViewCurrent: () => this.views.get(token) === view,
      assertCurrent: () => {
        if (this.views.get(token) !== view) throw new Error(t('扩展面板已关闭或工作区已切换'));
      },
      requirePermission: permission => requirePermission(permission),
    });
    if (taskBridge.handled) return taskBridge.value;
    if (method === 'models.list') {
      requirePermission('models');
      if (!this.modelGateway) throw new Error('Extension model gateway is unavailable');
      return this.modelGateway.list();
    }
    if (method === 'models.invoke') {
      requirePermission('models');
      if (!this.modelGateway) throw new Error('Extension model gateway is unavailable');
      return this.modelGateway.invoke(owner, args[0]);
    }
    if (method === 'agent.history') return session ? this.agent.history(session) : null;
    if (method === 'data.read' || method === 'data.write' || method === 'data.list') return this.agent.extensionData(view.identity, view.manifest, session, method, args);
    if (method === 'journal.list' || method === 'journal.read') return this.agent.extensionJournal(view.identity, view.manifest, session, method, args);
    if (method === 'notify') return this.agent.extensionNotify(view.identity, view.manifest, session, args[0]);
    if (method === 'llm.chat') {
      if (!this.panelLlm) throw new Error('extension extension LLM bridge is unavailable');
      const request = this.panelLifecycle.childSignal(token);
      try {
        return await this.panelLlm(view.identity, args[0], args[1], request.signal);
      } finally {
        request.dispose();
      }
    }
    if (method === 'llm.chatStream') {
      if (!this.panelLlmStream) throw new Error('extension streaming LLM bridge is unavailable');
      const requestId = randomUUID();
      const request = this.panelLifecycle.childSignal(token);
      this.panelLifecycle.setStream(token, requestId, request.controller);
      const emit = this.eventEmitters.get(token);
      void this.panelLlmStream(view.identity, args[0], args[1], request.signal, delta => emit?.({ token, topic: 'llm.delta', value: { requestId, delta } }))
        .then(result => emit?.({ token, topic: 'llm.done', value: { requestId, text: result.text } }))
        .catch(error => emit?.({ token, topic: 'llm.done', value: { requestId, error: String(error) } }))
        .finally(() => { request.dispose(); this.panelLifecycle.finishStream(token, requestId); });
      return { requestId };
    }
    if (method === 'llm.chatStream.cancel') {
      const requestId = String(args[0] ?? '');
      const controller = this.panelLifecycle.stream(token, requestId);
      if (!controller) return false;
      controller.abort(); return true;
    }
    if (method === 'commands.execute') {
      if (!this.panelCommand) throw new Error('extension extension command bridge is unavailable');
      const request = this.panelLifecycle.childSignal(token);
      try {
        return await this.panelCommand(view.identity, String(args[0] ?? ''), args[1], request.signal);
      } finally {
        request.dispose();
      }
    }
    if (method.startsWith('storage.')) return this.storageCall(view, method, args);
    if (method === 'domain.snapshot') return this.agent.extensionSnapshot(view.identity, view.manifest, session, args[0]);
    if (method === 'domain.query') return this.agent.extensionQuery(view.identity, view.manifest, session, String(args[0] ?? ''), args[1]);
    if (method === 'domain.command') {
      const name = String(args[0] ?? '');
      const definition = view.manifest.domain?.commandDefs?.find(item => item.id === name);
      if (definition?.permission === 'dangerous') {
        if (!this.confirmDangerous) throw new Error('extension dangerous command confirmation is unavailable');
        const request = this.panelLifecycle.childSignal(token);
        let confirmed: boolean;
        try {
          confirmed = await this.confirmDangerous(t('确认执行 {{name}} 的危险操作', { name: view.manifest.name }), `${name}\n${JSON.stringify(args[1] ?? {})}`, request.signal);
        } finally {
          request.dispose();
        }
        if (!confirmed) throw new Error('extension dangerous command cancelled');
      }
      const request = this.panelLifecycle.childSignal(token);
      try {
        return await this.agent.extensionCommand(view.identity, view.manifest, session, name, args[1], request.signal);
      } finally {
        request.dispose();
      }
    }
    throw new Error(`Unknown extension panel method: ${method}`);
  }

  async taskLaunchMeta(source: ExtensionTaskSource, workspaceId?: string, rootId?: string, runtime?: string): Promise<Record<string, string>> {
    const management = this.appContext?.extensionSystem?.management;
    if (!workspaceId || !rootId || !management || workspaceId !== source.workspaceId ||
        (source.scope === 'project' && (rootId !== source.rootId || (source.sourceRootId && rootId !== source.sourceRootId)))) throw new Error(t('扩展所属项目已变化，请重新打开制作入口'));
    if (!runtime || !isChatRuntimeId(runtime) || getChatCapabilities(runtime).hostToolsAvailable === false) throw new Error(t('扩展创作需要支持宿主工具的 GUI Harness'));
    const controlRoot = source.scope === 'project' ? management.rootPath(workspaceId, rootId) : undefined;
    const pkg = await this.verifier.verifyFresh({ scope: source.scope, extensionId: source.extensionId, controlRoot });
    await this.assertProjectBinding(pkg.manifest, workspaceId, rootId);
    if (source.fingerprint !== pkg.fingerprint || !pkg.manifest.permissions.includes('project.tasks') ||
        !this.catalog.get(source.scope, source.extensionId, controlRoot)?.enabled || (this.developmentTrust && !this.developmentTrust.canRun({
          scope: source.scope, extensionId: source.extensionId, directory: pkg.descriptor.directory, fingerprint: pkg.fingerprint
        }, workspaceId))) throw new Error(t('扩展已更新或停用，请重新打开制作入口'));
    return { extensionTask: pkg.manifest.id, extensionScope: source.scope, extensionFingerprint: pkg.fingerprint,
      extensionSurface: source.surfaceId, extensionSkillNames: JSON.stringify(extensionSkillNames(pkg.manifest)),
      ...(source.sourceRootId ? { extensionSourceRoot: source.sourceRootId } : {}) };
  }

  async projectTaskResources(task: SessionMeta): Promise<{ prompt: string | undefined; tools: GuiHostTool[] }> {
    const meta = task.meta, workspaceId = task.workspaceId;
    if (!meta?.extensionTask || !workspaceId || !task.sourceRoot?.rootId) throw new Error(t('缺少扩展任务身份'));
    const scope = meta.extensionScope === 'project' ? 'project' : 'global';
    const controlRoot = scope === 'project' ? this.appContext?.extensionSystem?.management.rootPath(workspaceId, task.sourceRoot.rootId) : undefined;
    const resolve = async () => {
      const extensionId = meta.extensionTask;
      const pkg = await this.verifier.verify({ scope, extensionId, controlRoot });
      await this.assertProjectBinding(pkg.manifest, workspaceId, task.sourceRoot!.rootId);
      const subject = { extensionId, scope, directory: pkg.descriptor.directory, fingerprint: pkg.fingerprint } as const;
      if ((!this.developmentTrust && pkg.fingerprint !== meta.extensionFingerprint) || !this.catalog.get(scope, extensionId, controlRoot)?.enabled || (this.workspaceActivation && !this.workspaceActivation({ workspaceId, extensionId, scope, ...(controlRoot ? { controlRoot } : {}) })) ||
          !pkg.manifest.permissions.includes('project.tasks') || (this.developmentTrust && !await this.developmentTrust.ensureCanRun(subject, workspaceId))) throw new Error(t('任务绑定的扩展已变更或停用'));
      if (!pkg.manifest.agent) return undefined;
      const surfaceId = meta.extensionSurface;
      const identity = { extensionId, workspaceId, surfaceId, extensionInstanceId: `${workspaceId}:${extensionId}:${surfaceId}`, packageFingerprint: pkg.fingerprint, sourceRootId: meta.extensionSourceRoot };
      this.ensureDomainFactory(pkg.descriptor.directory, pkg.manifest, pkg.fingerprint);
      return this.agent.domainOwner(identity, pkg.manifest, pkg.descriptor.directory);
    };
    const owner = await resolve();
    if (!owner) return { prompt: undefined, tools: [] };
    const tools = this.agent.extensionToolsForSession(owner).filter(tool => !tool.id.startsWith(`ext.${meta.extensionTask}.mcp.`)).map(tool => ({
      ...tool, execute: async (args: Record<string, unknown>, context: Parameters<GuiHostTool['execute']>[1]) => {
        const current = await resolve();
        const live = current && this.agent.extensionToolsForSession(current).find(item => item.id === tool.id);
        if (!live) throw new Error(t('扩展工具不可用'));
        return live.execute(args, { ...context, sessionId: task.id });
      }
    }));
    return { prompt: this.agent.extensionPromptForSession(owner), tools };
  }

  private storageCall(view: ExtensionPanelInstance, method: string, args: unknown[]): unknown {
    const path = '.storage.json';
    const read = this.agent.extensionData(view.identity, view.manifest, view.sessionId, 'data.read', [path]);
    const values = read && typeof read === 'object' && typeof (read as { content?: unknown }).content === 'string'
      ? JSON.parse((read as { content: string }).content || '{}') as Record<string, unknown>
      : {};
    if (method === 'storage.get') return values[String(args[0] ?? '')] ?? null;
    if (method === 'storage.keys') return Object.keys(values);
    if (method === 'storage.del') { delete values[String(args[0] ?? '')]; this.agent.extensionData(view.identity, view.manifest, view.sessionId, 'data.write', [path, JSON.stringify(values)]); return true; }
    if (method === 'storage.set') { values[String(args[0] ?? '')] = args[1]; this.agent.extensionData(view.identity, view.manifest, view.sessionId, 'data.write', [path, JSON.stringify(values)]); return true; }
    throw new Error(`Unknown extension storage method: ${method}`);
  }

  async reload(token: string, emit?: ExtensionPanelEventEmitter): Promise<ExtensionPanelInstance> {
    const active = this.reloads.get(token);
    if (active) return active;
    const view = this.views.get(token);
    if (!view) throw new Error('extension extension instance is unavailable');
    const pending = this.runPanelOperation(view.identity.extensionInstanceId, () => this.reloadView(token, emit));
    this.reloads.set(token, pending);
    try { return await pending; } finally { this.reloads.delete(token); }
  }

  private async reloadView(token: string, emit?: ExtensionPanelEventEmitter): Promise<ExtensionPanelInstance> {
    const view = this.views.get(token);
    if (!view) throw new Error('extension extension instance is unavailable');
    if (view.binding.scope === 'global') await this.prepareReload?.(view.identity.extensionId, view.binding.directory);
    const packageInfo = await this.verifier.verifyFresh({ scope: view.binding.scope, extensionId: view.identity.extensionId, ...(view.binding.controlRoot ? { controlRoot: view.binding.controlRoot } : {}) });
    await this.catalog.register(packageInfo);
    const live = await this.resolveLiveBinding({ workspaceId: view.identity.workspaceId, extensionId: view.identity.extensionId, scope: view.binding.scope, ...(view.binding.controlRoot ? { controlRoot: view.binding.controlRoot } : {}), ...(view.identity.sourceRootId ? { sourceRootId: view.identity.sourceRootId } : {}), packageInfo });
    if (packageInfo.manifest.surface.kind !== 'sidebar' || !packageInfo.manifest.domain) throw new Error('Extension is not a sidebar panel');
    const trustSubject = live.trustSubject;
    const trusted = live.trusted;
    const identity: ExtensionDomainInstanceIdentity = { ...view.identity, packageFingerprint: packageInfo.fingerprint };
    this.ensureDomainFactory(packageInfo.descriptor.directory, packageInfo.manifest, packageInfo.fingerprint);
    const sessionId = await this.agent.openPanel(identity, packageInfo.manifest, packageInfo.descriptor.directory, view.mcpTrust);
    const binding = this.catalog.bindInstance({ workspaceId: view.binding.workspaceId, extensionId: view.binding.extensionId, extensionInstanceId: view.binding.extensionInstanceId, surfaceId: view.binding.surfaceId, scope: view.binding.scope, ...(view.binding.sourceRootId ? { sourceRootId: view.binding.sourceRootId } : {}), ...(view.binding.controlRoot ? { controlRoot: view.binding.controlRoot } : {}), packageFingerprint: packageInfo.fingerprint });
    this.eventStops.get(token)?.();
    this.eventEmitters.set(token, emit ?? (() => {}));
    if (emit) this.eventStops.set(token, this.agent.extensionSubscribe(identity, event => emit({ token, topic: event.type, value: event })));
    else this.eventStops.delete(token);
    this.panelLifecycle.reset(token);
    this.pickedFiles.delete(token);
    view.identity = identity;
    view.binding = binding;
    view.manifest = packageInfo.manifest;
    view.entry = packageInfo.manifest.surface.entry!;
    view.sessionId = sessionId;
    view.developmentTrust = { trusted, subject: trustSubject };
    return structuredClone(view);
  }

  /** Execute one extension toolbar command through its package-owned command module. */
  async runToolbar(input: { workspaceId: string; extensionId: string; scope?: 'global' | 'project'; controlRoot?: string; sourceRootId?: string; menuId?: string; signal?: AbortSignal }): Promise<unknown> {
    const scope = input.scope ?? 'global';
    if (scope === 'project' && !input.controlRoot) throw new Error('Project extension extensions require a control root');
    const packageInfo = await this.verifier.verifyFresh({ scope, extensionId: input.extensionId, ...(input.controlRoot ? { controlRoot: input.controlRoot } : {}) });
    await this.catalog.register(packageInfo);
    const live = await this.resolveLiveBinding({ workspaceId: input.workspaceId, extensionId: input.extensionId, scope, ...(input.controlRoot ? { controlRoot: input.controlRoot } : {}), ...(input.sourceRootId ? { sourceRootId: input.sourceRootId } : {}), packageInfo });
    const manifest = packageInfo.manifest;
    if (manifest.surface.kind !== 'toolbar') throw new Error('extension extension is not a toolbar surface');
    const commandId = manifest.surface.menu
      ? manifest.surface.menu.find(item => item.id === input.menuId)?.command
      : input.menuId === undefined ? manifest.surface.command : undefined;
    if (!commandId) throw new Error('extension toolbar action is not declared');
    const command = manifest.commands?.find(item => item.id === commandId);
    if (!command || !manifest.commandEntry) throw new Error('extension toolbar command runtime is unavailable');
    const runtime = await this.commandRuntime(packageInfo.descriptor.directory, manifest, packageInfo.fingerprint, input.workspaceId, input.sourceRootId);
    const assertCurrent = () => live.assertCurrent(input.signal);
    assertCurrent();
    const result = await runtime.execute({ command: command.handler, args: {}, context: {
      workspaceId: input.workspaceId,
      extensionId: manifest.id,
      scope,
      ...(input.sourceRootId ? { sourceRootId: input.sourceRootId } : {}),
      sourceRoot: live.sourceRoot?.path,
      rootsRevision: live.workspace?.rootsRevision,
      requestId: randomUUID(),
      signal: input.signal ?? new AbortController().signal
    } }, assertCurrent);
    assertCurrent();
    return result;
  }

  async close(token: string): Promise<void> {
    const view = this.views.get(token);
    if (!view) return;
    const instanceId = view.identity.extensionInstanceId;
    await this.runPanelOperation(instanceId, async () => {
      if (!this.views.delete(token)) return;
      this.panelLifecycle.close(token);
      this.eventStops.get(token)?.();
      this.eventStops.delete(token);
      this.eventEmitters.delete(token);
      this.pickedFiles.delete(token);
      this.panelViews?.release(token);
      if ([...this.views.values()].some(other => other.identity.extensionInstanceId === instanceId)) return;
      try { await this.agent.closeExtension(view.identity); }
      finally {
        this.catalog.unbind(view.binding);
        await this.mediaStore?.release(`${view.identity.workspaceId}:${instanceId}`);
      }
    });
  }

  /** Close only instances owned by one extension before package removal. */
  async closeExtension(extensionId: string): Promise<void> {
    const tokens = [...this.views.entries()]
      .filter(([, view]) => view.identity.extensionId === extensionId)
      .map(([token]) => token);
    await Promise.all(tokens.map(token => this.close(token)));
    for (const [key, runtime] of this.commandRuntimes) {
      if (!key.startsWith(`${extensionId}:`)) continue;
      await runtime.close?.();
      this.commandRuntimes.delete(key);
    }
    this.unregisterDomainFactories(extensionId);
  }

  /** 独立窗口摆放（placement='window' 开原生窗口，其余收起并销毁窗口）。 */
  ownsView(token: string): boolean {
    return this.views.has(token);
  }

  place(token: string, placement: PanelPlacement): void {
    if (!this.panelViews) throw new Error('extension panel windows are unavailable in this host');
    this.panelViews.place(token, placement);
  }

  async resource(request: Request): Promise<Response> {
    let token: string;
    try { token = new URL(request.url).hostname; } catch { return new Response('Invalid extension resource URL', { status: 400 }); }
    const view = this.views.get(token);
    if (!view) return new Response('extension extension instance unavailable', { status: 403 });
    let packageInfo: ExtensionSourcePackage;
    try { packageInfo = await this.assertPackageFingerprint(view); } catch (error) { return new Response(error instanceof Error ? error.message : 'extension extension package changed', { status: 409 }); }
    const url = new URL(request.url);
    let relative: string;
    try {
      relative = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    } catch {
      return new Response('Invalid extension resource path', { status: 400 });
    }
    if (!relative || relative.includes('\0') || relative.split('/').some(part => !part || part === '.' || part === '..')) return new Response('Invalid extension resource path', { status: 400 });
    if (relative === '__sdk__/sdk.js' || relative === '__sdk__/theme.css') {
      try {
        const fileName = relative.endsWith('sdk.js') ? 'extension-sdk.js' : 'theme.css';
        const candidates = [
          path.join(__dirname, 'extensions', 'sdk', fileName),
          path.join(__dirname, 'sdk', fileName),
        ];
        let file: string | undefined;
        for (const candidate of candidates) {
          try { await fs.promises.access(candidate); file = candidate; break; } catch { /* try the compatibility path */ }
        }
        if (!file) return new Response('extension SDK unavailable', { status: 503 });
        return new Response(request.method === 'HEAD' ? null : await fs.promises.readFile(file), { status: 200, headers: { 'content-type': relative.endsWith('sdk.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'cache-control': 'no-store' } });
      } catch { return new Response('extension SDK unavailable', { status: 503 }); }
    }
    if (!packageInfo.files.includes(relative)) return new Response('Not Found', { status: 404 });
    const root = path.resolve(view.binding.directory);
    const file = path.resolve(root, ...relative.split('/'));
    const relativeToRoot = path.relative(root, file);
    if (relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) return new Response('Forbidden', { status: 403 });
    try {
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return new Response('Forbidden', { status: 403 });
      const ext = path.extname(file).toLowerCase();
      const mime = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : ext === '.js' || ext === '.mjs' ? 'text/javascript; charset=utf-8'
        : ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : ext === '.apng' ? 'image/apng'
          : ext === '.mp4' ? 'video/mp4' : ext === '.webm' ? 'video/webm' : ext === '.mp3' ? 'audio/mpeg' : ext === '.wav' ? 'audio/wav' : 'application/octet-stream';
      // HTML 交付注入中键/焦点中继：
      // guest 文档的鼠标事件进不了宿主 document，中键开看板等全局能力靠 postMessage 回传。
      const bytes = request.method === 'HEAD' ? null : file.endsWith('.html')
        ? Buffer.from(injectExtensionPanelChrome((await fs.promises.readFile(file)).toString('utf8')), 'utf8')
        : await fs.promises.readFile(file);
      const headers = new Headers({ 'content-type': mime, 'cache-control': 'no-store' });
      if (ext === '.html') headers.set('content-security-policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http://127.0.0.1:*; media-src 'self' data: blob: http://127.0.0.1:*; connect-src 'self' http://127.0.0.1:*; font-src 'self' data: https://www.oppo.com; object-src 'none'; base-uri 'none'");
      return new Response(bytes, { status: 200, headers });
    } catch { return new Response('Not Found', { status: 404 }); }
  }

  async closeAll(): Promise<void[]> {
    await Promise.all(this.panelOperations.values());
    return Promise.all([...this.views.keys()].map(token => this.close(token))).then(async results => {
      try {
        for (const runtime of this.commandRuntimes.values()) await runtime.close?.();
      } finally {
        this.commandRuntimes.clear();
        this.verifier.close();
        this.unregisterDomainFactories();
      }
      return results;
    });
  }

  private async commandRuntime(packageRoot: string, manifest: ExtensionManifest, fingerprint: string, workspaceId: string, sourceRootId?: string): Promise<ExtensionIsolatedCommandRuntime> {
    const entry = manifest.commandEntry;
    if (!entry) throw new Error('extension toolbar manifest has no command entry');
    const key = `${manifest.id}:${fingerprint}:${workspaceId}:${sourceRootId ?? ''}`;
    const cached = this.commandRuntimes.get(key);
    if (cached) return cached;
    const identity: ExtensionDomainInstanceIdentity = {
      extensionId: manifest.id,
      extensionInstanceId: `${workspaceId}:${manifest.id}:toolbar`,
      workspaceId,
      ...(sourceRootId ? { sourceRootId } : {}),
      packageFingerprint: fingerprint,
      surfaceId: 'toolbar'
    };
    const runtime = new ExtensionIsolatedCommandRuntime({ identity, manifest, packageRoot, entry,
      ...(this.runtimeWorkerFile ? { workerFile: this.runtimeWorkerFile } : {}),
      broker: this.createWorkerBroker(identity, manifest)
    });
    this.commandRuntimes.set(key, runtime);
    return runtime;
  }

  private createWorkerBroker(identity: ExtensionDomainInstanceIdentity, manifest: ExtensionManifest): ExtensionIsolatedBroker {
    return async (method, args, context, onDelta) => {
      if (method === 'tool') return this.hostTool(identity, manifest, args, context.signal, context.assertCurrent);
      if (manifest.surface.kind === 'toolbar') throw new Error(`Unsupported toolbar broker method: ${method}`);
      if (method === 'media.retain') {
        if (!manifest.permissions.includes('media') || !this.mediaStore) throw new Error('Extension media permission is unavailable');
        return this.mediaStore.retain(`${identity.workspaceId}:${identity.extensionInstanceId}`, String(args[0] ?? ''));
      }
      return this.agent.brokerExtensionDomain(identity, manifest, method, args, context, onDelta);
    };
  }

  private ensureDomainFactory(packageRoot: string, manifest: ExtensionManifest, fingerprint: string): void {
    const factoryKey = `${manifest.id}:${fingerprint}`;
    if (this.domainFactories.has(factoryKey)) return;
    const entry = manifest.domain?.entry;
    if (!entry) throw new Error('extension sidebar manifest has no domain entry');
    const registered = this.agent.extensionDomains.register(manifest.id, {
      create: async ({ identity, manifest: boundManifest }) => {
        return new ExtensionIsolatedDomainRuntime({ identity, manifest: boundManifest, packageRoot, entry,
          ...(this.runtimeWorkerFile ? { workerFile: this.runtimeWorkerFile } : {}),
          broker: this.createWorkerBroker(identity, boundManifest)
        });
      }
    }, fingerprint);
    this.domainFactories.add(factoryKey, typeof registered === 'function' ? registered : undefined);
  }

  private unregisterDomainFactories(extensionId?: string): void {
    this.domainFactories.unregister(extensionId);
  }

  private async assertPackageFingerprint(view: ExtensionPanelInstance): Promise<ExtensionSourcePackage> {
    const packageInfo = await this.verifier.verify({ scope: view.binding.scope, extensionId: view.identity.extensionId, ...(view.binding.controlRoot ? { controlRoot: view.binding.controlRoot } : {}) });
    const live = await this.resolveLiveBinding({ workspaceId: view.identity.workspaceId, extensionId: view.identity.extensionId, scope: view.binding.scope, ...(view.binding.controlRoot ? { controlRoot: view.binding.controlRoot } : {}), ...(view.identity.sourceRootId ? { sourceRootId: view.identity.sourceRootId } : {}), expectedFingerprint: view.identity.packageFingerprint, packageInfo });
    live.assertCurrent();
    return packageInfo;
  }
}
