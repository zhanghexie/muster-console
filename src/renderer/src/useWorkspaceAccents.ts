import { useSyncExternalStore } from 'react';
import { subscribeWorkspaceAccents, workspaceAccentVersion } from '../../shared/workspaceAccent';

/** 订阅主题色实时预览：返回值只作依赖/触发重渲染，取色仍用 workspaceAccent(id) */
export function useWorkspaceAccentVersion(): number {
  return useSyncExternalStore(subscribeWorkspaceAccents, workspaceAccentVersion);
}
