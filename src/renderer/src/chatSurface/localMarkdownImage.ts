import { buildExternalFileUrl } from '../../../shared/filePreview';
import { resolvePathCandidate } from '../../../shared/terminalSelectionText';
import { filePreviewUrl } from '../filePreviewUrl';

/** Resolve chat image paths using the same read-only media service as file previews. */
export function localMarkdownImageUrl(src: string, cwd?: string): string | null {
  if (!src || /^(?:https?:)?\/\//i.test(src)) return null;
  if (/^(?!file:)[a-z][a-z0-9+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) return null;
  try {
    let path: string;
    if (/^file:\/\//i.test(src)) {
      const uri = new URL(src);
      path = decodeURIComponent(uri.pathname);
      if (uri.hostname && uri.hostname !== 'localhost') path = `//${uri.hostname}${path}`;
      else if (/^\/[a-z]:[\\/]/i.test(path)) path = path.slice(1);
    } else {
      path = decodeURIComponent(src);
      if (/^\/[a-z]:[\\/]/i.test(path)) path = path.slice(1);
    }
    // Do not reinterpret Unix paths as MSYS drive paths; UNC paths are already absolute.
    const absolute = path.startsWith('/') || /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\')
      ? path : resolvePathCandidate(path, cwd);
    return absolute ? filePreviewUrl(buildExternalFileUrl(absolute)) : null;
  } catch {
    return null;
  }
}
