import type { ExtensionExportService } from './extensionExportService';
import type { ExtensionHtmlThumbnail } from './extensionHtmlThumbnail';
import type { ExtensionMediaStore } from './extensionMediaStore';

export interface ExtensionMediaBridgeBrowser {
  createTab(url: string, context: { workspaceId: string; scope: 'workspace' }, options: { panelUserOpen: true }): unknown;
}

export interface ExtensionMediaBridgeContext {
  owner: string;
  token: string;
  workspaceId: string;
  args: unknown[];
  permissions: readonly string[];
  pickedFiles?: Set<string>;
  pickFiles?: () => Promise<string[]>;
  setPickedFiles(files: readonly string[]): void;
  mediaStore?: Pick<ExtensionMediaStore, 'importFile' | 'url' | 'retain' | 'release'>;
  htmlThumbnails: Pick<ExtensionHtmlThumbnail, 'html'>;
  exportService?: Pick<ExtensionExportService, 'create' | 'previewUrl' | 'reveal'>;
  browser?: ExtensionMediaBridgeBrowser;
  isViewCurrent(): boolean;
  isActiveWorkspace(): boolean;
  requirePermission(permission: 'files' | 'media' | 'exports'): void;
}

export type ExtensionMediaBridgeResult = { handled: true; value: unknown } | { handled: false };

/**
 * Coordinates the panel-owned files/media/export methods without owning the
 * host's binding or lifetime state. The caller still supplies the current
 * panel and workspace checks so async preview calls keep the host contract.
 */
export async function handleExtensionMediaBridge(method: string, context: ExtensionMediaBridgeContext): Promise<ExtensionMediaBridgeResult> {
  const args = context.args;
  if (method === 'files.pick') {
    context.requirePermission('files');
    if (!context.pickFiles) throw new Error('Extension file picker is unavailable');
    const picked = await context.pickFiles();
    context.setPickedFiles(picked);
    return { handled: true, value: picked };
  }
  if (method === 'files.pathAccess') {
    context.requirePermission('files');
    return { handled: true, value: [...(context.pickedFiles ?? new Set<string>())] };
  }
  if (method === 'media.import') {
    context.requirePermission('media');
    if (!context.mediaStore) throw new Error('Extension media store is unavailable');
    const source = String(args[0] ?? '');
    if (!context.pickedFiles?.has(source)) throw new Error('媒体文件必须先由宿主文件选择器授权');
    return { handled: true, value: await context.mediaStore.importFile(context.owner, source, args[1], args[2]) };
  }
  if (method === 'media.url') {
    context.requirePermission('media');
    if (!context.mediaStore) throw new Error('Extension media store is unavailable');
    return { handled: true, value: await context.mediaStore.url(context.owner, String(args[0] ?? '')) };
  }
  if (method === 'media.retain') {
    context.requirePermission('media');
    if (!context.mediaStore) throw new Error('Extension media store is unavailable');
    return { handled: true, value: await context.mediaStore.retain(context.owner, String(args[0] ?? '')) };
  }
  if (method === 'media.release') {
    context.requirePermission('media');
    if (!context.mediaStore) throw new Error('Extension media store is unavailable');
    await context.mediaStore.release(context.owner, args[0] === undefined ? undefined : String(args[0]));
    return { handled: true, value: true };
  }
  if (method === 'exports.thumbnailHtml') {
    context.requirePermission('exports');
    return { handled: true, value: await context.htmlThumbnails.html(context.owner, args[0]) };
  }
  if (method === 'exports.create') {
    context.requirePermission('exports');
    if (!context.exportService) throw new Error('Extension export service is unavailable');
    const input = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] as Record<string, unknown> : {};
    return { handled: true, value: await context.exportService.create(context.owner, input.files, input.title) };
  }
  if (method === 'exports.preview') {
    context.requirePermission('exports');
    if (!context.exportService || !context.browser) throw new Error('工作台预览服务不可用');
    const url = await context.exportService.previewUrl(context.owner, String(args[0] ?? ''), String(args[1] ?? ''));
    if (!context.isViewCurrent() || !context.isActiveWorkspace()) throw new Error('扩展面板已关闭或工作区已切换');
    context.browser.createTab(url, { workspaceId: context.workspaceId, scope: 'workspace' }, { panelUserOpen: true });
    return { handled: true, value: { ok: true } };
  }
  if (method === 'exports.reveal') {
    context.requirePermission('exports');
    if (!context.exportService) throw new Error('Extension export service is unavailable');
    return { handled: true, value: await context.exportService.reveal(context.owner, String(args[0] ?? '')) };
  }
  return { handled: false };
}
