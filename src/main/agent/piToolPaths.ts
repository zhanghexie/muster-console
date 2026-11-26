import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Matches the installed Pi path-utils normalization; checked against actual native tools. */
export function resolvePiToolPath(toolName: string, input: string, cwd: string): string {
  const normalize = (value: string, toolInput: boolean): string => {
    let valueNow = toolInput ? value.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ').replace(/^@/, '') : value;
    if (process.platform === 'win32' && valueNow.startsWith('/') && !valueNow.startsWith('//') && !valueNow.includes('\\')) {
      const shell = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(valueNow);
      if (shell) valueNow = `${shell[1].toUpperCase()}:\\${shell[2]?.replaceAll('/', '\\') ?? ''}`;
    }
    if (valueNow === '~') return os.homedir();
    if (valueNow.startsWith('~/') || (process.platform === 'win32' && valueNow.startsWith('~\\'))) return path.join(os.homedir(), valueNow.slice(2));
    if (/^file:\/\//.test(valueNow)) return fileURLToPath(valueNow);
    return valueNow;
  };
  const normalized = normalize(input, true);
  const absolute = path.resolve(normalize(cwd, false), normalized);
  if (toolName.toLowerCase() !== 'read') return absolute;
  const candidates = [absolute, absolute.replace(/ (AM|PM)\./gi, '\u202F$1.'), absolute.normalize('NFD'),
    absolute.replace(/'/g, '\u2019'), absolute.normalize('NFD').replace(/'/g, '\u2019')];
  return candidates.find(candidate => { try { fs.accessSync(candidate); return true; } catch { return false; } }) ?? absolute;
}
