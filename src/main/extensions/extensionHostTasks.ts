import type { ExtensionTaskSource } from '../../shared/boardTodo';
import type { ExtensionManifest } from '../../shared/extensionManifest';
import type { ExtensionDomainInstanceIdentity } from '../../shared/extensionDomain';
import { extensionSidebarTaskRef } from './extensionSidebarTaskRef';
import { extensionSkillNames } from './extensionSkillNames';
import { withWorkspaceFileTarget } from '../workspaceFileAccess';
import { resolveFileRefLexical, resolveRealPathInsideRoot, sourcePathKey } from '../workspacePaths';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context';
import type { ExtensionPackageCatalog, ExtensionInstanceBinding } from './extensionPackageCatalog';
import type { ExtensionDevelopmentTrustStore, ExtensionDevelopmentTrustSubject } from './extensionDevelopmentTrust';
import type { ExtensionHtmlThumbnail } from './extensionHtmlThumbnail';
import type { ExtensionExportService } from './extensionExportService';

export interface ExtensionTaskBridgeView {
  identity: ExtensionDomainInstanceIdentity;
  binding: ExtensionInstanceBinding;
  manifest: ExtensionManifest;
  sessionId?: string;
  developmentTrust: { subject: ExtensionDevelopmentTrustSubject };
}

export interface ExtensionTaskBridgeContext {
  token: string;
  owner: string;
  method: string;
  args: unknown[];
  view: ExtensionTaskBridgeView;
  signal: AbortSignal;
  appContext?: AppContext;
  catalog: ExtensionPackageCatalog;
  developmentTrust?: ExtensionDevelopmentTrustStore;
  htmlThumbnails: Pick<ExtensionHtmlThumbnail, 'file'>;
  exportService?: Pick<ExtensionExportService, 'projectPreviewUrl'>;
  isViewCurrent(): boolean;
  assertCurrent(): void;
  requirePermission(permission: 'project.tasks'): void;
}

export type ExtensionTaskBridgeResult = { handled: true; value: unknown } | { handled: false };

function assertTaskCurrent(context: ExtensionTaskBridgeContext): void {
  if (context.signal.aborted) throw context.signal.reason instanceof Error ? context.signal.reason : new Error('Extension task request cancelled');
  context.assertCurrent();
}

/**
 * Coordinates the project task panel methods. Host-owned identity, permission,
 * lifetime and workspace checks are supplied by the context so this module
 * does not acquire a second source of truth for panel state.
 */
export async function handleExtensionTaskBridge(context: ExtensionTaskBridgeContext): Promise<ExtensionTaskBridgeResult> {
  const { method, args, view } = context;
  if (!method.startsWith('tasks.')) return { handled: false };
  context.requirePermission('project.tasks');
  const ctx = context.appContext;
  const management = ctx?.extensionSystem?.management;
  const win = ctx?.getWindow();
  const workspaceId = view.identity.workspaceId;
  if (!ctx || !management || !win || win.isDestroyed() || ctx.config.get().activeWorkspaceId !== workspaceId) throw new Error('请先打开扩展所属工作区');
  assertTaskCurrent(context);
  if (!context.catalog.get(view.binding.scope, view.manifest.id, view.binding.controlRoot)?.enabled ||
      (context.developmentTrust && !context.developmentTrust.canRun(view.developmentTrust.subject))) throw new Error('扩展已停用或需要重新信任');
  const rootId = view.identity.sourceRootId ?? management.rootId(workspaceId);
  if (method === 'tasks.create') {
    const [title, draft] = args;
    if (typeof title !== 'string' || !title.trim() || title.length > 120 || typeof draft !== 'string' || !draft.trim() || draft.length > 64000) throw new Error('任务标题或草稿无效');
    const source: ExtensionTaskSource = {
      extensionId: view.manifest.id, workspaceId, rootId, scope: view.binding.scope, fingerprint: view.identity.packageFingerprint,
      surfaceId: view.identity.surfaceId, sourceRootId: view.identity.sourceRootId,
      skillNames: extensionSkillNames(view.manifest)
    };
    assertTaskCurrent(context);
    win.webContents.send('extensionSurface:newTask', { title: title.trim(), draft, projectPath: management.rootPath(workspaceId, rootId), source });
    if (!win.isFocused()) win.focus();
    return { handled: true, value: { opened: true } };
  }
  const target = args[0];
  if (typeof target !== 'string' || !target) throw new Error('原项目任务不可用');
  const durable = target.startsWith('sidebar:');
  const sessionId = durable ? view.sessionId : target;
  const task = sessionId ? ctx.sessions.get(sessionId) : undefined;
  if (durable && extensionSidebarTaskRef(task, view.identity, view.binding.scope) !== target) throw new Error('请打开作品所属的项目和扩展面板');
  if (!task && !durable) throw new Error('TASK_SESSION_MISSING：原项目任务不可用');
  if (!task || task.archived || task.workspaceId !== workspaceId || !task.sourceRoot) throw new Error('原项目任务不可用');
  const taskRootId = task.sourceRoot.rootId;
  const registeredPath = sourcePathKey(management.rootPath(workspaceId, taskRootId));
  if ((view.binding.scope === 'project' && taskRootId !== rootId) ||
      (task.sourceRoot.physicalPath ?? sourcePathKey(task.sourceRoot.path)) !== registeredPath) throw new Error('原项目任务不可用');
  const sameSidebar = task.hidden && task.meta?.extensionAgent === 'true' &&
    task.meta.extensionId === view.manifest.id && task.meta.extensionInstanceId === view.identity.extensionInstanceId;
  const sidebar = sameSidebar && task.id === view.sessionId;
  const savedSidebarWork = sameSidebar && taskRootId === rootId && (method === 'tasks.preview' || method === 'tasks.thumbnail') &&
    (task.meta?.extensionScope === view.binding.scope || (!task.meta?.extensionScope && view.binding.scope === 'global' &&
      !context.catalog.get('project', view.manifest.id, registeredPath)));
  const projectTask = task.meta?.extensionTask === view.manifest.id && task.meta.extensionScope === view.binding.scope;
  if (!sidebar && !savedSidebarWork && !projectTask) throw new Error('原项目任务不可用');
  assertTaskCurrent(context);
  if (method === 'tasks.open') {
    if (sidebar) return { handled: true, value: { sessionId: task.id, sidebar: true } };
    await ctx.sessions.select(task.id);
    assertTaskCurrent(context);
    return { handled: true, value: { sessionId: task.id } };
  }
  if (method === 'tasks.preview' || method === 'tasks.thumbnail') {
    const relativePath = args[1];
    if (typeof relativePath !== 'string' || !relativePath) throw new Error('作品路径无效');
    const file = await withWorkspaceFileTarget(() => ctx.config.get(), { workspaceId, rootId: taskRootId, relativePath: '' }, '', async root => {
      const sourceFile = resolveFileRefLexical(ctx.config.get(), { workspaceId, rootId: taskRootId, relativePath });
      const directory = task.worktreePath || task.worktreeGroups ? task.cwd : root;
      if (!directory || !path.isAbsolute(directory)) throw new Error('作品所在的任务目录不可用');
      const absolute = await resolveRealPathInsideRoot(directory, path.relative(root, sourceFile));
      if (!(await fs.promises.stat(absolute)).isFile()) throw new Error('作品文件不存在');
      return absolute;
    });
    assertTaskCurrent(context);
    if (method === 'tasks.thumbnail') return { handled: true, value: await context.htmlThumbnails.file(context.owner, file) };
    if (/\.html?$/i.test(file)) {
      if (!context.exportService || !ctx.browser) throw new Error('工作台预览服务不可用');
      const url = await context.exportService.projectPreviewUrl(file);
      assertTaskCurrent(context);
      if (!context.isViewCurrent() || ctx.config.get().activeWorkspaceId !== workspaceId) throw new Error('扩展面板已关闭或工作区已切换');
      const tabId = ctx.browser.createTab(url, { workspaceId, scope: 'workspace' }, { panelUserOpen: true });
      return { handled: true, value: { ok: true, tabId } };
    }
    assertTaskCurrent(context);
    win.webContents.send('extensionSurface:previewExport', { workspaceId, path: file });
    return { handled: true, value: { ok: true } };
  }
  return { handled: false };
}
