/** Repository-local variables reported by `git rev-parse --local-env-vars`, plus namespace. */
const LOCAL_GIT_ENV = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX', 'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_INTERNAL_SUPER_PREFIX'
]);

/** Invocation-only Windows support; never changes repository or user configuration. */
export function gitCommandArgs(args: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? ['-c', 'core.longpaths=true', ...args] : [...args];
}

/** A hook/parent process cannot redirect an explicit-cwd host command to another checkout/index. */
export function gitCommandEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => {
    const name = key.toUpperCase();
    return !LOCAL_GIT_ENV.has(name) && !/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name);
  }));
}
