/**
 * 文件预览能力分层（纯扩展名分类，无 Node 依赖）。
 *
 * 是 FileEditor 渲染分流的唯一依据：文本族走 CM6/md/html 既有链路；媒体族走
 * FileMediaPreview（muster-ws:// / muster-ext:// URL）；office/归档族走
 * FileDocPreview（取字节在渲染层解析）；unsupported 出「无法预览」卡片。
 * 其余未识别扩展名按 text 处理——真二进制会在读取通道被拒（ looksBinary）。
 */
import { extensionOf, mediaKindForPath } from './mediaKinds';
import { MUSTER_EXT_SCHEME } from './protocolSchemes';
export { MUSTER_EXT_SCHEME } from './protocolSchemes';

export type PreviewKind =
  | 'text'
  | 'markdown'
  | 'html'
  | 'image'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'word'
  | 'sheet'
  | 'slides'
  | 'archive'
  | 'unsupported';

const MARKDOWN_EXT = new Set(['md', 'mdx', 'markdown']);
const HTML_EXT = new Set(['html', 'htm']);

const WORD_EXT = new Set(['docx']);
const SHEET_EXT = new Set(['xlsx', 'xls', 'csv']);
const SLIDES_EXT = new Set(['pptx']);
const ARCHIVE_EXT = new Set(['zip', 'tar', 'gz', 'tgz']);

/** 已知无法在渲染层解码的格式：直接出「无法预览」卡片，不去读字节试错 */
const UNSUPPORTED_EXT = new Set([
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'dat',
  'msi',
  '7z',
  'rar',
  'dmg',
  'iso',
  'img',
  'apk',
  'jar',
  'war',
  'class',
  'wasm',
  'obj',
  'o',
  'a',
  'lib',
  'pdb',
  'doc',
  'ppt',
  'psd',
  'ai',
  'sketch',
  'ttf',
  'otf',
  'woff',
  'woff2',
  'eot',
  'db',
  'sqlite',
  'sqlite3'
]);

/** word/sheet/slides/归档：需整体读进渲染层内存解析，超限出「文件过大」而不是卡死 */
export const DOC_PREVIEW_CAP: Record<'word' | 'sheet' | 'slides' | 'archive', number> = {
  word: 64 * 1024 * 1024,
  sheet: 32 * 1024 * 1024,
  slides: 64 * 1024 * 1024,
  archive: 128 * 1024 * 1024
};

export function previewKindForPath(filePath: string): PreviewKind {
  const ext = extensionOf(filePath);
  if (!ext) return 'text';
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  if (HTML_EXT.has(ext)) return 'html';
  if (WORD_EXT.has(ext)) return 'word';
  if (SHEET_EXT.has(ext)) return 'sheet';
  if (SLIDES_EXT.has(ext)) return 'slides';
  if (ARCHIVE_EXT.has(ext)) return 'archive';
  if (UNSUPPORTED_EXT.has(ext)) return 'unsupported';
  // 媒体族复用 mediaKinds 的既有扩展名表（image/audio/video/pdf）
  const media = mediaKindForPath(filePath);
  if (media === 'image') return 'image';
  if (media === 'audio') return 'audio';
  if (media === 'video') return 'video';
  if (media === 'pdf') return 'pdf';
  return 'text';
}

/** 文本族：走 CM6 / md / html 链路（可编辑、Ctrl+F、批注解析都只对这三种开放） */
export function isTextPreviewKind(kind: PreviewKind): boolean {
  return kind === 'text' || kind === 'markdown' || kind === 'html';
}

/** 需要整体读字节解析的族（office/归档） */
export function isParsePreviewKind(
  kind: PreviewKind
): kind is 'word' | 'sheet' | 'slides' | 'archive' {
  return kind === 'word' || kind === 'sheet' || kind === 'slides' || kind === 'archive';
}

/* ---------- 链接/树用的文件类型图标分类 ---------- */

export type FileIconKind =
  | 'code'
  | 'config'
  | 'markdown'
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'word'
  | 'sheet'
  | 'slides'
  | 'archive'
  | 'font'
  | 'file';

const CODE_EXT = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte', 'astro',
  'py', 'pyw', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift', 'm', 'mm',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'php', 'pl', 'pm', 'lua', 'r',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto', 'zig', 'nim', 'dart', 'ex', 'exs', 'hs', 'erl',
  'scss', 'less', 'css', 'styl'
]);

const CONFIG_EXT = new Set([
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'xml', 'plist', 'properties', 'editorconfig', 'gitignore', 'gitattributes', 'npmrc', 'babelrc'
]);

const TEXT_EXT = new Set(['txt', 'log', 'text', 'rst', 'adoc', 'asc', 'nfo', 'srt', 'vtt', 'lrc']);

const FONT_EXT = new Set(['ttf', 'otf', 'woff', 'woff2', 'eot', 'fon']);

/** 聊天链接/工具卡的类型图标分类：比 PreviewKind 更细分出 code/config/text/font */
export function fileIconKindForPath(filePath: string): FileIconKind {
  const kind = previewKindForPath(filePath);
  if (
    kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'pdf' ||
    kind === 'word' || kind === 'sheet' || kind === 'slides' || kind === 'archive' ||
    kind === 'markdown'
  ) {
    return kind;
  }
  if (kind === 'html') return 'code';
  const ext = extensionOf(filePath);
  if (!ext) return 'file';
  if (CODE_EXT.has(ext)) return 'code';
  if (CONFIG_EXT.has(ext)) return 'config';
  if (TEXT_EXT.has(ext)) return 'text';
  if (FONT_EXT.has(ext)) return 'font';
  return 'file';
}

/* ---------- 工作区外文件的只读服务 URL（muster-ext 协议） ---------- */

/** muster-ext://f/<encodeURIComponent(绝对路径)>；f 是哑 host，避免盘符/UNC 进 hostname 被改写 */
export function buildExternalFileUrl(absPath: string): string {
  return `${MUSTER_EXT_SCHEME}://f/${encodeURIComponent(absPath.replace(/\\/g, '/'))}`;
}

export function parseExternalFileUrl(url: string): { absPath: string } | null {
  if (!url.startsWith(`${MUSTER_EXT_SCHEME}://`)) return null;
  try {
    const u = new URL(url);
    if (u.hostname !== 'f') return null;
    const abs = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (!abs) return null;
    return { absPath: abs };
  } catch {
    return null;
  }
}
