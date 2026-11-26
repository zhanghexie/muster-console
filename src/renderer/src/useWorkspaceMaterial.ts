import { useEffect } from 'react';
import { setWorkspaceMaterialEnabled } from './theme';

/** Theme color enables the resolved material; this hook does not composite surfaces. */
export function useWorkspaceMaterial(enabled: boolean): void {
  useEffect(() => {
    setWorkspaceMaterialEnabled(enabled);
    document.documentElement.dataset.workspaceMaterial = enabled ? 'frosted' : 'solid';
    return () => {
      setWorkspaceMaterialEnabled(false);
      delete document.documentElement.dataset.workspaceMaterial;
    };
  }, [enabled]);
}
