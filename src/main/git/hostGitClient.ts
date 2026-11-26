import { simpleGit, type SimpleGit } from 'simple-git';
import { isGuardedEnvKey, parseArgv } from '@simple-git/argv-parser';
import { gitCommandEnvironment } from './gitEnvironment';

/** Only host-inherited, sanitized environment is admitted here; never request-supplied env. */
export function createHostGitClient(baseDir: string, environment: NodeJS.ProcessEnv, blockTimeoutMs = 10000): SimpleGit {
  environment = gitCommandEnvironment(environment);
  // Preserve only the guarded keys actually present in the sanitized host environment.
  const allowEnvironment = Object.keys(environment).filter(isGuardedEnvKey);
  const git = simpleGit({ baseDir, binary: 'git', trimmed: true, timeout: { block: blockTimeoutMs }, allowEnvironment,
    config: process.platform === 'win32' ? ['core.longpaths=true'] : [] }).env(environment);
  return new Proxy(git, {
    get(target, property) {
      const member = Reflect.get(target, property);
      if (typeof member !== 'function') return member;
      if (property === 'env' || property === 'customBinary') {
        return () => { throw new Error('Host Git environment and binary cannot be supplied by a request'); };
      }
      return (...args: unknown[]) => {
        // Service calls use raw for explicit options and addConfig for config writes.
        const tokens = property === 'raw' ? args.flat().filter(value => typeof value !== 'function')
          : property === 'addConfig' ? ['config', args[0], args[1]]
            : args.some(Array.isArray) ? [String(property), ...args.flat()] : undefined;
        if (tokens) {
          const blocked = parseArgv(...tokens).vulnerabilities[0];
          if (blocked) throw new Error(blocked.message);
        }
        return member.apply(target, args);
      };
    }
  });
}
