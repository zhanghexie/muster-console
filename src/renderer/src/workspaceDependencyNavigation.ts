import type { WorkspaceFileRef, WorkspaceInfo, WorkspaceRootDependency } from '../../shared/types';
import { sourceRootsFor } from '../../shared/workspaceRoots';
import { pathKey } from '../../shared/pathKey';
import { t } from '../../shared/i18n';
import { jumpToSession } from './sessionJump';

interface Input {
  workspace: WorkspaceInfo;
  dependency: WorkspaceRootDependency;
  activeWorkspaceId: string | null;
  getWorkspace: (id: string) => WorkspaceInfo | undefined;
  isCurrent: () => boolean;
  switchWorkspace: (id: string) => Promise<{ ok: boolean; message?: string }>;
  openFile: (args: { path: string; fileRef: WorkspaceFileRef }) => void;
}

/** Viewing a blocker never closes a task, releases another client's view or removes a folder. */
export async function openWorkspaceDependency(input: Input): Promise<void> {
  const { workspace, dependency } = input;
  const original = sourceRootsFor(workspace).find(root => root.id === dependency.rootId);
  const assertCurrent = (): void => {
    const current = input.getWorkspace(workspace.id);
    const root = current && sourceRootsFor(current).find(item => item.id === dependency.rootId);
    if (!input.isCurrent() || !original || !root || pathKey(root.path) !== pathKey(original.path)) {
      throw new Error(t('依赖对象已变更，请重新打开设置并检查'));
    }
  };
  assertCurrent();
  let sessionId: string | undefined;
  if (dependency.sessionId || dependency.serviceId) {
    const { sessions } = await window.api.sessions.list();
    assertCurrent();
    const session = sessions.find(item => dependency.serviceId
      ? item.type === 'scheduled' && item.serviceId === dependency.serviceId
      : item.id === dependency.sessionId);
    if (!session || session.hidden || session.workspaceId !== workspace.id ||
      (session.sourceRoot && session.sourceRoot.rootId !== dependency.rootId)) {
      throw new Error(t('依赖对象已变更，请重新打开设置并检查'));
    }
    sessionId = session.id;
  } else if (dependency.kind !== 'open-file' || dependency.relativePath === undefined) {
    throw new Error(t('操作仍在进行，请稍后重试保存'));
  }
  if (input.activeWorkspaceId !== workspace.id) {
    const result = await input.switchWorkspace(workspace.id);
    if (!result.ok) throw new Error(result.message || t('切换失败'));
    assertCurrent();
  }
  assertCurrent();
  if (sessionId) {
    await jumpToSession({ sessionId });
  } else {
    input.openFile({ path: dependency.relativePath!, fileRef: {
      workspaceId: workspace.id, rootId: dependency.rootId, relativePath: dependency.relativePath!
    } });
  }
}
