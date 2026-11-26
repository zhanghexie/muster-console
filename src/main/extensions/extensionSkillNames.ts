import path from 'node:path';
import type { ExtensionManifest } from '../../shared/extensionManifest';

export function extensionSkillNames(manifest: ExtensionManifest): string[] {
  return (manifest.agent?.skills ?? []).map(file => path.posix.basename(file).toLowerCase() === 'skill.md'
    ? path.posix.basename(path.posix.dirname(file)) : path.posix.basename(file, '.md'));
}
