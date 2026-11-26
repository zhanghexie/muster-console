import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { t } from '../../shared/i18n';

function boundedPaths(paths: string[]): string[] {
  if (paths.length > 32) throw new Error(t('一次最多发送 32 个附件'));
  return paths;
}

/** Electron exposes native clipboard formats without depending on a platform shell. */
export function clipboardFilePaths(formats: string[], read: (format: string) => Buffer): string[] {
  const drop = formats.find(f => f === 'CF_HDROP');
  if (drop) {
    const data = read(drop);
    if (data.length >= 20) {
      const offset = data.readUInt32LE(0);
      if (offset >= 20 && offset < data.length) return boundedPaths(data.subarray(offset)
        .toString(data.readUInt32LE(16) ? 'utf16le' : 'latin1').split('\0').filter(Boolean));
    }
  }
  const wide = formats.find(f => f.toLowerCase() === 'filenamew');
  if (wide) return boundedPaths(read(wide).toString('utf16le').split('\0').filter(Boolean));
  const macList = formats.find(f => f.toLowerCase() === 'nsfilenamespboardtype');
  if (macList) {
    const data = read(macList);
    if (data.subarray(0, 8).toString('ascii') === 'bplist00')
      throw new Error(t('系统文件剪贴板格式暂不支持，请拖入或选择文件'));
    const parsed = new XMLParser().parse(data.toString('utf8')) as { plist?: { array?: { string?: string | string[] } } };
    const values = parsed.plist?.array?.string;
    if (typeof values === 'string') return [values];
    if (Array.isArray(values)) return boundedPaths(values);
    throw new Error(t('系统文件剪贴板格式暂不支持，请拖入或选择文件'));
  }
  const uri = ['text/uri-list', 'x-special/gnome-copied-files', 'public.file-url']
    .map(name => formats.find(format => format.toLowerCase() === name)).find(Boolean);
  if (uri) return boundedPaths(read(uri).toString('utf8').split(/[\r\n\0]+/).map(s => s.trim())
    .filter(s => s.startsWith('file:'))).map(value => fileURLToPath(value));
  return [];
}
