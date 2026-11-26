import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { GIT_SCOPED_METHODS, type GitOperationScope, type GitScopedOperations } from '../../../../shared/gitOperations';

export function createScopedGit(scope: GitOperationScope, isCurrent: () => boolean = () => true): GitScopedOperations {
  const owner = { ...scope };
  return new Proxy({} as GitScopedOperations, {
    get: (_target, method: keyof GitScopedOperations) => {
      if (!(GIT_SCOPED_METHODS as readonly string[]).includes(method)) return undefined;
      return async (...args: Parameters<GitScopedOperations[typeof method]>) => {
        if (!isCurrent()) throw new Error('Git panel scope changed');
        const result = await window.api.git.invokeScoped(owner, method, ...args);
        if (!isCurrent()) throw new Error('Git panel scope changed');
        return result;
      };
    }
  });
}

const GitWorkspaceContext = createContext<{ git: GitScopedOperations; scope: GitOperationScope } | null>(null);

export function GitWorkspaceProvider({ scope, children }: { scope: GitOperationScope; children: React.ReactNode }): React.JSX.Element {
  const key = JSON.stringify([scope.workspaceId, scope.rootsRevision]);
  const generation = useRef({ key });
  if (generation.current.key !== key) generation.current = { key };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const api = useMemo(() => {
    const token = generation.current;
    return { git: createScopedGit(scope, () => mounted.current && generation.current === token), scope };
  }, [scope.workspaceId, scope.rootsRevision]);
  return <GitWorkspaceContext.Provider value={api}>{children}</GitWorkspaceContext.Provider>;
}

export function useScopedGit(): GitScopedOperations {
  return useGitWorkspace().git;
}

export function useGitWorkspaceScope(): GitOperationScope {
  return useGitWorkspace().scope;
}

function useGitWorkspace() {
  const api = useContext(GitWorkspaceContext);
  if (!api) throw new Error('Git workspace scope is missing');
  return api;
}
