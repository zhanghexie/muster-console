import { controlRootFor, defaultRootFor, requireSourceRoot, sourceRootsFor } from '../../shared/workspaceRoots';
import type { WorkspaceInfo } from '../../shared/types';
import type { ExtensionProjectBinding } from '../../shared/extension';
import { createExtensionProjectBinding } from './extensionProjectBinding';
import type { ExtensionAuthoringServices } from './extensionAuthoringServices';

/** Supplied by the authenticated tool entrypoint, never read from model arguments. */
export interface ExtensionAuthoringCaller { workspaceId: string; actor: string; sourceRootId?: string; signal?: AbortSignal }
export interface ExtensionAuthoringRequest { action: 'inspect' | 'list' | 'bindProject' | 'create' | 'write' | 'removeFile' | 'submit' | 'retryReview'; params?: Record<string, unknown> }
function text(value: unknown, label: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`); return value.trim(); }
function object(value: unknown): Record<string, unknown> { if (value === undefined) return {}; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Extension action parameters must be an object'); return value as Record<string, unknown>; }

/** Controlled authoring operations; no action writes arbitrary workspace paths. */
export class ExtensionAuthoringService {
  constructor(private host: ExtensionAuthoringServices, private workspaces: () => readonly WorkspaceInfo[]) {}
  async execute(caller: ExtensionAuthoringCaller, request: ExtensionAuthoringRequest): Promise<unknown> {
    if (!caller.workspaceId || !caller.actor || caller.actor.length > 512 || caller.actor.includes('\0')) throw new Error('Authenticated extension author identity is required');
    if (caller.signal?.aborted) throw new Error('Extension action was cancelled');
    const workspace = this.workspaces().find(item => item.id === caller.workspaceId);
    if (!workspace) throw new Error('Workspace is not registered');
    const params = object(request.params);
    if (Object.hasOwn(params, 'owner') || Object.hasOwn(params, 'actor') || (params.workspaceId !== undefined && params.workspaceId !== caller.workspaceId)) throw new Error('Extension author cannot override its caller identity');
    const requestedRoot = typeof params.sourceRootId === 'string' ? params.sourceRootId : caller.sourceRootId ?? defaultRootFor(workspace).id;
    if (caller.sourceRootId && requestedRoot !== caller.sourceRootId) throw new Error('Extension author is bound to a different project');
    const root = requireSourceRoot(workspace, requestedRoot);
    const draftInProject = (value: unknown): string => {
      const draftId = text(value, 'Draft ID');
      const draft = this.host.drafts.get(draftId, workspace.id, caller.actor);
      if (draft.sourceRootId !== root.id) throw new Error('The draft belongs to a different project');
      return draftId;
    };
    switch (request.action) {
      case 'inspect': return { workspaceId: workspace.id, workspaceName: workspace.name, controlRoot: controlRootFor(workspace), sourceRootId: root.id, sourceRoot: root.path,
        roots: sourceRootsFor(workspace).map(item => ({ id: item.id, path: item.path, label: item.label })), projectBinding: createExtensionProjectBinding(workspace, root.id), projectMappings: this.host.mappings.list().filter(item => item.workspaceId === workspace.id) };
      case 'list': return await this.host.list(workspace.id, root.id);
      case 'bindProject': {
        const key = text(params.mappingKey, 'Project mapping key');
        const expectedRootId = params.expectedRootId === undefined ? undefined : text(params.expectedRootId, 'Expected project root');
        this.host.bindProject(workspace.id, key, root.id, expectedRootId);
        return { workspaceId: workspace.id, sourceRootId: root.id, projectBinding: { kind: 'mapped', key } };
      }
      case 'create': {
        const scope = params.scope;
        if (scope !== 'global' && scope !== 'project') throw new Error('Choose global or project scope');
        let project: ExtensionProjectBinding | undefined;
        if (scope === 'project') {
          const mapping = params.mappingKey;
          if (mapping !== undefined) {
            const key = text(mapping, 'Project mapping key'); this.host.bindProject(workspace.id, key, root.id); project = { kind: 'mapped', key };
          } else {
            project = createExtensionProjectBinding(workspace, root.id) ?? undefined;
            if (!project) throw new Error('This project cannot use a portable relative binding; supply an explicit local mapping key');
          }
        } else if (params.mappingKey !== undefined) throw new Error('A global extension cannot have a project binding');
        return await this.host.createDraft({ workspaceId: workspace.id, sourceRootId: root.id, extensionId: text(params.id, 'Extension ID'), scope, project,
          ...(params.expectedFingerprint !== undefined ? { expectedFingerprint: text(params.expectedFingerprint, 'Expected fingerprint') } : {}), owner: caller.actor });
      }
      case 'write': {
        const draft = draftInProject(params.draftId), file = text(params.path, 'File path');
        if ((typeof params.text === 'string') === (typeof params.base64 === 'string')) throw new Error('Supply exactly one of text or base64');
        let contents: Buffer;
        if (typeof params.text === 'string') {
          if (Buffer.byteLength(params.text, 'utf8') > 16 * 1024 * 1024) throw new Error('Draft file exceeds the per-write limit');
          contents = Buffer.from(params.text, 'utf8');
        }
        else {
          const value = params.base64 as string;
          if (value.length > Math.ceil((16 * 1024 * 1024) / 3) * 4) throw new Error('Draft file exceeds the per-write limit');
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid base64 file content');
          contents = Buffer.from(value, 'base64');
        }
        await this.host.writeDraft(workspace.id, draft, file, contents, caller.actor);
        return { draftId: draft, path: file, bytes: contents.length };
      }
      case 'removeFile': {
        const draft = draftInProject(params.draftId), file = text(params.path, 'File path');
        this.host.removeDraftFile(workspace.id, draft, file, caller.actor); return { draftId: draft, path: file };
      }
      case 'submit': {
        if (params.retryRejected !== undefined && typeof params.retryRejected !== 'boolean') throw new Error('retryRejected must be a boolean');
        return this.host.submitDraft(workspace.id, draftInProject(params.draftId), caller.actor, caller.signal, params.retryRejected === true);
      }
      case 'retryReview': {
        const id = text(params.id, 'Extension ID');
        const scope = params.scope;
        if (scope !== undefined && scope !== 'global' && scope !== 'project') throw new Error('Invalid extension scope');
        return this.host.retryReview(workspace.id, root.id, id, caller.signal, scope);
      }
      default: throw new Error('Unknown extension action');
    }
  }
}



