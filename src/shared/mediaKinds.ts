/** 文件面板媒体 / 预览分流（纯扩展名，无 Node 依赖） */
import type { WorkspaceFileRef } from './types';
import { MUSTER_ROOT_SCHEME, MUSTER_WS_SCHEME } from './protocolSchemes';
export { MUSTER_ROOT_SCHEME, MUSTER_WS_SCHEME } from './protocolSchemes';

export type MediaKind = 'image' | 'audio' | 'video' | 'pdf';

const IMAGE_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'ico',
  'avif'
]);

const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba']);

const VIDEO_EXT = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv']);

const PDF_EXT = new Set(['pdf']);

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/opus',
  weba: 'audio/webm',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  pdf: 'application/pdf',
  // Office / 归档（预览层经 URL 取字节解析，mime 供协议服务标注）
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv; charset=utf-8',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  // 扩展面板 / HTML 预览相关（面板经 muster-ws:// 加载本地页面与资产）
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2'
};

export function extensionOf(filePath: string): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function mediaKindForPath(filePath: string): MediaKind | null {
  const ext = extensionOf(filePath);
  if (!ext) return null;
  if (IMAGE_EXT.has(ext)) return 'image';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (PDF_EXT.has(ext)) return 'pdf';
  return null;
}

export function mimeForPath(filePath: string): string {
  const ext = extensionOf(filePath);
  return MIME[ext] ?? 'application/octet-stream';
}

/** 工作区媒体协议：旧单根 ID authority，以及 v2 查询参数中的 workspaceId/rootId。 */
/** HTML 资源用独立 scheme，身份在 authority 中，普通相对 URL 不会丢根。 */

export function buildWorkspaceResourceUrl(ref: WorkspaceFileRef): string {
  const encoded = encodeURIComponent(JSON.stringify([ref.workspaceId, ref.rootId]));
  const identity = encoded.replace(/%([0-9A-F]{2})|([^%])/g, (_match, hex: string | undefined, char: string) =>
    hex ?? char.charCodeAt(0).toString(16).padStart(2, '0')).toLowerCase();
  const parts = ref.relativePath.replace(/\\/g, '/').split('/').filter(Boolean).map(encodeURIComponent);
  return `${MUSTER_ROOT_SCHEME}://r${identity}/${parts.join('/')}`;
}

export function buildWorkspaceMediaUrl(workspaceId: string, relativePath: string, rootId?: string): string {
  const id = workspaceId.trim();
  const parts = relativePath
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((p) => encodeURIComponent(p));
  if (rootId !== undefined) {
    const query = new URLSearchParams({ v: '2', workspaceId: id, rootId });
    return `${MUSTER_WS_SCHEME}://workspace/${parts.join('/')}?${query}`;
  }
  return `${MUSTER_WS_SCHEME}://${id}/${parts.join('/')}`;
}

export function buildWorkspaceFileUrl(ref: WorkspaceFileRef): string {
  return buildWorkspaceMediaUrl(ref.workspaceId, ref.relativePath, ref.rootId);
}

export function parseWorkspaceMediaUrl(url: string): { workspaceId: string; rootId?: string; relativePath: string } {
  const u = new URL(url);
  if (u.protocol === `${MUSTER_ROOT_SCHEME}:`) {
    if (!/^r(?:[0-9a-f]{2})+$/.test(u.hostname) || u.hostname.length > 8193 || u.username || u.password || u.port) throw new Error('invalid source resource identity');
    const value: unknown = JSON.parse(decodeURIComponent(u.hostname.slice(1).replace(/../g, hex => `%${hex}`)));
    if (!Array.isArray(value) || value.length !== 2 || value.some(id => typeof id !== 'string' || !id.trim())) throw new Error('invalid source resource identity');
    const relativePath = u.pathname.replace(/^\//, '').split('/').filter(Boolean).map(decodeURIComponent).join('/');
    return { workspaceId: value[0], rootId: value[1], relativePath };
  }
  if (u.protocol.replace(/:$/, '') !== MUSTER_WS_SCHEME) {
    throw new Error('unsupported scheme');
  }
  const versioned = u.searchParams.has('v') || u.searchParams.has('rootId') || u.searchParams.has('workspaceId');
  if (versioned && u.searchParams.get('v') !== '2') throw new Error('unsupported workspace media version');
  const workspaceId = versioned ? u.searchParams.get('workspaceId') ?? '' : decodeURIComponent(u.hostname);
  if (!workspaceId) throw new Error('missing workspaceId');
  const rootId = versioned ? u.searchParams.get('rootId') ?? '' : undefined;
  if (versioned && !rootId) throw new Error('missing rootId');
  const relativePath = u.pathname
    .replace(/^\//, '')
    .split('/')
    .filter(Boolean)
    .map((p) => decodeURIComponent(p))
    .join('/');
  return { workspaceId, relativePath, ...(rootId !== undefined ? { rootId } : {}) };
}
