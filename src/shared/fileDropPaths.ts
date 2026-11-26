/** 终端粘贴用：无空白且无双引号则原样，否则双引号包裹；内部 `"` 写成 `\"`。不转义反斜杠。 */
export function quoteShellPath(absPath: string): string {
  if (!/[\s"]/.test(absPath)) return absPath;
  return `"${absPath.replace(/"/g, '\\"')}"`;
}

export function formatTerminalDropText(paths: string[]): string {
  if (paths.length === 0) return '';
  return paths.map(quoteShellPath).join(' ');
}

/** Agent 输入：各路径前加 `@`，空格分隔，末尾一空格。 */
export function formatAgentDropText(paths: string[]): string {
  if (paths.length === 0) return '';
  return paths.map((p) => `@${p}`).join(' ') + ' ';
}

/**
 * 从 File 列表取绝对路径；getPath 抛错或返回空串则跳过。
 */
export function pathsFromFiles(
  files: ArrayLike<File>,
  getPath: (file: File) => string
): string[] {
  const out: string[] = [];
  for (const file of Array.from(files as ArrayLike<File>)) {
    try {
      const p = getPath(file).trim();
      if (p) out.push(p);
    } catch {
      // skip
    }
  }
  return out;
}

export function dataTransferHasFiles(
  dt: { types: ArrayLike<string> } | null | undefined
): boolean {
  if (!dt) return false;
  return Array.from(dt.types as ArrayLike<string>).includes('Files');
}

/**
 * 有 Files 时返回 null（调用方应走路径插入）。
 * 否则取 text/plain 或 Text，trim 后空则 null。
 */
export function readPlainTextFromDataTransfer(
  dt:
    | { types: ArrayLike<string>; getData: (format: string) => string }
    | null
    | undefined
): string | null {
  if (!dt || dataTransferHasFiles(dt)) return null;
  const types = Array.from(dt.types as ArrayLike<string>);
  const format = types.includes('text/plain')
    ? 'text/plain'
    : types.includes('Text')
      ? 'Text'
      : null;
  if (!format) return null;
  let raw = '';
  try {
    raw = dt.getData(format) ?? '';
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

/** 文件树拖出路径时使用的自定义 MIME（drop 时可读） */
export const MUSTER_PATHS_MIME = 'application/x-muster-paths';

export function looksLikeAbsPath(text: string): boolean {
  const s = text.trim();
  if (!s || /\n|\r/.test(s)) return false;
  // Windows: C:\... 或 \\server\share；POSIX: /...
  return /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('/');
}

/** dragover / drop 用到的最小 DataTransfer 形状（避免 shared 依赖 DOM lib） */
export type PathDataTransfer = {
  types: ArrayLike<string>;
  getData: (format: string) => string;
  setData?: (format: string, data: string) => void;
  files?: ArrayLike<File> | null;
  effectAllowed?: string;
};

/** dragover 时是否可接受（Files / 自定义路径 / 纯文本路径） */
export function dataTransferHasPaths(dt: PathDataTransfer | null | undefined): boolean {
  if (!dt) return false;
  const types = Array.from(dt.types as ArrayLike<string>);
  return (
    types.includes('Files') ||
    types.includes(MUSTER_PATHS_MIME) ||
    types.includes('text/plain')
  );
}

/**
 * 从 DataTransfer 收集绝对路径：优先自定义 MIME，其次 OS Files，再次 text/plain。
 */
export function pathsFromDataTransfer(
  dt: PathDataTransfer,
  getPath: (file: File) => string
): string[] {
  const custom = dt.getData(MUSTER_PATHS_MIME)?.trim();
  if (custom) {
    try {
      const parsed = JSON.parse(custom) as unknown;
      if (Array.isArray(parsed)) {
        const paths = parsed.map((x) => String(x ?? '').trim()).filter(Boolean);
        if (paths.length > 0) return paths;
      }
    } catch {
      // fall through
    }
  }

  if (dt.files?.length) {
    const fromFiles = pathsFromFiles(dt.files, getPath);
    if (fromFiles.length > 0) return fromFiles;
  }

  const text = dt.getData('text/plain')?.trim();
  if (text && looksLikeAbsPath(text)) return [text];

  return [];
}

/**
 * Agent 输入框投放：有路径（自定义 MIME / Files / 绝对路径文本）则 `@path `，
 * 否则插入 text/plain 原文（保留缩进，空串则跳过）。
 */
export function agentInsertFromDataTransfer(
  dt: PathDataTransfer,
  getPath: (file: File) => string
): string {
  const paths = pathsFromDataTransfer(dt, getPath);
  if (paths.length > 0) return formatAgentDropText(paths);
  const text = dt.getData('text/plain') ?? '';
  return text.trim() ? text : '';
}

/** 文件树 dragstart：写入路径 MIME */
export function setPathDragData(dt: PathDataTransfer, absPaths: string[]): void {
  const paths = absPaths.map((p) => p.trim()).filter(Boolean);
  if (paths.length === 0) return;
  if (dt.effectAllowed !== undefined) dt.effectAllowed = 'copy';
  dt.setData?.(MUSTER_PATHS_MIME, JSON.stringify(paths));
  dt.setData?.('text/plain', paths.length === 1 ? paths[0]! : paths.join('\n'));
}
