import { localizeCliLaunchError } from '../../shared/cliLaunchError';
import { localizeGuiHostError } from '../../shared/guiHostError';
import { describePreflightFailureForUser, RuntimePreflightError } from '../../shared/runtimePreflight';
import { localizeGitUserError } from '../../shared/gitUserErrors';

/** Translate known session errors only at user IPC boundaries. */
export function localizeSessionUserError(error: unknown): never {
  if (!(error instanceof Error)) throw error;
  const message = error instanceof RuntimePreflightError ? describePreflightFailureForUser(error.preflight)
    : localizeGitUserError(localizeGuiHostError(localizeCliLaunchError(error.message)));
  if (message === error.message) throw error;
  const translated = new Error(message, { cause: error });
  const details = Object.getOwnPropertyDescriptors(error);
  for (const key of ['message', 'stack', 'cause', 'name']) Reflect.deleteProperty(details, key);
  Object.defineProperties(translated, details);
  translated.name = error.name;
  throw translated;
}

/** Preserve the handler's synchronous or Promise return contract. */
export function localizeSessionUserOperation<T>(operation: () => T): T {
  try {
    const result = operation();
    return result instanceof Promise ? result.catch(localizeSessionUserError) as T : result;
  } catch (error) { return localizeSessionUserError(error); }
}
