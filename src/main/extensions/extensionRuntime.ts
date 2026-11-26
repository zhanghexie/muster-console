import type { ExtensionManifest } from '../../shared/extensionManifest';
import type {
  ExtensionDomainContext,
  ExtensionDomainInstanceIdentity,
  ExtensionDomainRuntime,
  ExtensionDomainSnapshot,
  ExtensionDomainActionResult,
  ExtensionDomainEvent
} from '../../shared/extensionDomain';
import { assertToolArguments } from '../capabilities/schemaValidation';
import { ExtensionDomainRegistry } from './extensionDomainRegistry';
import {
  formatExtensionAgentResourcePrompt,
  ExtensionAgentResourceManager,
  type ExtensionMcpTrust,
  type ExtensionAgentResourceMount
} from './extensionAgentResources';

export interface ExtensionRuntimeOptions {
  identity: ExtensionDomainInstanceIdentity;
  manifest: ExtensionManifest;
  packageRoot: string;
  sessionId?: string;
  sidebarTaskRef?: string;
  domains: ExtensionDomainRegistry;
  resources: ExtensionAgentResourceManager;
  mcpTrust?: ExtensionMcpTrust;
}

/**
 * Instance bridge shared by a extension human surface and its Extension Agent.
 *
 * It deliberately keeps Pi and MCP process details outside the extension
 * contract. The host opens one DomainRuntime, validates one resource mount,
 * and forwards both human and agent calls with the same instance identity.
 */
export class ExtensionRuntime {
  private readonly options: ExtensionRuntimeOptions;
  private domain: ExtensionDomainRuntime | undefined;
  private resources: ExtensionAgentResourceMount | undefined;
  private closed = false;

  constructor(options: ExtensionRuntimeOptions) {
    this.options = options;
  }

  async open(): Promise<{ domain: ExtensionDomainRuntime; resources?: ExtensionAgentResourceMount }> {
    this.assertOpen();
    const { sessionId } = this.options;
    if (sessionId && !this.resources) {
      this.resources = await this.options.resources.mount({
        packageRoot: this.options.packageRoot,
        manifest: this.options.manifest,
        sessionId,
        extensionInstanceId: this.options.identity.extensionInstanceId,
        packageFingerprint: this.options.identity.packageFingerprint,
        ...(this.options.mcpTrust ? { mcpTrust: this.options.mcpTrust } : {})
      });
    }
    if (!this.domain) {
      try {
        this.domain = await this.options.domains.open(this.options.identity, this.options.manifest);
      } catch (error) {
        if (sessionId) this.options.resources.release(sessionId);
        this.resources = undefined;
        throw error;
      }
    }
    return { domain: this.domain, resources: this.resources };
  }

  async snapshot(context: Omit<ExtensionDomainContext, 'identity'>): Promise<ExtensionDomainSnapshot> {
    await this.open();
    return this.options.domains.snapshot(this.options.identity, { ...context, identity: this.options.identity });
  }

  async query(name: string, args: unknown, context: Omit<ExtensionDomainContext, 'identity'>): Promise<unknown> {
    await this.open();
    const definition = this.operation(name, 'query');
    assertToolArguments(definition?.parameters ?? { type: 'object', additionalProperties: true }, args, `ext.${this.options.manifest.id}.query.${name}`);
    return this.options.domains.query(this.options.identity, name, args, { ...context, identity: this.options.identity });
  }

  async execute(name: string, args: unknown, context: Omit<ExtensionDomainContext, 'identity'>): Promise<ExtensionDomainActionResult> {
    await this.open();
    const definition = this.operation(name, 'command');
    const domainArgs = args && typeof args === 'object' && !Array.isArray(args)
      ? Object.fromEntries(Object.entries(args as Record<string, unknown>).filter(([key]) => key !== 'expectedVersion'))
      : args;
    assertToolArguments(definition?.parameters ?? { type: 'object', additionalProperties: true }, domainArgs, `ext.${this.options.manifest.id}.command.${name}`);
    const taskRef = context.sessionId === this.options.sessionId && this.options.manifest.permissions.includes('project.tasks')
      ? this.options.sidebarTaskRef : undefined;
    return this.options.domains.execute(this.options.identity, name, domainArgs, { ...context, taskRef, identity: this.options.identity });
  }

  subscribe(listener: (event: ExtensionDomainEvent) => void): () => void {
    this.assertOpen();
    return this.options.domains.subscribe(this.options.identity, listener);
  }

  /** Human command activity since the Agent last took it, for snapshot annotation. */
  takeHumanActivity(): { commands: Array<{ name: string; count: number }>; lastAt: number } | undefined {
    this.assertOpen();
    return this.options.domains.takeHumanActivity(this.options.identity);
  }

  agentPrompt(): string {
    this.assertOpen();
    if (!this.resources) throw new Error('extension extension resources are not mounted');
    return formatExtensionAgentResourcePrompt(this.resources);
  }

  /** The validated per-session mount consumed by host-owned MCP wiring. */
  agentResourceMount(): ExtensionAgentResourceMount {
    this.assertOpen();
    if (!this.resources) throw new Error('extension extension resources are not mounted');
    return this.resources;
  }

  async readSkill(relativePath: string, resource?: string): Promise<string> {
    this.assertOpen();
    if (!this.resources || !this.options.sessionId) throw new Error('extension extension resources are not mounted');
    return this.options.resources.readSkill(this.options.sessionId, relativePath, resource);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.options.sessionId) this.options.resources.release(this.options.sessionId);
    await this.options.domains.close(this.options.identity);
    this.domain = undefined;
    this.resources = undefined;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('extension extension runtime is closed');
  }

  private operation(name: string, kind: 'query' | 'command'): { parameters?: Record<string, unknown> } | undefined {
    const names = kind === 'query' ? this.options.manifest.domain?.queries ?? [] : this.options.manifest.domain?.commands ?? [];
    if (!names.includes(name)) throw new Error(`extension ${kind} is not declared: ${name}`);
    const definitions = kind === 'query' ? this.options.manifest.domain?.queryDefs : this.options.manifest.domain?.commandDefs;
    return definitions?.find(item => item.id === name);
  }
}
