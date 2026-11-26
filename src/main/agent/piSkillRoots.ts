import path from 'node:path';

export function isPiSkillTarget(target: string): boolean {
  return target === 'pi-gui' || target === 'pi-dispatcher';
}

/** Logical entrypoints; directory/skill symlinks remain supported. No ancestor search. */
export function piSkillRootPaths(home: string, projects: readonly string[], paths = path): string[] {
  return [...new Set([home, ...projects].map(root => paths.join(root, '.agents', 'skills')))];
}
